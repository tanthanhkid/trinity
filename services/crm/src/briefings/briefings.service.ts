import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@trinity/prisma';
import { PermissionService, ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { findUserIdsWithPermission } from '../common/helpers/permission-roster.helper';
import { BriefingAggregatorService } from './briefing-aggregator.service';
import { BRIEFING_CHANNELS, type BriefingChannel, type BriefingRecipient } from './briefing-channel';
import { BriefingConfigService } from './briefing-config.service';
import { collectBriefingDetails, type BriefingDetails } from './briefing-details';
import { buildBriefingContent } from './briefing-text';
import { isSlotDue, vnDayKey } from './briefing-time';
import type { BriefingConfig, BriefingContent, BriefingData, BriefingSlot } from './briefing.types';

const PERMISSION = 'reports.overview' as const;
const MAX_RECIPIENTS = 500;

interface Group {
  data: BriefingData;
  content: BriefingContent;
}

export interface RunResult {
  slot: BriefingSlot;
  recipients: number;
  created: number;
  skipped: number;
  channels: Record<string, number>;
}

/** Dữ liệu bản tin cho agent của khách (MCP `get_briefing_data`): số liệu + danh sách chi tiết + bản mẫu để tham khảo. */
export interface AgentBriefingData {
  data: BriefingData;
  details: BriefingDetails;
  template: BriefingContent;
}

/**
 * Bản tin sáng/chiều. Máy chủ Trinity KHÔNG gọi AI (không dùng khoá API AI phía máy chủ):
 * - Theo lịch: dựng bản tin MẪU từ số liệu (không AI) và gửi trong app.
 * - Agent của khách (ChatGPT/Claude/Gemini… qua MCP) đọc `agentData` rồi tự viết bản tin, lưu bằng `saveFromAgent`.
 */
@Injectable()
export class BriefingsService {
  private readonly logger = new Logger(BriefingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
    private readonly aggregator: BriefingAggregatorService,
    private readonly config: BriefingConfigService,
    @Inject(BRIEFING_CHANNELS) private readonly channels: BriefingChannel[],
  ) {}

  /** Gọi mỗi phút (tiến trình dài) hoặc mỗi lượt cron tick (serverless): gửi slot nào đã đến giờ mà chưa gửi hôm nay. */
  async runDue(now = new Date()): Promise<RunResult[] | { skipped: string }> {
    const cfg = await this.config.get();
    if (!cfg.enabled) return { skipped: 'config-off' };
    if (!(await this.config.featureOn())) return { skipped: 'feature-off' };
    const out: RunResult[] = [];
    const slots: [BriefingSlot, boolean, string][] = [
      ['morning', cfg.morning_enabled, cfg.morning_time],
      ['evening', cfg.evening_enabled, cfg.evening_time],
    ];
    for (const [slot, on, time] of slots) {
      if (on && isSlotDue(time, now)) out.push(await this.runSlot(slot, cfg, now));
    }
    return out;
  }

  /** Dựng + gửi một slot cho mọi người giữ `reports.overview`. Idempotent: unique (user, slot, ngày) chặn gửi trùng. */
  async runSlot(slot: BriefingSlot, cfg?: BriefingConfig, now = new Date()): Promise<RunResult> {
    const config = cfg ?? (await this.config.get());
    const day = vnDayKey(now);
    const ids = (await findUserIdsWithPermission(this.prisma, PERMISSION)).slice(0, MAX_RECIPIENTS);
    const done = await this.prisma.briefing.findMany({ where: { slot, day, user_id: { in: ids } }, select: { user_id: true } });
    const doneIds = new Set(done.map((d) => d.user_id));
    const todo = ids.filter((id) => !doneIds.has(id));
    const result: RunResult = { slot, recipients: todo.length, created: 0, skipped: doneIds.size, channels: {} };
    if (todo.length === 0) return result;

    const users = await this.prisma.user.findMany({
      where: { id: { in: todo }, status: 'active', deleted_at: null },
      select: { id: true, email: true, full_name: true },
    });
    const groups = new Map<string, Group>();
    for (const u of users) {
      const owner = await this.ownerFor(u.id, u.email);
      if (owner === null) continue;
      const key = owner === 'all' ? 'all' : [...owner].sort((a, b) => a - b).join(',');
      let g = groups.get(key);
      if (!g) {
        const data = await this.aggregator.collect(owner, slot, now);
        groups.set(key, (g = { data, content: buildBriefingContent(data) }));
      }
      await this.deliver(g, slot, day, { id: u.id, email: u.email, name: u.full_name }, config, result);
    }
    this.logger.log(`Bản tin ${slot}: ${result.created}/${result.recipients} người, kênh ${JSON.stringify(result.channels)}`);
    return result;
  }

  /** Số liệu + nội dung mẫu cho CHÍNH người gọi (xem thử), không lưu, không gửi. */
  async previewFor(user: AuthUser, slot: BriefingSlot, now = new Date()) {
    const owner = await this.scope.ownerIds(user, PERMISSION);
    if (owner === null) return null;
    const data = await this.aggregator.collect(owner, slot, now);
    return { data, content: buildBriefingContent(data) };
  }

  /** Cờ tính năng `ai_briefing` (công tắc tổ chức + gói). */
  featureOn(): Promise<boolean> {
    return this.config.featureOn();
  }

  /** Dữ liệu cho agent viết bản tin — cùng phạm vi quyền `reports.overview` của người dùng đã kết nối. null = không có quyền. */
  async agentData(user: AuthUser, slot: BriefingSlot, now = new Date()): Promise<AgentBriefingData | null> {
    const owner = await this.scope.ownerIds(user, PERMISSION);
    if (owner === null) return null;
    const [data, details] = await Promise.all([
      this.aggregator.collect(owner, slot, now),
      collectBriefingDetails(this.prisma, owner, slot, now),
    ]);
    return { data, details, template: buildBriefingContent(data) };
  }

  /**
   * Lưu bản tin do agent của khách viết — CHỈ cho chính người dùng đã kết nối (không ghi hộ người khác). Đã có bản tin
   * cùng (slot, ngày) thì thay nội dung; chưa báo trong app thì báo. Không đụng dữ liệu nghiệp vụ (khách, deal, việc).
   */
  async saveFromAgent(user: AuthUser, slot: BriefingSlot, title: string, text: string, now = new Date()): Promise<{ id: number; created: boolean; notified: boolean }> {
    const owner = await this.scope.ownerIds(user, PERMISSION);
    if (owner === null) throw new Error('Không có quyền xem báo cáo Tổng quan (reports.overview)');
    const day = vnDayKey(now);
    const existing = await this.prisma.briefing.findUnique({ where: { user_id_slot_day: { user_id: user.userId, slot, day } }, select: { id: true, channels: true } });
    let id: number;
    if (existing) {
      id = (await this.prisma.briefing.update({ where: { id: existing.id }, data: { title, text }, select: { id: true } })).id;
    } else {
      const data = await this.aggregator.collect(owner, slot, now);
      id = (await this.prisma.briefing.create({ data: { user_id: user.userId, slot, day, title, text, data: data as unknown as Prisma.InputJsonValue }, select: { id: true } })).id;
    }
    const sent = Array.isArray(existing?.channels) ? (existing.channels as string[]) : [];
    const notified = await this.notifyMissing(id, slot, { id: user.userId, email: user.email, name: '' }, { title, text }, sent);
    return { id, created: !existing, notified };
  }

  private async notifyMissing(id: number, slot: BriefingSlot, to: BriefingRecipient, content: BriefingContent, sent: string[]): Promise<boolean> {
    const cfg = await this.config.get();
    const now: string[] = [];
    for (const ch of this.channels) {
      if (sent.includes(ch.name) || !(await ch.isEnabled(cfg))) continue;
      if (await ch.send({ briefingId: id, slot, recipient: to, content }).catch(() => false)) now.push(ch.name);
    }
    if (now.length > 0) await this.prisma.briefing.update({ where: { id }, data: { channels: [...sent, ...now] } });
    return now.length > 0;
  }

  private async ownerFor(userId: number, email: string): Promise<number[] | 'all' | null> {
    const { grants, isAdmin } = await this.permissions.grantsFor(userId);
    return this.scope.ownerIds({ userId, email, isAdmin, grants }, PERMISSION);
  }

  private async deliver(g: Group, slot: BriefingSlot, day: string, to: BriefingRecipient, cfg: BriefingConfig, result: RunResult): Promise<void> {
    let row: { id: number };
    try {
      row = await this.prisma.briefing.create({
        data: { user_id: to.id, slot, day, title: g.content.title, text: g.content.text, data: g.data as unknown as Prisma.InputJsonValue },
        select: { id: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return void result.skipped++;
      throw err;
    }
    result.created++;
    const sent: string[] = [];
    for (const ch of this.channels) {
      if (!(await ch.isEnabled(cfg))) continue;
      const ok = await ch.send({ briefingId: row.id, slot, recipient: to, content: g.content }).catch(() => false);
      if (ok) {
        sent.push(ch.name);
        result.channels[ch.name] = (result.channels[ch.name] ?? 0) + 1;
      }
    }
    await this.prisma.briefing.update({ where: { id: row.id }, data: { channels: sent } });
  }
}
