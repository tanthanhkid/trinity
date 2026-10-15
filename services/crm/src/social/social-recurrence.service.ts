import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import type { Prisma, SocialRecurrence } from '@prisma/client';
import { MAX_SCHEDULE_AHEAD_MS } from './social.config';
import { SocialPostsService, type CreatePostInput } from './social-posts.service';

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Giờ Việt Nam = UTC+7, không có giờ mùa hè. */
const VN_OFFSET_MS = 7 * 3_600_000;
/** Trễ quá chừng này (máy ngủ) thì bỏ lần đó, không đăng muộn. */
export const RECURRENCE_LATE_MS = 60 * MINUTE;
/** Bài hẹn giờ chỉ tạo được trong 90 ngày tới; lần đăng xa hơn thì chờ, chưa tạo. */
const CREATE_AHEAD_MS = MAX_SCHEDULE_AHEAD_MS - DAY;
const MAX_RECURRENCES = 50;
export const RECUR_SOURCE_PREFIX = 'recur:';

export type RecurFreq = 'daily' | 'weekly' | 'monthly';
export interface RecurrenceRule {
  freq: RecurFreq;
  interval: number;
  /** 0 = Chủ nhật … 6 (chỉ weekly; bỏ trống = đúng thứ của ngày bắt đầu). */
  weekdays?: number[];
  /** 1–31 (chỉ monthly; tháng ngắn lấy ngày cuối; bỏ trống = ngày của ngày bắt đầu). */
  month_day?: number;
  /** 'HH:mm' giờ Việt Nam. */
  time: string;
}
export interface RecurrenceTemplate {
  content: string;
  media_keys: string[];
  targets: Array<{ account_id: number; caption?: string | null; options?: Record<string, unknown> }>;
  utm?: { campaign: string; content?: string } | null;
}
export interface RecurrenceInput {
  title?: string;
  template?: Partial<RecurrenceTemplate>;
  rule?: Partial<RecurrenceRule>;
  starts_on?: string;
  ends_on?: string | null;
  max_count?: number | null;
}

const bad = (m: string) => new BadRequestException(m);
const dayNumOf = (ms: number) => Math.floor((ms + VN_OFFSET_MS) / DAY);
const parseDay = (s: string): number => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY);
const lastDayOf = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * Lần đăng ĐẦU TIÊN sau `after` (giờ Việt Nam), tính theo mốc `startsOn` (YYYY-MM-DD): chu kỳ `interval` đếm từ ngày/tuần/tháng của
 * ngày bắt đầu; không có lần nào trước `startsOn`. Thuần tuý — không đọc đồng hồ, không đọc DB. Null khi không tìm thấy trong ~2 năm.
 */
export function nextOccurrence(rule: RecurrenceRule, after: Date, startsOn: string): Date | null {
  const start = parseDay(startsOn);
  if (Number.isNaN(start)) return null;
  const mins = minutesOf(rule.time);
  const interval = Math.max(1, rule.interval || 1);
  const sd = new Date(start * DAY);
  const startWeekday = sd.getUTCDay();
  const monday = (d: number) => d - ((new Date(d * DAY).getUTCDay() + 6) % 7);
  const weekdays = rule.weekdays && rule.weekdays.length ? rule.weekdays : [startWeekday];
  for (let d = Math.max(dayNumOf(after.getTime()), start), n = 0; n < 800; d++, n++) {
    const dt = new Date(d * DAY);
    let hit = false;
    if (rule.freq === 'daily') hit = (d - start) % interval === 0;
    else if (rule.freq === 'weekly') hit = weekdays.includes(dt.getUTCDay()) && ((monday(d) - monday(start)) / 7) % interval === 0;
    else {
      const months = (dt.getUTCFullYear() - sd.getUTCFullYear()) * 12 + dt.getUTCMonth() - sd.getUTCMonth();
      const want = Math.min(rule.month_day ?? sd.getUTCDate(), lastDayOf(dt.getUTCFullYear(), dt.getUTCMonth()));
      hit = months % interval === 0 && dt.getUTCDate() === want;
    }
    if (!hit) continue;
    const at = new Date(d * DAY + mins * MINUTE - VN_OFFSET_MS);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

/** Lần kế tiếp còn hợp lệ: bỏ lần quá `ends_on`. (`max_count` do người gọi kiểm vì phụ thuộc số bài đã tạo.) */
export function nextWithin(rule: RecurrenceRule, after: Date, startsOn: string, endsOn: string | null): Date | null {
  const n = nextOccurrence(rule, after, startsOn);
  if (!n) return null;
  if (endsOn && dayNumOf(n.getTime()) > parseDay(endsOn)) return null;
  return n;
}

/** Chuẩn hoá + kiểm luật lặp; ném 400 tiếng Việt khi sai. */
export function normalizeRule(raw: unknown): RecurrenceRule {
  if (!raw || typeof raw !== 'object') throw bad('Thiếu luật lặp (rule).');
  const r = raw as Record<string, unknown>;
  if (r.freq !== 'daily' && r.freq !== 'weekly' && r.freq !== 'monthly') throw bad('freq phải là daily, weekly hoặc monthly.');
  const interval = r.interval === undefined ? 1 : r.interval;
  if (!Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > 12) throw bad('interval phải là số nguyên từ 1 đến 12.');
  if (typeof r.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) throw bad('time phải có dạng HH:mm (giờ Việt Nam).');
  const out: RecurrenceRule = { freq: r.freq, interval: interval as number, time: r.time };
  if (r.freq === 'weekly' && r.weekdays !== undefined && r.weekdays !== null) {
    if (!Array.isArray(r.weekdays) || r.weekdays.some((w) => !Number.isInteger(w) || w < 0 || w > 6)) throw bad('weekdays là danh sách thứ từ 0 (Chủ nhật) đến 6 (Thứ bảy).');
    const w = [...new Set(r.weekdays as number[])].sort((a, b) => a - b);
    if (w.length) out.weekdays = w;
  }
  if (r.freq === 'monthly' && r.month_day !== undefined && r.month_day !== null) {
    if (!Number.isInteger(r.month_day) || (r.month_day as number) < 1 || (r.month_day as number) > 31) throw bad('month_day phải từ 1 đến 31.');
    out.month_day = r.month_day as number;
  }
  return out;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Chuẩn hoá khuôn bài (chỉ giữ các trường biết). */
export function normalizeTemplate(raw: unknown): RecurrenceTemplate {
  if (!raw || typeof raw !== 'object') throw bad('Thiếu nội dung bài (template).');
  const t = raw as Record<string, unknown>;
  const content = typeof t.content === 'string' ? t.content : '';
  const keys = Array.isArray(t.media_keys) ? t.media_keys.filter((k): k is string => typeof k === 'string' && k.trim() !== '').map((k) => k.trim()) : [];
  if (!Array.isArray(t.targets) || t.targets.length === 0) throw bad('Chọn ít nhất một kênh.');
  const targets = t.targets.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(o.account_id)) throw bad('Mỗi kênh cần account_id là số nguyên.');
    const out: RecurrenceTemplate['targets'][number] = { account_id: o.account_id as number };
    if (typeof o.caption === 'string' && o.caption.trim()) out.caption = o.caption.trim();
    if (o.options && typeof o.options === 'object' && !Array.isArray(o.options)) out.options = o.options as Record<string, unknown>;
    return out;
  });
  const out: RecurrenceTemplate = { content: content.trim(), media_keys: [...new Set(keys)], targets };
  const u = t.utm as { campaign?: unknown; content?: unknown } | null | undefined;
  if (u && typeof u === 'object' && typeof u.campaign === 'string') out.utm = { campaign: u.campaign, ...(typeof u.content === 'string' && u.content ? { content: u.content } : {}) };
  return out;
}

const asRule = (v: unknown) => v as RecurrenceRule;
const asTemplate = (v: unknown) => v as RecurrenceTemplate;
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);

/** Người chạy việc nền = người tạo lịch; chỉ `userId` được dùng (kiểm tệp của chính họ), không mang quyền nào. */
const creatorOf = (userId: number): AuthUser => ({ userId, email: '', isAdmin: false, grants: {} });

export interface RecurrenceView {
  id: number;
  title: string;
  template: RecurrenceTemplate;
  rule: RecurrenceRule;
  starts_on: string;
  ends_on: string | null;
  max_count: number | null;
  count: number;
  next_run_at: string | null;
  active: boolean;
  last_error: string | null;
  created_by: number;
  /** 3 lần đăng tới (tính ra, không lưu; rỗng khi đang tạm dừng). */
  next_times: string[];
  /** Bài đã tạo gần đây (mới nhất trước). */
  posts: Array<{ id: number; status: string; scheduled_at: string | null }>;
}

/** Lịch đổi (tạm dừng / sửa / xoá) giữa lúc đọc và lúc tạo bài ⇒ huỷ transaction tạo bài. */
class RecurrenceChanged extends Error {}

@Injectable()
export class SocialRecurrenceService {
  private readonly logger = new Logger(SocialRecurrenceService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: SocialPostsService,
  ) {}

  // ---------- đọc ----------

  private async pendingPost(id: number) {
    return this.prisma.socialPost.findFirst({ where: { source: { startsWith: `${RECUR_SOURCE_PREFIX}${id}:` }, status: 'scheduled' }, select: { id: true, source: true }, orderBy: { id: 'desc' } });
  }

  /** `n` lần đăng tới sau `now` (đã trừ số bài còn được tạo theo `max_count`). */
  upcoming(r: Pick<SocialRecurrence, 'rule' | 'starts_on' | 'ends_on' | 'max_count' | 'count' | 'active'>, pending: boolean, n = 3, now = Date.now()): Date[] {
    if (!r.active) return [];
    const rule = asRule(r.rule);
    const out: Date[] = [];
    // Bài đang chờ đã tính vào `count` nhưng chưa tới giờ: còn lại = max_count - (count - 1 nếu có bài chờ).
    let left = r.max_count === null ? Infinity : r.max_count - (r.count - (pending ? 1 : 0));
    let cursor = new Date(now);
    while (out.length < n && left > 0) {
      const nx = nextWithin(rule, cursor, dateOnly(r.starts_on)!, dateOnly(r.ends_on));
      if (!nx) break;
      out.push(nx);
      cursor = nx;
      left--;
    }
    return out;
  }

  async list(): Promise<RecurrenceView[]> {
    const rows = await this.prisma.socialRecurrence.findMany({ orderBy: { id: 'desc' }, take: 200 });
    if (rows.length === 0) return [];
    const posts = await this.prisma.socialPost.findMany({ where: { source: { startsWith: RECUR_SOURCE_PREFIX } }, orderBy: { id: 'desc' }, take: 500, select: { id: true, status: true, scheduled_at: true, source: true } });
    const by = new Map<number, typeof posts>();
    for (const p of posts) {
      const id = Number(/^recur:(\d+):/.exec(p.source)?.[1]);
      if (!id) continue;
      by.set(id, [...(by.get(id) ?? []), p]);
    }
    return rows.map((r) => this.view(r, by.get(r.id) ?? []));
  }

  async get(id: number): Promise<RecurrenceView> {
    const r = await this.prisma.socialRecurrence.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Không tìm thấy bài lặp lại');
    const posts = await this.prisma.socialPost.findMany({ where: { source: { startsWith: `${RECUR_SOURCE_PREFIX}${id}:` } }, orderBy: { id: 'desc' }, take: 50, select: { id: true, status: true, scheduled_at: true, source: true } });
    return this.view(r, posts);
  }

  private view(r: SocialRecurrence, posts: Array<{ id: number; status: string; scheduled_at: Date | null }>): RecurrenceView {
    return {
      id: r.id,
      title: r.title,
      template: asTemplate(r.template),
      rule: asRule(r.rule),
      starts_on: dateOnly(r.starts_on)!,
      ends_on: dateOnly(r.ends_on),
      max_count: r.max_count,
      count: r.count,
      next_run_at: r.next_run_at ? r.next_run_at.toISOString() : null,
      active: r.active,
      last_error: r.last_error,
      created_by: r.created_by,
      next_times: this.upcoming(r, posts.some((p) => p.status === 'scheduled')).map((d) => d.toISOString()),
      posts: posts.slice(0, 5).map((p) => ({ id: p.id, status: p.status, scheduled_at: p.scheduled_at ? p.scheduled_at.toISOString() : null })),
    };
  }

  // ---------- ghi ----------

  /** Ghép phần sửa vào bản cũ rồi kiểm toàn bộ (kể cả kênh/tệp, như lúc tạo bài). */
  private async normalized(user: AuthUser, input: RecurrenceInput, base?: SocialRecurrence) {
    const title = (input.title ?? base?.title ?? '').trim();
    if (!title || title.length > 120) throw bad('Tên bài lặp lại từ 1 đến 120 ký tự.');
    const template = normalizeTemplate(input.template ? { ...(base ? asTemplate(base.template) : {}), ...input.template } : base?.template);
    const rule = normalizeRule(input.rule ? { ...(base ? asRule(base.rule) : {}), ...input.rule } : base?.rule);
    const startsOn = input.starts_on ?? dateOnly(base?.starts_on ?? null);
    if (!isDay(startsOn)) throw bad('starts_on phải có dạng YYYY-MM-DD.');
    const endsOn = input.ends_on === undefined ? dateOnly(base?.ends_on ?? null) : input.ends_on;
    if (endsOn !== null && !isDay(endsOn)) throw bad('ends_on phải có dạng YYYY-MM-DD.');
    if (endsOn !== null && endsOn < startsOn) throw bad('Ngày kết thúc phải sau ngày bắt đầu.');
    const maxCount = input.max_count === undefined ? (base?.max_count ?? null) : input.max_count;
    if (maxCount !== null && (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 1000)) throw bad('max_count phải từ 1 đến 1000.');
    const validated = await this.posts.validate(user, this.postInput(template));
    return { title, template, rule, startsOn, endsOn, maxCount, validated };
  }

  private postInput(t: RecurrenceTemplate, scheduledAt?: string): CreatePostInput {
    return { content: t.content, media_keys: t.media_keys, targets: t.targets, ...(t.utm !== undefined ? { utm: t.utm } : {}), ...(scheduledAt ? { scheduled_at: scheduledAt } : {}) };
  }

  /**
   * Xem trước (không ghi gì): kiểm như lúc lưu và tính 3 lần đăng tới. `id` có ⇒ ghép phần sửa vào lịch đó
   * (bài hẹn đang chờ coi như sẽ bị huỷ nên không tính vào `count`).
   */
  async preview(user: AuthUser, input: RecurrenceInput, id?: number) {
    const base = id ? await this.row(id) : undefined;
    const v = await this.normalized(user, input, base);
    const pending = base ? Boolean(await this.pendingPost(base.id)) : false;
    const count = base ? Math.max(base.count - (pending ? 1 : 0), 0) : 0;
    const times = this.upcoming({ rule: v.rule as never, starts_on: toDate(v.startsOn), ends_on: v.endsOn ? toDate(v.endsOn) : null, max_count: v.maxCount, count, active: true }, false);
    return { ...v, times };
  }

  async create(user: AuthUser, input: RecurrenceInput): Promise<RecurrenceView> {
    if ((await this.prisma.socialRecurrence.count({ where: { active: true } })) >= MAX_RECURRENCES) throw bad(`Tối đa ${MAX_RECURRENCES} bài lặp lại đang chạy.`);
    const v = await this.normalized(user, input);
    const first = this.firstRun(v.rule, v.startsOn, v.endsOn, v.maxCount, 0, Date.now());
    if (!first) throw bad('Với ngày bắt đầu/kết thúc này không có lần đăng nào trong tương lai.');
    const row = await this.prisma.socialRecurrence.create({
      data: {
        title: v.title,
        template: v.template as unknown as Prisma.InputJsonValue,
        rule: v.rule as unknown as Prisma.InputJsonValue,
        starts_on: toDate(v.startsOn),
        ends_on: v.endsOn ? toDate(v.endsOn) : null,
        max_count: v.maxCount,
        next_run_at: first,
        created_by: user.userId,
      },
    });
    await this.materializeOne(row.id);
    return this.get(row.id);
  }

  /** Sửa chỉ áp cho bài sau: huỷ bài hẹn đang chờ (không xoá), tính lại lần kế tiếp từ bây giờ rồi tạo lại. */
  async update(user: AuthUser, id: number, input: RecurrenceInput): Promise<RecurrenceView> {
    const base = await this.row(id);
    const v = await this.normalized(user, input, base);
    // Ngắt lần chạy đang chờ TRƯỚC (next_run_at = null) rồi mới huỷ bài chờ — lượt chạy nền chen vào sẽ bỏ bài.
    await this.prisma.socialRecurrence.update({ where: { id }, data: { next_run_at: null } });
    await this.cancelPending(id);
    const fresh = await this.row(id);
    const next = this.firstRun(v.rule, v.startsOn, v.endsOn, v.maxCount, fresh.count, Date.now());
    await this.prisma.socialRecurrence.update({
      where: { id },
      data: {
        title: v.title,
        template: v.template as unknown as Prisma.InputJsonValue,
        rule: v.rule as unknown as Prisma.InputJsonValue,
        starts_on: toDate(v.startsOn),
        ends_on: v.endsOn ? toDate(v.endsOn) : null,
        max_count: v.maxCount,
        next_run_at: next,
        last_error: null,
      },
    });
    if (base.active) await this.materializeOne(id);
    return this.get(id);
  }

  async pause(id: number): Promise<RecurrenceView> {
    await this.row(id);
    // Tắt TRƯỚC rồi mới huỷ bài chờ: lượt chạy nền đang dở sẽ thấy lịch đã tắt (kiểm trong transaction tạo bài) và bỏ bài.
    await this.prisma.socialRecurrence.update({ where: { id }, data: { active: false } });
    await this.cancelPending(id);
    return this.get(id);
  }

  async resume(id: number): Promise<RecurrenceView> {
    const r = await this.row(id);
    // Cùng giới hạn như lúc tạo: tạm dừng hàng loạt, tạo thêm rồi tiếp tục cũng không vượt được.
    if (!r.active && (await this.prisma.socialRecurrence.count({ where: { active: true } })) >= MAX_RECURRENCES) throw bad(`Tối đa ${MAX_RECURRENCES} bài lặp lại đang chạy — tạm dừng bớt lịch khác trước.`);
    await this.cancelPending(id);
    const fresh = await this.row(id);
    const next = this.firstRun(asRule(r.rule), dateOnly(r.starts_on)!, dateOnly(r.ends_on), r.max_count, fresh.count, Date.now());
    await this.prisma.socialRecurrence.update({ where: { id }, data: { active: true, next_run_at: next, last_error: null } });
    await this.materializeOne(id);
    return this.get(id);
  }

  /** Web: tạm dừng (huỷ bài chờ) rồi xoá lịch. Bài đã đăng giữ nguyên. */
  async remove(id: number): Promise<void> {
    await this.row(id);
    await this.prisma.socialRecurrence.update({ where: { id }, data: { active: false, next_run_at: null } });
    await this.cancelPending(id);
    await this.prisma.socialRecurrence.delete({ where: { id } });
  }

  private async row(id: number): Promise<SocialRecurrence> {
    const r = await this.prisma.socialRecurrence.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Không tìm thấy bài lặp lại');
    return r;
  }

  /** Huỷ bài hẹn đang chờ của lịch (nếu có) và trả lại 1 lần cho `count` — bài đó chưa lên mạng. */
  private async cancelPending(id: number): Promise<void> {
    const pending = await this.pendingPost(id);
    if (!pending) return;
    try {
      await this.posts.cancel(pending.id);
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() < 500) return; // đã bắt đầu đăng / đã huỷ
      throw e;
    }
    // Bài huỷ trả lại khoá chống lặp (source): lần tạo lại cùng giờ (sửa / tạm dừng rồi tiếp tục) không bị coi là trùng mà mất bài.
    await this.prisma.$executeRaw`UPDATE social_posts SET source = LEFT('cancelled:' || source, 80) WHERE id = ${pending.id} AND source LIKE ${RECUR_SOURCE_PREFIX + '%'}`;
    await this.prisma.$executeRaw`UPDATE social_recurrences SET count = GREATEST(count - 1, 0) WHERE id = ${id}`;
  }

  /** Lần đăng đầu tiên sau `now` còn nằm trong ends_on / max_count. */
  private firstRun(rule: RecurrenceRule, startsOn: string, endsOn: string | null, maxCount: number | null, count: number, now: number): Date | null {
    if (maxCount !== null && count >= maxCount) return null;
    return nextWithin(rule, new Date(now), startsOn, endsOn);
  }

  // ---------- chạy nền ----------

  /**
   * Gọi mỗi lượt tick: với mỗi lịch đang chạy mà chưa có bài hẹn sắp tới thì tạo đúng một bài (khoá chống lặp `recur:<id>:<giờ ISO>`),
   * rồi tăng `count` và dời `next_run_at` bằng cập nhật có điều kiện — hai tick song song chỉ một bên dời được.
   */
  async materialize(now = Date.now()): Promise<{ created: number; skipped: number; paused: number }> {
    const out = { created: 0, skipped: 0, paused: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const rows = await this.prisma.socialRecurrence.findMany({ where: { active: true, next_run_at: { not: null } }, orderBy: { id: 'asc' }, take: 200 });
      for (const r of rows) {
        try {
          const res = await this.runOne(r, now);
          out[res]++;
        } catch (err) {
          this.logger.error(`Bài lặp lại #${r.id} lỗi: ${(err as Error)?.message}`);
        }
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  /**
   * Tạo ngay bài kế tiếp sau khi lưu/sửa/tiếp tục. Lịch đã lưu xong nên lỗi hạ tầng ở đây KHÔNG được thành lỗi 500
   * (người dùng thử lại sẽ tạo lịch thứ hai) — ghi log, lượt chạy nền sau sẽ tạo bài.
   */
  private async materializeOne(id: number, now = Date.now()): Promise<void> {
    try {
      const r = await this.row(id);
      if (!r.active || !r.next_run_at) return;
      await this.runOne(r, now);
    } catch (err) {
      this.logger.error(`Bài lặp lại #${id}: chưa tạo được bài kế tiếp, lượt chạy nền sẽ thử lại — ${(err as Error)?.message}`);
    }
  }

  /** Dời `next_run_at` từ `from` sang lần kế (hoặc null khi hết), kèm `count` tăng `inc`. Trả true nếu CHÍNH lượt này dời được. */
  private async advance(r: SocialRecurrence, from: Date, to: Date | null, inc: number): Promise<boolean> {
    const done = await this.prisma.socialRecurrence.updateMany({
      where: { id: r.id, next_run_at: from },
      data: { next_run_at: to, ...(inc ? { count: { increment: inc } } : {}) },
    });
    return done.count === 1;
  }

  private async runOne(r: SocialRecurrence, now: number): Promise<'created' | 'skipped' | 'paused'> {
    let at = r.next_run_at!;
    const rule = asRule(r.rule);
    const startsOn = dateOnly(r.starts_on)!;
    const endsOn = dateOnly(r.ends_on);
    let count = r.count;
    const after = (from: Date, c: number) => (r.max_count !== null && c >= r.max_count ? null : nextWithin(rule, from, startsOn, endsOn));
    const key = (d: Date) => `${RECUR_SOURCE_PREFIX}${r.id}:${d.toISOString()}`;

    const pending = await this.pendingPost(r.id);
    // Đã có bài chờ: nếu đó chính là bài của `next_run_at` (lần trước tạo xong mà chưa kịp dời) thì dời nốt; còn lại là bình thường.
    if (pending) {
      if (pending.source === key(at)) await this.advance(r, at, after(at, count + 1), 1);
      return 'skipped';
    }
    // Trễ quá 1 giờ (máy ngủ): nhảy tới lần kế tiếp ở tương lai, không đăng muộn.
    if (at.getTime() < now - RECURRENCE_LATE_MS) {
      const to = after(new Date(now - RECURRENCE_LATE_MS), count);
      if (!(await this.advance(r, at, to, 0))) return 'skipped';
      if (!to) return 'skipped';
      at = to;
    }
    if (at.getTime() > now + CREATE_AHEAD_MS) return 'skipped'; // xa hơn 90 ngày: chờ
    const fresh = await this.prisma.socialRecurrence.findUnique({ where: { id: r.id } });
    if (!fresh || !fresh.active || fresh.next_run_at?.getTime() !== at.getTime()) return 'skipped';
    count = fresh.count;
    if (r.max_count !== null && count >= r.max_count) {
      await this.advance(fresh, at, null, 0);
      return 'skipped';
    }
    // Giờ hẹn phải cách bây giờ ≥ 1 phút (trễ ít thì đăng trong vài phút tới).
    const scheduled = new Date(Math.max(at.getTime(), now + 2 * MINUTE));
    try {
      await this.posts.create(creatorOf(r.created_by), this.postInput(asTemplate(r.template), scheduled.toISOString()), {
        dedupeSource: key(at),
        // Kiểm lại NGAY TRONG transaction tạo bài (khoá dòng lịch): vừa bị tạm dừng / sửa / xoá thì bỏ bài, không đăng.
        inTx: async (tx) => {
          const still = await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM social_recurrences WHERE id = ${r.id} AND active AND next_run_at = ${at} FOR UPDATE`;
          if (still.length === 0) throw new RecurrenceChanged();
        },
      });
    } catch (err) {
      if (err instanceof RecurrenceChanged) return 'skipped';
      if (err instanceof ConflictException) {
        await this.advance(r, at, after(at, count + 1), 1); // bài đã có (tick khác tạo) — chỉ dời nốt
        return 'skipped';
      }
      if (err instanceof HttpException && err.getStatus() < 500) {
        // Kênh gỡ liên kết, tệp mất… — dừng hẳn để khỏi lặp lỗi, người dùng sửa rồi bấm Tiếp tục.
        await this.prisma.socialRecurrence.update({ where: { id: r.id }, data: { active: false, last_error: err.message.slice(0, 1000) } });
        this.logger.warn(`Bài lặp lại #${r.id} tạm dừng: ${err.message}`);
        return 'paused';
      }
      throw err;
    }
    await this.advance(r, at, after(at, count + 1), 1);
    return 'created';
  }
}
