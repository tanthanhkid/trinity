import { Injectable } from '@nestjs/common';
import { PrismaService, tenantKey } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import type { Scope } from '@trinity/rbac';
import { scopeOf } from '@trinity/rbac';
import { ScopeService } from '@trinity/rbac-nest';
// ScopeService PHẢI import THẬT (không type-only) — constructor DI của NestJS
// cần class reference runtime cho `emitDecoratorMetadata`; import type ở đây
// làm Nest resolve param type ra `Object` và ném lỗi không inject được.
import type { AuthUser } from '@trinity/rbac-nest';
import { ReadCache } from '../common/read-cache';

export const CACHE_TTL_SEC = 15; // 15 giây — gần realtime cho dashboard Tổng quan
/**
 * Bump khi đổi shape DashboardStatsTodayResult để tự bỏ cache cũ.
 * Mỗi khối kiểm quyền NGUỒN riêng
 * (`contacts.view`); khối thiếu quyền trả `null` (KHÔNG `0` —
 * FE phân biệt "không có dữ liệu" với "không được xem"). `scope_label` suy
 * từ scope của `reports.overview`, KHÔNG còn theo tên vai trò.
 */
const CACHE_VERSION = 'v22';

export interface DashboardStatsTodayResult {
  /**
   * QUAN TÂM — số contacts được khởi tạo HÔM NAY trong phạm vi của user.
   * `null` = không có quyền `contacts.view`.
   */
  interest_total: number | null;
  interest_yesterday: number | null;
  team_size: number | null;
  scope_label: string;
}

/** Khoảng thời gian VN [start, end) — start inclusive, end exclusive. */
interface VnDayRange {
  start: Date;
  end: Date;
}

const SCOPE_LABEL: Record<Scope, string> = {
  own: 'Của mình',
  team: 'Nhóm',
  subtree: 'Toàn bộ cấp dưới',
  all: 'Toàn công ty',
};

@Injectable()
export class DashboardStatsTodayService {

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly cache: ReadCache,
  ) {}

  /**
   * Trả range [start, end) của 1 ngày VN (Asia/Ho_Chi_Minh = UTC+7).
   * - `daysAgo=0` → hôm nay: [00:00 today, 00:00 tomorrow).
   * - `daysAgo=1` → hôm qua: [00:00 yesterday, 00:00 today).
   */
  private getVnDayRange(daysAgo = 0): VnDayRange {
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

  async getStats(user: AuthUser): Promise<DashboardStatsTodayResult> {
    const [contactsOwner, overviewOwner] = await Promise.all([
      this.scope.ownerIds(user, 'contacts.view'),
      this.scope.ownerIds(user, 'reports.overview'),
    ]);
    const reportsScope = scopeOf(user.grants, 'reports.overview');

    const cacheKey = this.buildCacheKey(user, contactsOwner);
    const cached = await this.getCached(cacheKey);
    if (cached) return cached;

    const result = await this.fetchStats(contactsOwner, reportsScope, overviewOwner);
    await this.setCached(cacheKey, result);
    return result;
  }

  /**
   * Cache key per-user + scope. Dùng FULL sorted owner ids (không truncate) để
   * tránh collision khi subtree đổi thứ tự thành viên.
   */
  private buildCacheKey(
    user: AuthUser,
    contactsOwner: number[] | 'all' | null,
  ): string {
    const part = (o: number[] | 'all' | null) =>
      o === null ? 'none' : o === 'all' ? 'all' : [...o].sort((a, b) => a - b).join('-');
    return `dashboard:${CACHE_VERSION}:today:${user.userId}:k${part(contactsOwner)}`;
  }

  private async getCached(key: string): Promise<DashboardStatsTodayResult | null> {
    const raw = this.cache.get(tenantKey(key));
    return raw ? (JSON.parse(raw) as DashboardStatsTodayResult) : null;
  }

  private async setCached(key: string, data: DashboardStatsTodayResult): Promise<void> {
    this.cache.set(tenantKey(key), JSON.stringify(data), CACHE_TTL_SEC);
  }

  /**
   * QUAN TÂM = số contacts được tạo trong range [start, end) trong phạm vi
   * `contacts.view`. Owner của contact = `assigned_to` HOẶC `created_by_id`
   * ĐỒNG NHẤT cho mọi vai trò.
   */
  private async fetchInterest(owner: number[] | 'all', range: VnDayRange): Promise<number> {
    const dateFilter = { gte: range.start, lt: range.end };
    const where: Prisma.ContactWhereInput =
      owner === 'all'
        ? { created_at: dateFilter, deleted_at: null }
        : {
            OR: [{ assigned_to: { in: owner } }, { created_by_id: { in: owner } }],
            created_at: dateFilter,
            deleted_at: null,
          };
    return this.prisma.contact.count({ where });
  }

  private async fetchStats(
    contactsOwner: number[] | 'all' | null,
    reportsScope: Scope | null,
    overviewOwner: number[] | 'all' | null,
  ): Promise<DashboardStatsTodayResult> {
    const today = this.getVnDayRange(0);
    const yesterday = this.getVnDayRange(1);

    const [todayInterest, yesterdayInterest] =
      contactsOwner !== null
        ? await Promise.all([
            this.fetchInterest(contactsOwner, today),
            this.fetchInterest(contactsOwner, yesterday),
          ])
        : [null, null];

    return {
      interest_total: todayInterest,
      interest_yesterday: yesterdayInterest,
      team_size: this.resolveTeamSize(reportsScope, overviewOwner),
      scope_label: reportsScope ? SCOPE_LABEL[reportsScope] : SCOPE_LABEL.all,
    };
  }

  /**
   * Số nhân viên trong scope để tính TB/người. Trả null → FE không hiển thị
   * TB — chỉ có ý nghĩa ở scope `team`/`subtree`.
   */
  private resolveTeamSize(scope: Scope | null, owner: number[] | 'all' | null): number | null {
    if (scope !== 'team' && scope !== 'subtree') return null;
    if (owner === null || owner === 'all') return null;
    return owner.length;
  }
}
