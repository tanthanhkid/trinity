import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { OrgFeaturesService } from '../settings/org-features.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DEFAULT_STALE_CONFIG, normalizeStaleConfig, vietnamClock, type StaleWorkConfig } from './stale-work.config';
import { addStats, describeStats, emptyStats, scanStale, totalOf, type OwnerStats } from './stale-work.scan';

const CONFIG_KEY = 'stale_work_config';
const LAST_DIGEST_KEY = 'stale_work_last_digest';
const SCAN_CACHE_MS = 60_000;

export interface Digest {
  recipient_id: number;
  own: OwnerStats;
  /** Việc của cấp dưới (cây `manager_id`), KHÔNG gồm của chính người nhận. */
  team: OwnerStats;
}

export interface RunResult {
  sent: number;
  skipped?: string;
}

@Injectable()
export class StaleWorkService {
  private readonly logger = new Logger(StaleWorkService.name);
  private scanCache: { at: number; value: Map<number, OwnerStats> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly notifications: NotificationsService,
    private readonly orgFeatures: OrgFeaturesService,
  ) {}

  async getConfig(): Promise<StaleWorkConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: CONFIG_KEY }, select: { value: true } });
    try {
      return row?.value ? normalizeStaleConfig(JSON.parse(row.value)) : { ...DEFAULT_STALE_CONFIG };
    } catch {
      return { ...DEFAULT_STALE_CONFIG };
    }
  }

  async saveConfig(raw: unknown, userId: number): Promise<StaleWorkConfig> {
    const cfg = normalizeStaleConfig(raw);
    const value = JSON.stringify(cfg);
    await this.prisma.setting.upsert({ where: { key: CONFIG_KEY }, update: { value, updated_by: userId }, create: { key: CONFIG_KEY, value, updated_by: userId } });
    this.scanCache = null;
    return cfg;
  }

  private async stats(now: Date, fresh = false): Promise<Map<number, OwnerStats>> {
    if (!fresh && this.scanCache && now.getTime() - this.scanCache.at < SCAN_CACHE_MS) return this.scanCache.value;
    const value = await scanStale(this.prisma, await this.getConfig(), now);
    this.scanCache = { at: now.getTime(), value };
    return value;
  }

  /** Cây cấp dưới của `managerId` (gồm chính họ) — TÁI DÙNG ScopeService.subtree (đệ quy `users.manager_id`, có cache). */
  private subtreeOf(managerId: number): Promise<number[] | 'all' | null> {
    const asSubtree: AuthUser = { userId: managerId, email: '', isAdmin: false, grants: { 'contacts.view': 'subtree' } };
    return this.scope.ownerIds(asSubtree, 'contacts.view');
  }

  private async teamStats(managerId: number, stats: Map<number, OwnerStats>): Promise<OwnerStats> {
    const ids = await this.subtreeOf(managerId);
    let sum = emptyStats();
    for (const id of Array.isArray(ids) ? ids : []) if (id !== managerId) sum = addStats(sum, stats.get(id) ?? emptyStats());
    return sum;
  }

  /** Người nhận = chủ việc + mọi cấp trên trực tiếp/gián tiếp của họ (chỉ user còn hoạt động). */
  async buildDigests(now: Date, fresh = false): Promise<Digest[]> {
    const stats = await this.stats(now, fresh);
    if (stats.size === 0) return [];
    const users = await this.prisma.user.findMany({ where: { status: 'active', deleted_at: null }, select: { id: true, manager_id: true } });
    const parent = new Map(users.map((u) => [u.id, u.manager_id]));
    const recipients = new Set<number>();
    for (const owner of stats.keys()) {
      if (!parent.has(owner)) continue;
      recipients.add(owner);
      const seen = new Set<number>([owner]);
      for (let m = parent.get(owner) ?? null; m !== null && !seen.has(m); m = parent.get(m) ?? null) {
        seen.add(m);
        if (parent.has(m)) recipients.add(m);
      }
    }
    const out: Digest[] = [];
    for (const r of recipients) {
      const own = stats.get(r) ?? emptyStats();
      const team = await this.teamStats(r, stats);
      if (totalOf(own) + totalOf(team) > 0) out.push({ recipient_id: r, own, team });
    }
    return out;
  }

  /** Thống kê cho 1 người dùng đang đăng nhập: việc của mình + của cấp dưới (sale không có cấp dưới → chỉ của mình). */
  async summaryFor(user: AuthUser, now: Date = new Date()) {
    const [stats, config] = await Promise.all([this.stats(now), this.getConfig()]);
    return { own: stats.get(user.userId) ?? emptyStats(), team: await this.teamStats(user.userId, stats), config };
  }

  async sendDigests(now: Date, fresh = false): Promise<number> {
    return (await this.sendDigestsDetailed(now, fresh)).sent;
  }

  private async sendDigestsDetailed(now: Date, fresh = false): Promise<{ sent: number; failed: number }> {
    const cfg = await this.getConfig();
    const digests = await this.buildDigests(now, fresh);
    let sent = 0;
    let failed = 0;
    for (const d of digests) {
      const lines = [totalOf(d.own) ? `Của bạn: ${describeStats(d.own, cfg)}.` : '', totalOf(d.team) ? `Nhóm của bạn: ${describeStats(d.team, cfg)}.` : ''].filter(Boolean);
      const url = d.own.overdue_tasks + d.team.overdue_tasks > 0 && d.own.silent_contacts + d.team.silent_contacts === 0 ? '/kanban' : '/contacts';
      try {
        await this.notifications.createPendingLogs([d.recipient_id], 'stale_work.digest', { title: 'Việc đang treo cần xử lý', body: lines.join(' '), action_url: url });
        sent += 1;
      } catch (err) {
        failed += 1;
        this.logger.error(`Gửi nhắc việc treo cho user ${d.recipient_id} lỗi: ${(err as Error)?.message}`);
      }
    }
    return { sent, failed };
  }

  /** Job: đúng/quá giờ gửi sáng và hôm nay chưa gửi → gửi tổng hợp. `force` bỏ qua giờ + dấu "đã gửi hôm nay". */
  async runOnce(now: Date = new Date(), force = false): Promise<RunResult> {
    if (!(await this.orgFeatures.isEnabled('stale_reminders'))) return { sent: 0, skipped: 'org-flag-off' };
    const { hour, date } = vietnamClock(now);
    if (!force) {
      if (hour < (await this.getConfig()).digest_hour) return { sent: 0, skipped: 'chua-den-gio' };
      const last = await this.prisma.setting.findUnique({ where: { key: LAST_DIGEST_KEY }, select: { value: true } });
      if (last?.value === date) return { sent: 0, skipped: 'da-gui-hom-nay' };
    }
    const { sent, failed } = await this.sendDigestsDetailed(now, true);
    // Còn lần gửi lỗi thì KHÔNG đánh dấu "đã gửi hôm nay" để lần chạy sau thử lại (người đã nhận sẽ nhận trùng nên chỉ thử lại khi có lỗi).
    if (failed === 0) {
      await this.prisma.setting.upsert({ where: { key: LAST_DIGEST_KEY }, update: { value: date }, create: { key: LAST_DIGEST_KEY, value: date } });
    }
    this.logger.log(`Tổng hợp việc treo ${date}: gửi ${sent} người`);
    return { sent };
  }
}
