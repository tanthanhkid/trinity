import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { ScopeService } from '@trinity/rbac-nest';
// ScopeService PHẢI import THẬT (không type-only) — constructor DI của NestJS
// cần class reference runtime cho `emitDecoratorMetadata`; import type ở đây
// làm Nest resolve param type ra `Object` và ném lỗi không inject được.
import type { AuthUser } from '@trinity/rbac-nest';
import { REDIS_CLIENT } from '../common/redis.provider';

/**
 * Đường xu hướng 14 ngày cho thẻ chỉ số màn Tổng quan.
 *
 * ## RBAC (quyền + phạm vi)
 *
 * Chuỗi kiểm quyền NGUỒN riêng — `interest` cần `contacts.view`.
 * Chuỗi thiếu quyền VẮNG MẶT khỏi `series` (key không tồn tại — KHÔNG phải
 * mảng toàn số 0), mirror cách `dashboard-stats-today.service.ts` trả `null`
 * cho khối thiếu quyền — cùng nguồn `ScopeService` nên 2 endpoint cùng vẽ
 * trên 1 màn không lệch vị từ.
 */

/** Số ngày của đường xu hướng — khớp `NGAY[]` (14 mốc) của bản thiết kế. */
export const TREND_DAYS = 14;

/** Mốc [start, end) của 1 ngày theo giờ VN, lùi `daysAgo` ngày. */
function getVnDayRange(daysAgo = 0): { start: Date; end: Date } {
  const now = new Date();
  const vnToday = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const startOfDayUtc = new Date(vnToday);
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  // Quay về UTC start-of-day VN
  const startOfDay = new Date(startOfDayUtc.getTime() - 7 * 60 * 60 * 1000);
  const start = new Date(startOfDay.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** TTL cache: đường 14 ngày đổi chậm hơn thẻ số (15s) rất nhiều. */
const TREND_CACHE_TTL_SEC = 120;

/**
 * Bump khi đổi shape `DashboardTrendResult` để tự orphan cache Redis cũ.
 * v4 — `series` nay là `Partial<...>` (khối thiếu quyền vắng mặt).
 */
const TREND_CACHE_VERSION = 'v5';

/** Khoá chuỗi — khớp 1-1 với `KpiCard` của FE. */
export type TrendMetric = 'interest';

export interface DashboardTrendResult {
  /** 14 ngày theo giờ VN, CŨ → MỚI, dạng `YYYY-MM-DD`. Điểm cuối = hôm nay. */
  days: string[];
  /** Chỉ có key mà actor đủ quyền nguồn xem; mỗi chuỗi dài đúng `days.length`. */
  series: Partial<Record<TrendMetric, number[]>>;
}

interface DayCountRow {
  day: Date;
  cnt: bigint;
}

@Injectable()
export class DashboardTrendService {
  private readonly logger = new Logger(DashboardTrendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async getTrend(user: AuthUser): Promise<DashboardTrendResult> {
    const contactsOwner = await this.scope.ownerIds(user, 'contacts.view');
    const cacheKey = this.buildCacheKey(user, contactsOwner);
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const result = await this.fetchTrend(contactsOwner);
    await this.writeCache(cacheKey, result);
    return result;
  }

  /**
   * Cửa sổ [start ngày thứ 13 trước, end hôm nay) — dùng `getVnDayRange` để
   * mốc trùng KHÍT với thẻ "hôm nay"/"hôm qua" của `dashboard-stats-today`.
   */
  private windowRange(): { start: Date; end: Date; days: string[] } {
    const oldest = getVnDayRange(TREND_DAYS - 1);
    const today = getVnDayRange(0);
    const days: string[] = [];
    for (let i = TREND_DAYS - 1; i >= 0; i -= 1) {
      days.push(this.vnDayKey(getVnDayRange(i).start));
    }
    return { start: oldest.start, end: today.end, days };
  }

  /** `Date` (mốc UTC = 00:00 giờ VN) → khoá `YYYY-MM-DD` theo lịch VN. */
  private vnDayKey(d: Date): string {
    return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  private async fetchTrend(
    contactsOwner: number[] | 'all' | null,
  ): Promise<DashboardTrendResult> {
    const { start, end, days } = this.windowRange();
    const idx = new Map(days.map((d, i) => [d, i]));
    const zero = () => new Array<number>(TREND_DAYS).fill(0);
    const series: Partial<Record<TrendMetric, number[]>> = {};

    if (contactsOwner !== null) {
      series.interest = zero();
      if (contactsOwner === 'all' || contactsOwner.length > 0) {
        const rows = await this.fetchInterestDays(contactsOwner, start, end);
        for (const r of rows) {
          const i = idx.get(this.vnDayKey(r.day));
          if (i !== undefined) series.interest![i] = Number(r.cnt);
        }
      }
    }

    return { days, series };
  }

  /**
   * QUAN TÂM = contacts tạo trong ngày, owner = `assigned_to` HOẶC
   * `created_by_id` — ĐỒNG NHẤT mọi vai trò trong phạm vi
   * `contacts.view`.
   */
  private async fetchInterestDays(
    owner: number[] | 'all',
    start: Date,
    end: Date,
  ): Promise<DayCountRow[]> {
    const scopeSql =
      owner === 'all'
        ? Prisma.empty
        : Prisma.sql`AND (ct.assigned_to IN (${Prisma.join(owner)}) OR ct.created_by_id IN (${Prisma.join(owner)}))`;
    return this.prisma.$queryRaw`
      SELECT (ct.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day,
             COUNT(*)::bigint AS cnt
      FROM contacts ct
      WHERE ct.created_at >= ${start} AND ct.created_at < ${end}
        AND ct.deleted_at IS NULL
      ${scopeSql}
      GROUP BY 1
    `;
  }

  private buildCacheKey(
    user: AuthUser,
    contactsOwner: number[] | 'all' | null,
  ): string {
    // SẮP XẾP trước khi nối: cùng một subtree nhưng loader trả khác thứ tự sẽ
    // thành 2 khoá khác nhau ⇒ cache miss vô ích.
    const part = (o: number[] | 'all' | null) =>
      o === null ? 'none' : o === 'all' ? 'all' : [...o].sort((a, b) => a - b).join('-');
    // Chuỗi KHÔNG phụ thuộc danh tính người gọi (`all`/`none`) → bỏ
    // `userId` khỏi khoá để mọi người ở scope đó dùng chung 1 lần quét 14 ngày.
    const identityIndependent = contactsOwner === 'all' || contactsOwner === null;
    const who = identityIndependent ? 'shared' : String(user.userId);
    return `dashboard:trend14:${TREND_CACHE_VERSION}:${who}:k${part(contactsOwner)}`;
  }

  private async readCache(key: string): Promise<DashboardTrendResult | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as DashboardTrendResult) : null;
    } catch (e) {
      this.logger.warn(`Redis đọc lỗi (bỏ cache, vẫn trả số thật): ${String(e)}`);
      return null;
    }
  }

  private async writeCache(key: string, value: DashboardTrendResult): Promise<void> {
    try {
      await this.redis.setex(key, TREND_CACHE_TTL_SEC, JSON.stringify(value));
    } catch (e) {
      this.logger.warn(`Redis ghi lỗi (bỏ qua): ${String(e)}`);
    }
  }
}
