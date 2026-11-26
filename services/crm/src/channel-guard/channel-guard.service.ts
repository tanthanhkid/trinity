import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService, companyRef, currentCompany, currentCompanyId, getChannelLock, isMultiTenant, runWithCompany, syncBus } from '@trinity/prisma';
import { channelLimitsFor, type ChannelLimits, type PlanKey } from '@trinity/rbac';
import { planFromSetting } from '@trinity/rbac-nest';
import { ChannelBlockedError } from './channel-guard.errors';
import { GRAPH_POLICY_CODE, isGraphAppLevelLimit, isGraphBlockOutcome, setGraphObserver, type GraphOutcome } from './graph-observer';

/** Client chạy SQL thô: `PrismaService` hoặc client của một transaction (giữ chỗ hạn mức cùng transaction với việc tạo). */
export interface RawDb {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}

/** Việc đếm hạn mức. */
export type QuotaKind = 'bulk_message' | 'post' | 'comment_reply';
/** `manual`: nhân viên tự gõ/bấm (chỉ chịu khoá kênh). `auto`: gửi hàng loạt / tự động (chịu cả tạm dừng tự động). */
export type OutboundMode = 'manual' | 'auto';

const PLAN_SETTING_KEY = 'org_plan';
const VN_OFFSET_MS = 7 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface GraphGuardConfig {
  windowMs: number;
  /** Ít nhất chừng này lời gọi trong cửa sổ mới xét tỉ lệ. */
  minCalls: number;
  /** Ít nhất chừng này lỗi chặn mới tạm dừng. */
  minBlocks: number;
  /** Tỉ lệ lỗi chặn / tổng lời gọi vượt mức này ⇒ tạm dừng. */
  maxBlockRate: number;
  /** Số lần gặp #368 (vi phạm chính sách) trong cửa sổ ⇒ tạm dừng ngay. */
  policyBlocks: number;
  pauseMs: number;
  /** Lùi gửi tự động toàn app khi Facebook báo giới hạn cấp app. */
  appBackoffMs: number;
  /** Cần ít nhất chừng này lần bị giới hạn cấp app trong `appHitWindowMs` mới lùi toàn app (một lần lẻ không đủ). */
  appBackoffHits: number;
  appHitWindowMs: number;
}

export function graphGuardConfig(env: NodeJS.ProcessEnv = process.env): GraphGuardConfig {
  const num = (k: string, d: number, min = 1): number => {
    const n = Number(env[k]);
    return Number.isFinite(n) && n >= min ? n : d;
  };
  return {
    windowMs: num('CHANNEL_GUARD_WINDOW_MIN', 60) * 60_000,
    minCalls: num('CHANNEL_GUARD_MIN_CALLS', 20),
    minBlocks: num('CHANNEL_GUARD_MIN_BLOCKS', 10),
    maxBlockRate: Math.min(num('CHANNEL_GUARD_MAX_BLOCK_RATE', 0.3, 0.01), 1),
    policyBlocks: num('CHANNEL_GUARD_POLICY_BLOCKS', 2),
    pauseMs: num('CHANNEL_GUARD_PAUSE_HOURS', 6) * HOUR_MS,
    appBackoffMs: num('CHANNEL_GUARD_APP_BACKOFF_MIN', 5) * 60_000,
    appBackoffHits: num('CHANNEL_GUARD_APP_BACKOFF_HITS', 3),
    appHitWindowMs: 60_000,
  };
}

export interface GraphWindowEvent {
  t: number;
  block: boolean;
  code: number | null;
}

export interface GraphVerdict {
  trip: boolean;
  reason: string;
  calls: number;
  blocks: number;
  codes: Record<string, number>;
}

/** Thuần: cửa sổ lời gọi Graph → có nên tạm dừng không. */
export function evaluateGraphWindow(events: readonly GraphWindowEvent[], now: number, cfg: GraphGuardConfig): GraphVerdict {
  const inWin = events.filter((e) => now - e.t <= cfg.windowMs);
  const blocked = inWin.filter((e) => e.block);
  const codes: Record<string, number> = {};
  for (const e of blocked) codes[String(e.code ?? 'http')] = (codes[String(e.code ?? 'http')] ?? 0) + 1;
  const base = { calls: inWin.length, blocks: blocked.length, codes };
  const policy = blocked.filter((e) => e.code === GRAPH_POLICY_CODE).length;
  if (policy >= cfg.policyBlocks) return { ...base, trip: true, reason: `Facebook báo vi phạm chính sách/spam (#${GRAPH_POLICY_CODE}) ${policy} lần trong ${Math.round(cfg.windowMs / 60_000)} phút` };
  if (inWin.length >= cfg.minCalls && blocked.length >= cfg.minBlocks && blocked.length / inWin.length >= cfg.maxBlockRate) {
    return { ...base, trip: true, reason: `${blocked.length}/${inWin.length} lời gọi Facebook bị chặn hoặc giới hạn trong ${Math.round(cfg.windowMs / 60_000)} phút` };
  }
  return { ...base, trip: false, reason: '' };
}

/** Đầu khung giờ (UTC) / đầu ngày theo giờ Việt Nam chứa `now`. */
export function hourBucket(now: number): Date {
  return new Date(Math.floor(now / HOUR_MS) * HOUR_MS);
}
export function dayBucket(now: number): Date {
  return new Date(Math.floor((now + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS);
}

const QUOTA: Record<QuotaKind, { limit: keyof ChannelLimits; bucket: (now: number) => Date; per: string; what: string }> = {
  bulk_message: { limit: 'bulkMessagesPerDay', bucket: dayBucket, per: 'ngày', what: 'tin gửi hàng loạt' },
  post: { limit: 'postsPerDay', bucket: dayBucket, per: 'ngày', what: 'bài đăng/hẹn giờ' },
  comment_reply: { limit: 'autoCommentRepliesPerHour', bucket: hourBucket, per: 'giờ', what: 'lần trả lời bình luận tự động' },
};

/** `meta` = Facebook (chịu tạm dừng do Graph); `other` = Zalo (chỉ chịu khoá kênh). */
export type OutboundScope = 'meta' | 'other';

export interface BlockReason {
  code: 'channel_locked' | 'channel_paused';
  message: string;
  /** Tạm dừng: tới lúc này mới gửi lại được (lượt chờ hẹn lại, không huỷ). */
  until?: Date;
}

/** Cảnh báo nhẹ cho MỌI người dùng đã đăng nhập (banner). Không lộ hạn mức hay sự kiện. */
export interface ChannelAlerts {
  enforced: boolean;
  locked: boolean;
  paused: boolean;
  warnings: string[];
}

/** Kết quả `prepareReserve`: hạn mức + khung đã đọc sẵn, dùng trong transaction. */
export interface ReserveContext {
  kind: QuotaKind;
  limit: number;
  bucket: Date;
}

export interface AutoPause {
  until: string;
  reason: string;
  since: string;
}

export interface ChannelGuardStatus {
  /** false = bản cài một công ty: không có hạn mức/khoá/tạm dừng. */
  enforced: boolean;
  plan: PlanKey;
  limits: ChannelLimits;
  usage: { bulk_messages_today: number; posts_today: number; auto_comment_replies_this_hour: number };
  locked: { locked: boolean; reason: string | null; since: string | null };
  auto_pause: AutoPause | null;
  warnings: string[];
  recent_events: Array<{ id: number; kind: string; message: string; at: string }>;
}

interface EventRow {
  id: number;
  kind: string;
  message: string;
  meta: unknown;
  created_at: Date;
}

/**
 * Chống lạm dụng kênh theo công ty (SaaS đa công ty dùng chung MỘT app Meta/Zalo). Bốn lớp:
 *  1. Khoá kênh của chủ nền tảng (`platform.companies.channels_locked`): chặn mọi gửi ra ngoài, nhận tin vẫn chạy.
 *  2. Hạn mức theo gói (`PLANS[..].channelLimits`), đếm nguyên tử ở bảng `channel_usage` của công ty.
 *  3. Theo dõi tỉ lệ lỗi chặn của Graph API; vượt ngưỡng ⇒ tự tạm dừng gửi hàng loạt/tự động + ghi sự kiện.
 *  4. Sự kiện (`channel_events`) để hiện cảnh báo trong app và đọc qua MCP.
 * Bản cài một công ty (`MULTI_TENANT` tắt): mọi hàm là no-op — không phá người tự cài.
 */
@Injectable()
export class ChannelGuardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelGuardService.name);
  private readonly cfg = graphGuardConfig();
  /** Cửa sổ lời gọi Graph theo công ty (bộ nhớ từng tiến trình, mỗi tiến trình cộng cả kết quả của tiến trình khác qua `NOTIFY graph`; trạng thái tạm dừng thì nằm ở DB nên mọi tiến trình cùng thấy). */
  private readonly windows = new Map<number, GraphWindowEvent[]>();
  private readonly pauseCache = new Map<number, { v: AutoPause | null; at: number }>();
  private readonly planCache = new Map<number, { v: PlanKey; at: number }>();
  private readonly loggedBuckets = new Set<string>();
  /** Backoff cấp app (giới hạn tần suất dùng chung): trước mốc này, gửi tự động của MỌI công ty lùi lại. Mỗi tiến trình tự cộng (cả kết quả nhận qua `NOTIFY graph`). */
  private appBackoffUntil = 0;
  private appHits: number[] = [];

  constructor(private readonly prisma: PrismaService) {}

  private unsubscribeSync: (() => void) | null = null;

  onModuleInit(): void {
    setGraphObserver((o) => this.recordGraph(o));
    // G12b: kết quả gọi Graph ra của tiến trình khác (Node thứ hai, Rust) cũng vào cửa sổ lỗi và backoff của tiến trình này.
    this.unsubscribeSync = syncBus.on('graph', (m) => {
      const o: GraphOutcome = {
        ok: m['ok'] === true,
        httpStatus: Number(m['h'] ?? 0),
        code: typeof m['code'] === 'number' ? m['code'] : null,
        subcode: typeof m['sub'] === 'number' ? m['sub'] : null,
        send: m['send'] !== false,
      };
      if (m.c > 0) runWithCompany(companyRef(m.c), () => this.applyGraph(o));
      else this.applyGraph(o);
    });
  }

  onModuleDestroy(): void {
    setGraphObserver(null);
    this.unsubscribeSync?.();
    this.unsubscribeSync = null;
  }

  /** Có áp hạn mức/khoá không (chỉ khi chạy nhiều công ty). */
  enforced(): boolean {
    return isMultiTenant();
  }

  // ───────────────────────── hạn mức & chặn

  /** Gói của công ty hiện tại (cache 30 giây). Vắng/rác: công ty ≥ 2 = gói đăng ký mặc định, còn lại `custom`. */
  async plan(): Promise<PlanKey> {
    const id = currentCompanyId() ?? 0;
    const hit = this.planCache.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.v;
    let v: PlanKey = planFromSetting(undefined);
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: PLAN_SETTING_KEY }, select: { value: true } });
      // Cùng một cách giải gói với giới hạn người dùng: thiếu dòng ở công ty ≥ 2 = gói đăng ký mặc định, không rơi về `custom`.
      v = planFromSetting(row?.value);
    } catch (err) {
      this.logger.warn(`Không đọc được gói để tính hạn mức kênh: ${(err as Error).message}`);
    }
    this.planCache.set(id, { v, at: Date.now() });
    return v;
  }

  async limits(): Promise<ChannelLimits> {
    return channelLimitsFor(await this.plan());
  }

  /** Lý do đang chặn gửi (null = được gửi). `auto` xét thêm tạm dừng tự động. */
  async blockReason(mode: OutboundMode, scope: OutboundScope = 'meta'): Promise<BlockReason | null> {
    if (!this.enforced()) return null;
    const id = currentCompanyId();
    if (!id) return null;
    const lock = await getChannelLock(id);
    if (lock.locked) {
      return { code: 'channel_locked', message: `Kênh gửi tin/đăng bài của công ty đang bị tạm khoá${lock.reason ? ` (${lock.reason})` : ''}. Nhận tin vẫn chạy bình thường; liên hệ Trinity để mở lại.` };
    }
    // Tạm dừng do lỗi Graph / backoff của Meta chỉ áp cho Facebook; Zalo không bị chặn theo.
    if (mode === 'auto' && scope === 'meta') {
      if (Date.now() < this.appBackoffUntil) {
        return { code: 'channel_paused', until: new Date(this.appBackoffUntil), message: `Facebook đang giới hạn tần suất chung nên gửi hàng loạt và tự động tạm lùi đến ${formatVn(new Date(this.appBackoffUntil).toISOString())}. Thử lại sau vài phút; tin nhân viên tự trả lời vẫn gửi được.` };
      }
      const p = await this.autoPause();
      if (p) {
        return { code: 'channel_paused', until: new Date(p.until), message: `Gửi hàng loạt và tự động đang tạm dừng đến ${formatVn(p.until)} vì Facebook báo lỗi chặn/spam (${p.reason}). Tin nhân viên tự trả lời vẫn gửi được.` };
      }
    }
    return null;
  }

  /** Ném `ChannelBlockedError` nếu đang bị khoá (hoặc tạm dừng, với `auto`). */
  async assertOutbound(mode: OutboundMode, scope: OutboundScope = 'meta'): Promise<void> {
    const r = await this.blockReason(mode, scope);
    if (r) throw new ChannelBlockedError(r.code, r.message);
  }

  /**
   * Chuẩn bị giữ chỗ: kiểm khoá/tạm dừng + đọc hạn mức của gói. Gọi TRƯỚC khi mở transaction rồi truyền `ctx` vào `reserve`,
   * để bên trong transaction chỉ còn đúng một câu SQL trên chính kết nối của transaction (không kéo thêm kết nối từ pool).
   * Trả null khi không áp hạn mức (bản cài một công ty).
   */
  async prepareReserve(kind: QuotaKind, scope: OutboundScope = 'meta'): Promise<ReserveContext | null> {
    if (!this.enforced()) return null;
    await this.assertOutbound(kind === 'post' ? 'manual' : 'auto', scope);
    return { kind, limit: (await this.limits())[QUOTA[kind].limit], bucket: QUOTA[kind].bucket(Date.now()) };
  }

  /**
   * Giữ chỗ `amount` đơn vị hạn mức một cách nguyên tử rồi mới gửi; trả khung (bucket) đã ghi để `refund` hoàn đúng khung đó.
   * Vượt ⇒ `ChannelBlockedError` (429). `post` chỉ chịu khoá kênh (tạm dừng xử lý lúc đăng); hai loại còn lại chịu cả tạm dừng.
   * Có `ctx` (đã `prepareReserve`) ⇒ không truy vấn nào ngoài `db`; sự kiện `limit_exceeded` KHÔNG ghi ngay mà nằm trong lỗi,
   * người gọi ghi bằng `recordBlocked(err)` SAU transaction. Không `ctx` ⇒ tự chuẩn bị và tự ghi.
   */
  async reserve(kind: QuotaKind, amount = 1, db: RawDb = this.prisma, scope: OutboundScope = 'meta', ctx?: ReserveContext | null): Promise<Date | null> {
    if (!this.enforced() || amount <= 0) return null;
    const c = ctx ?? (await this.prepareReserve(kind, scope));
    if (!c) return null;
    const q = QUOTA[kind];
    const { limit, bucket } = c;
    if (amount > limit) {
      // Một lần xin vượt cả hạn mức của khoảng: không phải "đã dùng hết", nên nói rõ trần một lần và không ghi limit_exceeded.
      throw new ChannelBlockedError('channel_quota', `Một lần chỉ được ${q.what} tối đa ${limit} (${q.per === 'giờ' ? 'mỗi giờ' : 'mỗi ngày'}) theo gói hiện tại, bạn đang xin ${amount}. Chia nhỏ hoặc nâng gói.`);
    }
    const rows = await db.$queryRawUnsafe<Array<{ count: number }>>(
      `INSERT INTO channel_usage (kind, bucket, count) VALUES ($1, $2::timestamptz, $3)
       ON CONFLICT (kind, bucket) DO UPDATE SET count = channel_usage.count + EXCLUDED.count
         WHERE channel_usage.count + EXCLUDED.count <= $4
       RETURNING count`,
      kind,
      bucket.toISOString(),
      amount,
      limit,
    );
    if (rows.length) return bucket;
    const message = `Đã hết hạn mức ${q.what} của gói (${limit} ${q.what === 'lần trả lời bình luận tự động' ? 'lần' : q.what === 'bài đăng/hẹn giờ' ? 'bài' : 'tin'}/${q.per}). Thử lại ${q.per === 'giờ' ? 'ở giờ sau' : 'vào ngày mai'} hoặc nâng gói.`;
    const err = new ChannelBlockedError('channel_quota', message);
    err.pendingEvent = { kind: 'limit_exceeded', message, meta: { quota: kind, limit, wanted: amount }, dedupe: `${kind}:${bucket.getTime()}`, log: `vượt hạn mức ${kind} (${limit}/${q.per}), cần thêm ${amount}` };
    if (!ctx) await this.recordBlocked(err);
    throw err;
  }

  /** Ghi log + sự kiện của một lần bị chặn (xem `reserve`). Gọi SAU transaction; lỗi khác loại thì bỏ qua. */
  async recordBlocked(err: unknown): Promise<void> {
    if (!(err instanceof ChannelBlockedError) || !err.pendingEvent) return;
    const e = err.pendingEvent;
    err.pendingEvent = undefined;
    this.logger.warn(`Công ty ${currentCompanyId()}: ${e.log}`);
    await this.event(e.kind, e.message, e.meta, e.dedupe);
  }

  /** Hoàn `amount` đơn vị đã giữ chỗ vào ĐÚNG khung (`bucket` do `reserve` trả) — gửi thất bại / không có token ⇒ không tính vào hạn mức. Không xuống dưới 0. */
  async refund(kind: QuotaKind, amount = 1, bucket: Date | null = null): Promise<void> {
    if (!this.enforced() || amount <= 0) return;
    try {
      await this.prisma.$executeRawUnsafe(`UPDATE channel_usage SET count = GREATEST(count - $3, 0) WHERE kind = $1 AND bucket = $2::timestamptz`, kind, (bucket ?? QUOTA[kind].bucket(Date.now())).toISOString(), amount);
    } catch (err) {
      this.logger.warn(`Không hoàn được hạn mức ${kind}: ${(err as Error).message}`);
    }
  }

  /** Số người nhận tối đa của một chiến dịch. */
  async assertRecipients(count: number): Promise<void> {
    if (!this.enforced()) return;
    await this.assertOutbound('manual'); // lúc lên lịch chỉ kiểm khoá; tạm dừng được kiểm theo giờ gửi (xem lượt gửi hàng loạt)
    const max = (await this.limits()).recipientsPerCampaign;
    if (count > max) {
      const message = `Chiến dịch có ${count} người nhận, gói hiện tại cho tối đa ${max} người mỗi chiến dịch. Lọc bớt đối tượng hoặc chia nhỏ chiến dịch.`;
      this.logger.warn(`Công ty ${currentCompanyId()}: chiến dịch ${count} người nhận vượt trần ${max}`);
      await this.event('limit_exceeded', message, { quota: 'recipients', limit: max, wanted: count }, `recipients:${dayBucket(Date.now()).getTime()}`);
      throw new ChannelBlockedError('channel_quota', message);
    }
  }

  /** Trần người nhận để cắt danh sách (phòng thủ khi chốt người nhận). */
  async recipientCap(): Promise<number> {
    return this.enforced() ? (await this.limits()).recipientsPerCampaign : Number.MAX_SAFE_INTEGER;
  }

  // ───────────────────────── tỉ lệ lỗi Graph → tự tạm dừng

  /** Gọi từ cầu nối `observeGraph` (chạy trong ngữ cảnh công ty của lời gọi). */
  recordGraph(o: GraphOutcome): void {
    if (!this.enforced()) return;
    this.applyGraph(o);
    // Chỉ lời gọi GỬI mới tính vào ngưỡng ⇒ chỉ phát những lời gọi đó (đọc không đáng một NOTIFY).
    if (o.send) void syncBus.publish('graph', { ok: o.ok, h: o.httpStatus, code: o.code, sub: o.subcode, send: true }, currentCompanyId());
  }

  /** Cộng một kết quả vào cửa sổ lỗi / backoff của tiến trình này (từ lời gọi cục bộ hoặc từ `NOTIFY graph`). */
  private applyGraph(o: GraphOutcome): void {
    if (!this.enforced()) return;
    const now = Date.now();
    // Lời gọi ĐỌC (insights, hội thoại, token…) không tính vào bất kỳ ngưỡng nào, kể cả backoff cấp app.
    if (!o.send) return;
    if (!o.ok && isGraphAppLevelLimit(o)) {
      // Giới hạn cấp app dùng chung: không đổ lỗi cho công ty đang gọi. Cần LẶP (vài lần trong 1 phút) mới lùi gửi tự động của cả app.
      this.appHits = this.appHits.filter((t) => now - t <= this.cfg.appHitWindowMs);
      this.appHits.push(now);
      if (this.appHits.length >= this.cfg.appBackoffHits) {
        if (this.appBackoffUntil < now) this.logger.warn(`Facebook giới hạn tần suất cấp app (#${o.code ?? o.httpStatus}, ${this.appHits.length} lần/phút) — lùi gửi tự động ${Math.round(this.cfg.appBackoffMs / 60_000)} phút`);
        this.appBackoffUntil = now + this.cfg.appBackoffMs;
        this.appHits = [];
      }
      return;
    }
    const company = currentCompany();
    if (!company) return;
    const block = !o.ok && isGraphBlockOutcome(o);
    const win = (this.windows.get(company.id) ?? []).filter((e) => now - e.t <= this.cfg.windowMs);
    win.push({ t: now, block, code: o.code });
    this.windows.set(company.id, win);
    if (!block) return;
    const verdict = evaluateGraphWindow(win, now, this.cfg);
    if (!verdict.trip) return;
    this.windows.delete(company.id);
    void runWithCompany(company, () => this.pause(verdict)).catch((err) => this.logger.error(`Không ghi được trạng thái tạm dừng kênh: ${(err as Error).message}`));
  }

  private async pause(v: GraphVerdict): Promise<void> {
    const id = currentCompanyId() ?? 0;
    // Hai tiến trình cùng thấy đủ lỗi (mỗi bên cộng kết quả của bên kia): đọc DB tươi để bên đến sau không ghi trùng sự kiện.
    this.pauseCache.delete(id);
    if (await this.autoPause()) return;
    const until = new Date(Date.now() + this.cfg.pauseMs).toISOString();
    this.logger.error(`Công ty ${id}: TỰ TẠM DỪNG gửi hàng loạt/tự động đến ${until} — ${v.reason} ${JSON.stringify(v.codes)}`);
    await this.event('auto_pause', `Tự tạm dừng gửi hàng loạt và tự động: ${v.reason}.`, { until, reason: v.reason, calls: v.calls, blocks: v.blocks, codes: v.codes });
    this.pauseCache.delete(id);
  }

  /** Trạng thái tạm dừng tự động đang hiệu lực của công ty hiện tại (cache 5 giây). */
  async autoPause(): Promise<AutoPause | null> {
    if (!this.enforced()) return null;
    const id = currentCompanyId() ?? 0;
    const hit = this.pauseCache.get(id);
    if (hit && Date.now() - hit.at < 5_000) return hit.v;
    let v: AutoPause | null = null;
    try {
      const rows = await this.prisma.$queryRawUnsafe<EventRow[]>(
        `SELECT id, kind, message, meta, created_at FROM channel_events WHERE kind IN ('auto_pause', 'auto_resume') ORDER BY id DESC LIMIT 1`,
      );
      const r = rows[0];
      const meta = (r?.meta ?? {}) as { until?: string; reason?: string };
      if (r?.kind === 'auto_pause' && meta.until && Date.parse(meta.until) > Date.now()) {
        v = { until: meta.until, reason: String(meta.reason ?? ''), since: r.created_at.toISOString() };
      }
    } catch (err) {
      // Không đọc được ⇒ không chặn nhầm cả công ty (fail-open); khoá của chủ nền tảng vẫn có hiệu lực.
      this.logger.warn(`Không đọc được trạng thái tạm dừng kênh: ${(err as Error).message}`);
    }
    this.pauseCache.set(id, { v, at: Date.now() });
    return v;
  }

  /** Mở lại gửi tự động sớm (chủ nền tảng/CLI sau khi đã xử lý nguyên nhân). */
  async resume(note = 'Mở lại gửi tự động'): Promise<boolean> {
    if (!this.enforced()) return false;
    const was = await this.autoPause();
    if (!was) return false;
    await this.event('auto_resume', note, {});
    this.pauseCache.delete(currentCompanyId() ?? 0);
    return true;
  }

  // ───────────────────────── sự kiện & trạng thái

  /** Ghi sự kiện (lỗi ghi không được làm hỏng việc chính). `dedupe` = khoá để mỗi khung chỉ ghi một lần. */
  private async event(kind: string, message: string, meta: Record<string, unknown>, dedupe?: string): Promise<void> {
    const id = currentCompanyId() ?? 0;
    if (dedupe) {
      const key = `${id}:${kind}:${dedupe}`;
      if (this.loggedBuckets.has(key)) return;
      if (this.loggedBuckets.size > 5000) this.loggedBuckets.clear();
      this.loggedBuckets.add(key);
    }
    try {
      await this.prisma.$executeRawUnsafe(`INSERT INTO channel_events (kind, message, meta) VALUES ($1, $2, $3::jsonb)`, kind, message.slice(0, 1000), JSON.stringify(meta));
    } catch (err) {
      this.logger.warn(`Không ghi được sự kiện kênh ${kind}: ${(err as Error).message}`);
    }
  }

  async alerts(): Promise<ChannelAlerts> {
    if (!this.enforced()) return { enforced: false, locked: false, paused: false, warnings: [] };
    const s = await this.status();
    return { enforced: true, locked: s.locked.locked, paused: s.auto_pause !== null, warnings: s.warnings };
  }

  async status(): Promise<ChannelGuardStatus> {
    const plan = await this.plan();
    const limits = channelLimitsFor(plan);
    if (!this.enforced()) {
      return { enforced: false, plan, limits, usage: { bulk_messages_today: 0, posts_today: 0, auto_comment_replies_this_hour: 0 }, locked: { locked: false, reason: null, since: null }, auto_pause: null, warnings: [], recent_events: [] };
    }
    const id = currentCompanyId() ?? 0;
    const now = Date.now();
    const used = async (kind: QuotaKind): Promise<number> => {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(`SELECT count FROM channel_usage WHERE kind = $1 AND bucket = $2::timestamptz`, kind, QUOTA[kind].bucket(now).toISOString());
      return rows[0]?.count ?? 0;
    };
    const [bulk, posts, replies, lock, pause, events] = await Promise.all([
      used('bulk_message'),
      used('post'),
      used('comment_reply'),
      getChannelLock(id),
      this.autoPause(),
      this.prisma.$queryRawUnsafe<EventRow[]>(`SELECT id, kind, message, meta, created_at FROM channel_events ORDER BY id DESC LIMIT 10`),
    ]);
    const warnings: string[] = [];
    if (lock.locked) warnings.push(`Kênh gửi ra ngoài đang bị tạm khoá${lock.reason ? `: ${lock.reason}` : ''}. Nhận tin vẫn chạy.`);
    if (pause) warnings.push(`Gửi hàng loạt và tự động tạm dừng đến ${formatVn(pause.until)}: ${pause.reason}.`);
    const near = (n: number, max: number, what: string): void => {
      if (n >= max) warnings.push(`Đã dùng hết hạn mức ${what} (${n}/${max}).`);
      else if (n >= max * 0.8) warnings.push(`Sắp hết hạn mức ${what} (${n}/${max}).`);
    };
    near(bulk, limits.bulkMessagesPerDay, 'tin gửi hàng loạt hôm nay');
    near(posts, limits.postsPerDay, 'bài đăng hôm nay');
    near(replies, limits.autoCommentRepliesPerHour, 'trả lời bình luận tự động giờ này');
    return {
      enforced: true,
      plan,
      limits,
      usage: { bulk_messages_today: bulk, posts_today: posts, auto_comment_replies_this_hour: replies },
      locked: { locked: lock.locked, reason: lock.reason, since: lock.lockedAt?.toISOString() ?? null },
      auto_pause: pause,
      warnings,
      recent_events: events.map((e) => ({ id: e.id, kind: e.kind, message: e.message, at: e.created_at.toISOString() })),
    };
  }
}

function formatVn(iso: string): string {
  const d = new Date(Date.parse(iso) + VN_OFFSET_MS);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
}

