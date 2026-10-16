import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService, publishIntegrationEvent } from '@trinity/prisma';
import { trackProductEvent } from '@trinity/logger';
import { isServerless, runInBackground, type AuthUser } from '@trinity/rbac-nest';
import type { Prisma, SocialPost, SocialPostTarget } from '@prisma/client';
import { SocialProviderRegistry } from './providers/provider.registry';
import { SocialPostGoneError, SocialPublishError, type AccountForPublish, type PostMetrics, type SocialMedia, type SocialProvider } from './providers/provider.types';
import { TiktokSocialProvider, type TiktokCreatorInfo } from './providers/tiktok.provider';
import { GoogleBusinessSocialProvider, type GbpReview } from './providers/google-business.provider';
import { YoutubeSocialProvider, youtubeTitle } from './providers/youtube.provider';
import { firstCommentOf, postFirstComment } from './facebook-first-comment';
import { commentAutomationEnabled } from '../facebook/facebook.config';
import { SocialAccountsService } from './social-accounts.service';
import { SocialMediaService } from './social-media.service';
import { NO_QUEUE_SLOTS, SocialQueueService } from './social-queue.service';
import { CAPTION_LIMITS, MAX_MEDIA_PER_POST, MAX_SCHEDULE_AHEAD_MS, NETWORK_LABELS, isSocialNetwork, socialBaseUrl, truncatedAt, type SocialNetwork } from './social.config';
import { mediaLinkExt, signMediaLink } from './social-media-link';
import { applyUtmToTarget, normalizeUtm, type UtmInput } from './social-utm';

const MINUTE = 60_000;
/** Giãn cách thử lại lỗi tạm thời (lần 1→2, 2→3…). Hết mảng ⇒ lỗi hẳn. */
/** Lần tạo mang cùng khoá chống lặp đã chạy rồi (vd gửi lại cùng một lượt nhập). */
export const ALREADY_CREATED = 'Dòng này đã được tạo ở lần nhập trước — không tạo lại.';

export const SOCIAL_RETRY_DELAYS_MS = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE] as const;
export const SOCIAL_MAX_ATTEMPTS = SOCIAL_RETRY_DELAYS_MS.length + 1;
/** Thời gian giữ việc khi đang đăng. Quá hạn mà chưa ghi kết quả ⇒ không rõ đã lên chưa ⇒ báo lỗi, KHÔNG tự đăng lại (tránh đăng trùng). */
export const SOCIAL_LEASE_SECONDS = 15 * 60;
/** Hẹn giờ tối đa 90 ngày tới. */
const MAX_TARGETS = 20;

export interface CreateTargetInput {
  account_id: number;
  caption?: string | null;
  options?: Record<string, unknown>;
}
export interface CreatePostInput {
  content: string;
  media_keys?: string[];
  targets: CreateTargetInput[];
  /** ISO 8601; bỏ trống = đăng ngay. */
  scheduled_at?: string | null;
  /** Đặt vào khung trống gần nhất của hàng đợi (chỉ khi không có scheduled_at). */
  use_queue?: boolean;
  /** Gắn UTM vào liên kết khi đăng (chung cho mọi kênh). undefined = theo `options.utm` từng kênh; null = bỏ. */
  utm?: UtmInput | null;
  source?: string;
}

/** Bản xem trước một kênh (xem `SocialPostsService.preview`). */
export interface TargetPreview {
  account_id: number;
  account_name: string;
  network: SocialNetwork | null;
  /** Chữ chung/riêng của kênh sau UTM — đúng chữ sẽ gửi. */
  text: string;
  /** YouTube: tiêu đề sẽ dùng. */
  title: string | null;
  /** YouTube: mô tả sẽ dùng (sau UTM). */
  description: string | null;
  /** Facebook: bình luận đầu tiên (sau UTM). */
  first_comment: string | null;
  length: number;
  limit: number | null;
  /** Vị trí mạng gập "Xem thêm" (xấp xỉ; YouTube tính trên mô tả); null = hiện đủ. */
  truncated_at: number | null;
  media: Array<{ key: string; type: 'image' | 'video' }>;
  warnings: string[];
}
export interface PostPreview {
  scheduled_at: string | null;
  from_queue: boolean;
  /** Cảnh báo chung (tệp, giờ hẹn, hàng đợi). */
  warnings: string[];
  targets: TargetPreview[];
}

/** Chỉ lấy số bài đăng trong 90 ngày gần nhất. */
export const METRICS_WINDOW_MS = 90 * 86_400_000;
/** Bài mới (< 2 ngày) lấy số lại mỗi giờ, bài cũ hơn mỗi 6 giờ. */
export function metricsDue(publishedAt: Date, metricsAt: Date | null, now = Date.now()): boolean {
  if (!metricsAt) return true;
  const fresh = now - publishedAt.getTime() < 2 * 86_400_000;
  return now - metricsAt.getTime() >= (fresh ? 60 : 360) * MINUTE;
}

export interface MetricsSum {
  views: number | null;
  reactions: number;
  comments: number;
  shares: number;
}

/** Cộng số các kênh; lượt xem null khi không kênh nào có số lượt xem. */
export function sumMetrics(list: Array<Partial<PostMetrics> | null | undefined>): MetricsSum {
  const out: MetricsSum = { views: null, reactions: 0, comments: 0, shares: 0 };
  for (const m of list) {
    if (!m) continue;
    if (typeof m.views === 'number') out.views = (out.views ?? 0) + m.views;
    out.reactions += m.reactions ?? 0;
    out.comments += m.comments ?? 0;
    out.shares += m.shares ?? 0;
  }
  return out;
}

const storedMetrics = (t: Pick<SocialPostTarget, 'metrics'>): PostMetrics | null => (t.metrics && typeof t.metrics === 'object' ? (t.metrics as unknown as PostMetrics) : null);
const isRemoved = (t: Pick<SocialPostTarget, 'metrics'>): boolean => storedMetrics(t)?.removed === true;

/** Tương tác = cảm xúc/thích + bình luận + chia sẻ (không tính lượt xem — chỉ một số mạng có). */
export const engagementOf = (m: Partial<PostMetrics> | null | undefined): number => (m ? (m.reactions ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) : 0);

interface ClaimedTarget {
  id: number;
}

type PostWithTargets = SocialPost & { targets: Array<SocialPostTarget & { account_name: string | null }> };

/** Tổng hợp trạng thái bài từ trạng thái các đích. */
export function aggregateStatus(targets: Array<Pick<SocialPostTarget, 'status'>>, scheduled: boolean): string {
  const s = targets.map((t) => t.status);
  if (s.length === 0 || s.every((x) => x === 'cancelled')) return 'cancelled';
  const live = s.filter((x) => x !== 'cancelled');
  if (live.some((x) => x === 'publishing')) return 'publishing';
  if (live.some((x) => x === 'queued')) return live.some((x) => x === 'published' || x === 'failed') ? 'publishing' : scheduled ? 'scheduled' : 'publishing';
  if (live.every((x) => x === 'published')) return 'published';
  if (live.every((x) => x === 'failed')) return 'failed';
  return 'partial';
}

@Injectable()
export class SocialPostsService {
  private readonly logger = new Logger(SocialPostsService.name);
  private running = false;
  private lastDueCheck = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: SocialAccountsService,
    readonly media: SocialMediaService,
    private readonly providers: SocialProviderRegistry,
    @Optional() private readonly queue?: SocialQueueService,
  ) {}

  /** Kiểm toàn bộ bài (không ghi gì) — dùng cho cả web và bản xem trước của MCP. */
  async validate(user: AuthUser, input: CreatePostInput, opts: { keepMedia?: SocialMedia[] } = {}) {
    const content = (input.content ?? '').trim();
    const keys = [...new Set((input.media_keys ?? []).map((k) => k.trim()).filter(Boolean))];
    if (keys.length > MAX_MEDIA_PER_POST) throw new BadRequestException(`Tối đa ${MAX_MEDIA_PER_POST} tệp mỗi bài.`);
    // Sửa bài mà giữ nguyên tệp: dùng lại tệp đã lưu (tệp đã ẩn khỏi thư viện vẫn giữ cho bài hẹn giờ — không bắt resolve lại).
    const same = opts.keepMedia && opts.keepMedia.length === keys.length && opts.keepMedia.every((m) => keys.includes(m.key));
    const media = same ? opts.keepMedia! : await this.media.resolve(user, keys);
    if (!content && media.length === 0) throw new BadRequestException('Bài cần có nội dung hoặc ảnh/video.');
    let scheduledAt: Date | null = null;
    if (input.scheduled_at) {
      scheduledAt = new Date(input.scheduled_at);
      if (Number.isNaN(scheduledAt.getTime())) throw new BadRequestException('scheduled_at không đúng định dạng ISO 8601.');
      const ahead = scheduledAt.getTime() - Date.now();
      if (ahead < -MINUTE) throw new BadRequestException('Giờ hẹn đã qua — chọn giờ trong tương lai hoặc đăng ngay.');
      if (ahead > MAX_SCHEDULE_AHEAD_MS) throw new BadRequestException('Chỉ hẹn trước tối đa 90 ngày.');
      if (ahead <= 0) scheduledAt = null;
    }
    const targets = input.targets ?? [];
    if (targets.length === 0) throw new BadRequestException('Chọn ít nhất một kênh.');
    if (targets.length > MAX_TARGETS) throw new BadRequestException(`Tối đa ${MAX_TARGETS} kênh mỗi bài.`);
    const ids = [...new Set(targets.map((t) => t.account_id))];
    if (ids.length !== targets.length) throw new BadRequestException('Mỗi kênh chỉ chọn một lần.');
    const accounts = await this.prisma.socialAccount.findMany({ where: { id: { in: ids } } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const resolved: Array<{ account: (typeof accounts)[number]; caption: string | null; options: Record<string, unknown> }> = targets.map((t) => {
      const a = byId.get(t.account_id);
      if (!a || a.status === 'disabled') throw new BadRequestException(`Không tìm thấy kênh #${t.account_id}.`);
      if (a.status !== 'active') throw new BadRequestException(`Kênh "${a.name}" cần liên kết lại trước khi đăng.`);
      if (!isSocialNetwork(a.network)) throw new BadRequestException(`Kênh "${a.name}" không hợp lệ.`);
      const p = this.providers.get(a.network);
      if (!p.supported) throw new BadRequestException(`${NETWORK_LABELS[a.network]} chưa hỗ trợ đăng bài.`);
      const caption = typeof t.caption === 'string' && t.caption.trim() ? t.caption.trim() : null;
      const text = caption ?? content;
      const bad = p.validateMedia(media);
      if (bad) throw new BadRequestException(bad);
      const { utm: rawUtm, ...rest } = t.options && typeof t.options === 'object' && !Array.isArray(t.options) ? t.options : ({} as Record<string, unknown>);
      let utm: UtmInput | null;
      try {
        utm = normalizeUtm(input.utm !== undefined ? input.utm : rawUtm);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      const options: Record<string, unknown> = utm ? { ...rest, utm: { source: a.network, medium: 'social', ...utm } } : rest;
      // Giới hạn ký tự tính trên nội dung SAU khi gắn UTM (liên kết dài ra); nội dung lưu vẫn sạch.
      const sent = applyUtmToTarget(a.network, text, options);
      if (sent.text.length > CAPTION_LIMITS[a.network]) throw new BadRequestException(`${a.name}: nội dung dài ${sent.text.length} ký tự${utm ? ' (đã tính tham số UTM)' : ''}, ${NETWORK_LABELS[a.network]} cho tối đa ${CAPTION_LIMITS[a.network]}.`);
      const badOpt = p.validateOptions?.(sent.text, sent.options);
      if (badOpt) throw new BadRequestException(badOpt);
      return { account: a, caption, options };
    });
    // YouTube: ảnh thumbnail chọn từ thư viện ⇒ kiểm quyền + định dạng ngay khi tạo bài, lưu sẵn thông tin tệp để lúc đăng nạp lại.
    // `options.thumbnail` CHỈ do máy chủ đặt từ `thumbnail_key` đã kiểm — bỏ mọi giá trị người gọi tự gửi (không thì đọc được
    // tệp bất kỳ trong kho lưu trữ rồi đăng công khai làm thumbnail).
    for (const r of resolved) {
      const { thumbnail: _ignored, thumbnail_key: key, ...rest } = r.options;
      r.options = rest;
      if (r.account.network !== 'youtube' || key === undefined || key === null || key === '') continue;
      if (typeof key !== 'string') throw new BadRequestException('YouTube: thumbnail_key không hợp lệ.');
      const [img] = await this.media.resolve(user, [key]);
      if (!img || img.type !== 'image' || !['image/jpeg', 'image/png'].includes(img.content_type)) throw new BadRequestException('YouTube: ảnh thumbnail phải là ảnh JPG hoặc PNG trong thư viện.');
      if (img.size > 2 * 1024 * 1024) throw new BadRequestException('YouTube: ảnh thumbnail tối đa 2 MB.');
      r.options = { ...rest, thumbnail: { key: img.key, type: img.type, content_type: img.content_type, size: img.size } };
    }
    // Facebook — bình luận đầu tiên đăng bằng token của kết nối "Fanpage Facebook" có quyền bình luận: kiểm ngay lúc tạo bài
    // (không để bài báo "đã đăng" mà bình luận lặng lẽ không lên).
    for (const r of resolved) {
      if (r.account.network !== 'facebook' || !firstCommentOf(r.options)) continue;
      if (!commentAutomationEnabled()) throw new BadRequestException('Bình luận đầu tiên cần bật quyền bình luận Fanpage trên máy chủ (FACEBOOK_COMMENT_AUTOMATION) rồi kết nối lại Fanpage ở Cài đặt › Kết nối › Fanpage Facebook.');
      const page = await this.prisma.facebookPage.findFirst({ where: { page_id: r.account.external_id, is_active: true }, select: { id: true } });
      if (!page) throw new BadRequestException(`Bình luận đầu tiên: Fanpage "${r.account.name}" chưa kết nối ở Cài đặt › Kết nối › Fanpage Facebook.`);
    }
    return { content, media, scheduledAt, targets: resolved };
  }

  /**
   * Xem trước từng kênh — đúng chữ `processOne` sẽ gửi (sau UTM), KHÔNG ghi gì, KHÔNG giữ khung hàng đợi. Khác `validate`: lỗi
   * giới hạn/tệp/quyền không ném mà gom vào `warnings` để người soạn vừa xem vừa sửa. Chỉ ném khi đầu vào không dùng được (không kênh nào).
   */
  /** Kết quả kiểm tệp cho bản xem trước, nhớ 60 giây theo người dùng + khoá: gõ chữ (debounce) không gọi storage mỗi lần. */
  private readonly previewMediaCache = new Map<string, { m: SocialMedia; at: number }>();

  private async previewMedia(user: AuthUser, keys: string[]): Promise<SocialMedia[]> {
    const now = Date.now();
    const id = (k: string) => `${user.userId}:${k}`;
    for (const [k, v] of this.previewMediaCache) if (now - v.at > 60_000) this.previewMediaCache.delete(k);
    const missing = keys.filter((k) => !this.previewMediaCache.has(id(k)));
    if (missing.length) for (const m of await this.media.resolve(user, missing)) this.previewMediaCache.set(id(m.key), { m, at: now });
    return keys.map((k) => this.previewMediaCache.get(id(k))?.m).filter((m): m is SocialMedia => Boolean(m));
  }

  async preview(user: AuthUser, input: CreatePostInput): Promise<PostPreview> {
    const content = (input.content ?? '').trim();
    const targets = Array.isArray(input.targets) ? input.targets : [];
    if (targets.length === 0) throw new BadRequestException('Chọn ít nhất một kênh.');
    if (targets.length > MAX_TARGETS) throw new BadRequestException(`Tối đa ${MAX_TARGETS} kênh mỗi bài.`);
    const general: string[] = [];
    const allKeys = [...new Set((input.media_keys ?? []).map((k) => k.trim()).filter(Boolean))];
    if (allKeys.length > MAX_MEDIA_PER_POST) general.push(`Tối đa ${MAX_MEDIA_PER_POST} tệp mỗi bài.`);
    const keys = allKeys.slice(0, MAX_MEDIA_PER_POST);
    let media: SocialMedia[] = [];
    try {
      media = keys.length ? await this.previewMedia(user, keys) : [];
    } catch (e) {
      // Lỗi kiểm tệp của người dùng (400…) thì hiện; lỗi hạ tầng (storage, mạng) không lộ chi tiết nội bộ.
      const status = (e as { status?: number }).status;
      general.push(typeof status === 'number' && status < 500 ? (e as Error).message : 'Không kiểm tra được tệp đính kèm lúc này — thử lại sau.');
    }
    if (!content && media.length === 0) general.push('Bài cần có nội dung hoặc ảnh/video.');
    // Giờ đăng: chỉ đọc khung trống (nextFree không giữ chỗ).
    let scheduledAt: Date | null = null;
    let fromQueue = false;
    if (input.use_queue && input.scheduled_at) general.push('Chỉ chọn một: vào hàng đợi (use_queue) hoặc giờ hẹn cụ thể (scheduled_at).');
    else if (input.use_queue) {
      const [slot] = (await this.queue?.nextFree(1)) ?? [];
      if (slot) {
        scheduledAt = slot;
        fromQueue = true;
      } else general.push(NO_QUEUE_SLOTS);
    } else if (input.scheduled_at) {
      const d = new Date(input.scheduled_at);
      const ahead = d.getTime() - Date.now();
      if (Number.isNaN(d.getTime())) general.push('scheduled_at không đúng định dạng ISO 8601.');
      else if (ahead < -MINUTE) general.push('Giờ hẹn đã qua — chọn giờ trong tương lai hoặc đăng ngay.');
      else if (ahead > MAX_SCHEDULE_AHEAD_MS) general.push('Chỉ hẹn trước tối đa 90 ngày.');
      else if (ahead > 0) scheduledAt = d;
    }
    const accounts = await this.prisma.socialAccount.findMany({ where: { id: { in: [...new Set(targets.map((t) => t.account_id))] } } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const seen = new Set<number>();
    const out: TargetPreview[] = [];
    for (const t of targets) {
      const a = byId.get(t.account_id);
      const warnings: string[] = [];
      if (seen.has(t.account_id)) warnings.push('Kênh này được chọn nhiều lần — mỗi kênh chỉ chọn một lần.');
      seen.add(t.account_id);
      if (!a || a.status === 'disabled' || !isSocialNetwork(a.network)) {
        // Kênh đã gỡ / không dùng được: như validate — coi là không có, không trả tên/mạng thật.
        out.push({ account_id: t.account_id, account_name: `#${t.account_id}`, network: null, text: '', title: null, description: null, first_comment: null, length: 0, limit: null, truncated_at: null, media: [], warnings: [...warnings, `Không tìm thấy kênh #${t.account_id}.`] });
        continue;
      }
      const network = a.network;
      if (a.status !== 'active') warnings.push(`Kênh "${a.name}" cần liên kết lại trước khi đăng.`);
      const p = this.providers.get(network);
      if (!p.supported) warnings.push(`${NETWORK_LABELS[network]} chưa hỗ trợ đăng bài.`);
      const caption = typeof t.caption === 'string' && t.caption.trim() ? t.caption.trim() : null;
      const { utm: rawUtm, ...rest } = t.options && typeof t.options === 'object' && !Array.isArray(t.options) ? t.options : ({} as Record<string, unknown>);
      let utm: UtmInput | null = null;
      try {
        utm = normalizeUtm(input.utm !== undefined ? input.utm : rawUtm);
      } catch (e) {
        warnings.push((e as Error).message);
      }
      // Giống validate: `thumbnail` chỉ do máy chủ đặt — bỏ giá trị người gọi gửi.
      const { thumbnail: _ignored, ...clean } = rest;
      const options: Record<string, unknown> = utm ? { ...clean, utm: { source: network, medium: 'social', ...utm } } : clean;
      const sent = applyUtmToTarget(network, caption ?? content, options);
      const limit = CAPTION_LIMITS[network];
      if (sent.text.length > limit) warnings.push(`${a.name}: nội dung dài ${sent.text.length} ký tự${utm ? ' (đã tính tham số UTM)' : ''}, ${NETWORK_LABELS[network]} cho tối đa ${limit}.`);
      const badMedia = p.validateMedia(media);
      if (badMedia) warnings.push(badMedia);
      const badOpt = p.validateOptions?.(sent.text, sent.options);
      if (badOpt) warnings.push(badOpt);
      const isYt = network === 'youtube';
      const description = isYt ? (typeof sent.options.description === 'string' && sent.options.description.trim() ? (sent.options.description as string) : sent.text).replace(/[<>]/g, '') : null;
      const firstComment = network === 'facebook' ? firstCommentOf(sent.options) : null;
      if (firstComment && !commentAutomationEnabled()) warnings.push('Bình luận đầu tiên cần bật quyền bình luận Fanpage trên máy chủ (FACEBOOK_COMMENT_AUTOMATION).');
      out.push({
        account_id: a.id,
        account_name: a.name,
        network,
        text: sent.text,
        title: isYt ? youtubeTitle(sent.text, sent.options) : null,
        description,
        first_comment: firstComment,
        length: sent.text.length,
        limit,
        truncated_at: truncatedAt(network, description ?? sent.text),
        media: media.map((m) => ({ key: m.key, type: m.type })),
        warnings,
      });
    }
    return { scheduled_at: scheduledAt ? scheduledAt.toISOString() : null, from_queue: fromQueue, warnings: general, targets: out };
  }

  /** creator_info của một kênh TikTok cho màn soạn (TikTok yêu cầu hiện tên/ảnh và chỉ cho chọn đúng những gì tài khoản được phép). */
  async tiktokCreatorInfo(accountId: number): Promise<TiktokCreatorInfo> {
    const a = await this.prisma.socialAccount.findUnique({ where: { id: accountId } });
    if (!a || a.status === 'disabled' || a.network !== 'tiktok') throw new NotFoundException('Không tìm thấy kênh TikTok');
    if (a.status !== 'active') throw new BadRequestException(`Kênh "${a.name}" cần liên kết lại trước khi đăng.`);
    const p = this.providers.get('tiktok');
    if (!(p instanceof TiktokSocialProvider)) throw new BadRequestException('TikTok chưa hỗ trợ.');
    try {
      return await p.creatorInfo(await this.freshAccount(p, a));
    } catch (err) {
      if (!(err instanceof SocialPublishError)) throw err;
      if (err.kind === 'token') await this.accounts.markReauth(a.id, err.message);
      throw new BadRequestException(err.message);
    }
  }

  /** Kênh Google Business đang hoạt động + provider thật (chưa bật quyền API ⇒ 400 "chưa hỗ trợ"). */
  private async gbp(accountId: number) {
    const a = await this.prisma.socialAccount.findUnique({ where: { id: accountId } });
    if (!a || a.status === 'disabled' || a.network !== 'google_business') throw new NotFoundException('Không tìm thấy hồ sơ Google Business');
    if (a.status !== 'active') throw new BadRequestException(`Kênh "${a.name}" cần liên kết lại.`);
    const p = this.providers.get('google_business');
    if (!(p instanceof GoogleBusinessSocialProvider)) throw new BadRequestException('Google Business Profile chưa bật trên máy chủ này (chờ Google cấp quyền API).');
    return { a, p };
  }

  private async gbpCall<T>(accountId: number, fn: (p: GoogleBusinessSocialProvider, acc: AccountForPublish) => Promise<T>): Promise<T> {
    const { a, p } = await this.gbp(accountId);
    try {
      return await fn(p, await this.freshAccount(p, a));
    } catch (err) {
      if (!(err instanceof SocialPublishError)) throw err;
      if (err.kind === 'token') await this.accounts.markReauth(a.id, err.message);
      throw new BadRequestException(err.message);
    }
  }

  /** Playlist của một kênh YouTube (để chọn khi đăng). */
  async youtubePlaylists(accountId: number): Promise<Array<{ id: string; title: string }>> {
    const a = await this.prisma.socialAccount.findUnique({ where: { id: accountId } });
    if (!a || a.status === 'disabled' || a.network !== 'youtube') throw new NotFoundException('Không tìm thấy kênh YouTube');
    if (a.status !== 'active') throw new BadRequestException(`Kênh "${a.name}" cần liên kết lại.`);
    const p = this.providers.get('youtube');
    if (!(p instanceof YoutubeSocialProvider)) throw new BadRequestException('YouTube chưa hỗ trợ.');
    try {
      return await p.listPlaylists(await this.freshAccount(p, a));
    } catch (err) {
      if (!(err instanceof SocialPublishError)) throw err;
      if (err.kind === 'token') await this.accounts.markReauth(a.id, err.message);
      throw new BadRequestException(err.message);
    }
  }

  /** Đánh giá Google của một địa điểm (đọc thẳng từ Google, không lưu bản sao). */
  async gbpReviews(accountId: number, pageToken?: string): Promise<{ reviews: GbpReview[]; average: number | null; total: number; next_page_token: string | null }> {
    return this.gbpCall(accountId, (p, acc) => p.listReviews(acc, pageToken));
  }

  /** Trả lời công khai một đánh giá Google (gửi lại = sửa câu trả lời). */
  async gbpReply(accountId: number, reviewId: string, comment: string, user: AuthUser) {
    const r = await this.gbpCall(accountId, (p, acc) => p.replyReview(acc, reviewId, comment));
    this.logger.log(`Trả lời đánh giá Google (kênh ${accountId}) bởi user ${user.userId}`);
    return r;
  }

  /** `opts.inTx`: việc ghi thêm trong CÙNG transaction tạo bài (vd gắn nháp ↔ bài) — lỗi thì bài cũng không được tạo. */
  /**
   * `opts.dedupeSource`: khoá duy nhất của lần tạo (vd một dòng nhập CSV) — ghi vào `source`; đã có bài mang khoá này ⇒ 409, không tạo lần hai
   * (khoá advisory trong cùng transaction ⇒ hai lượt gửi lặp chạy song song cũng chỉ một lượt tạo được).
   */
  async create(user: AuthUser, input: CreatePostInput, opts: { inTx?: (tx: Prisma.TransactionClient, postId: number) => Promise<void>; dedupeSource?: string } = {}): Promise<PostWithTargets> {
    // Vào hàng đợi: chọn khung trống gần nhất ngay lúc tạo (không có khung ⇒ 400).
    if (input.use_queue && input.scheduled_at) throw new BadRequestException('Chỉ chọn một: vào hàng đợi (use_queue) hoặc giờ hẹn cụ thể (scheduled_at).');
    if (input.use_queue) {
      const [slot] = (await this.queue?.nextFree(1)) ?? [];
      if (!slot) throw new BadRequestException(NO_QUEUE_SLOTS);
      input = { ...input, scheduled_at: slot.toISOString() };
    }
    const v = await this.validate(user, input);
    const now = new Date();
    const post = await this.prisma.$transaction(async (tx) => {
      if (opts.dedupeSource) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${opts.dedupeSource}))`;
        if (await tx.socialPost.findFirst({ where: { source: opts.dedupeSource }, select: { id: true } })) throw new ConflictException(ALREADY_CREATED);
        input = { ...input, source: opts.dedupeSource };
      }
      const p = await tx.socialPost.create({
        data: {
          content: v.content,
          media: v.media as unknown as Prisma.InputJsonValue,
          scheduled_at: v.scheduledAt,
          status: v.scheduledAt ? 'scheduled' : 'publishing',
          source: (input.source ?? 'web').slice(0, 80),
          created_by: user.userId,
        },
      });
      await tx.socialPostTarget.createMany({
        data: v.targets.map((t) => ({
          post_id: p.id,
          account_id: t.account.id,
          network: t.account.network,
          caption: t.caption,
          options: t.options as Prisma.InputJsonValue,
          next_attempt_at: v.scheduledAt ?? now,
        })),
      });
      if (opts.inTx) await opts.inTx(tx, p.id);
      return p;
    });
    trackProductEvent('post_published', user.userId, {
      networks: [...new Set(v.targets.map((t) => String(t.account.network)))].sort().join(','),
      scheduled: Boolean(v.scheduledAt),
      source: post.source.startsWith('mcp') ? 'mcp' : post.source.startsWith('csv') ? 'csv' : 'web',
    });
    if (!v.scheduledAt) this.kick();
    return this.get(post.id);
  }

  /** Bài còn sửa được: đang hẹn giờ, còn hơn 1 phút mới tới giờ, mọi kênh chưa huỷ đều còn chờ (chưa kênh nào bắt đầu đăng). */
  async editable(id: number) {
    const p = await this.prisma.socialPost.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Không tìm thấy bài');
    const targets = await this.prisma.socialPostTarget.findMany({ where: { post_id: id } });
    const live = targets.filter((t) => t.status !== 'cancelled');
    if (!p.scheduled_at || live.length === 0 || live.some((t) => t.status !== 'queued')) {
      throw new BadRequestException('Chỉ sửa được bài đang hẹn giờ mà chưa kênh nào bắt đầu đăng.');
    }
    if (p.scheduled_at.getTime() <= Date.now() + MINUTE) throw new BadRequestException('Bài sắp tới giờ đăng — không sửa được nữa. Huỷ bài nếu cần.');
    return { post: p, live };
  }

  /** Giờ hẹn mới: ISO, sau bây giờ ít nhất 1 phút, trong 90 ngày. */
  newSchedule(at: unknown): Date {
    const d = typeof at === 'string' ? new Date(at) : null;
    if (!d || Number.isNaN(d.getTime())) throw new BadRequestException('scheduled_at không đúng định dạng ISO 8601.');
    const ahead = d.getTime() - Date.now();
    if (ahead <= MINUTE) throw new BadRequestException('Giờ hẹn phải sau bây giờ ít nhất 1 phút (muốn đăng ngay thì huỷ bài rồi tạo bài mới).');
    if (ahead > MAX_SCHEDULE_AHEAD_MS) throw new BadRequestException('Chỉ hẹn trước tối đa 90 ngày.');
    return d;
  }

  /**
   * Sửa bài đang hẹn giờ: nội dung, tệp, giờ, danh sách kênh và tuỳ chọn từng kênh — kiểm lại như lúc tạo. Thay toàn bộ các
   * kênh còn chờ trong một transaction; kênh nào vừa bị job nhận đăng (không còn `queued`) ⇒ 409, không đổi gì.
   */
  /** `expectUpdatedAt`: bài phải còn đúng bản này (người gọi đã ghép phần sửa vào bản đó) — có ai sửa chen ngang ⇒ 409, không ghi đè. */
  async update(user: AuthUser, id: number, input: CreatePostInput, opts: { expectUpdatedAt?: Date } = {}): Promise<PostWithTargets> {
    const { post, live } = await this.editable(id);
    const conflict = () => new ConflictException('Bài vừa được sửa ở nơi khác — xem lại bài rồi sửa lại.');
    if (opts.expectUpdatedAt && post.updated_at.getTime() !== opts.expectUpdatedAt.getTime()) throw conflict();
    const at = this.newSchedule(input.scheduled_at);
    const stored = (Array.isArray(post.media) ? post.media : []) as unknown as SocialMedia[];
    const v = await this.validate(user, { ...input, scheduled_at: at.toISOString() }, { keepMedia: stored });
    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.socialPostTarget.deleteMany({ where: { id: { in: live.map((t) => t.id) }, status: 'queued' } });
      if (removed.count !== live.length) throw new ConflictException('Bài vừa bắt đầu đăng — không sửa được nữa.');
      // Kênh từng huỷ nay chọn lại: xoá dòng đã huỷ (mỗi bài một dòng / kênh) rồi tạo mới bên dưới.
      await tx.socialPostTarget.deleteMany({ where: { post_id: id, status: 'cancelled', account_id: { in: v.targets.map((t) => t.account.id) } } });
      const data = { content: v.content, media: v.media as unknown as Prisma.InputJsonValue, scheduled_at: at, status: 'scheduled', updated_at: new Date() };
      if (opts.expectUpdatedAt) {
        const n = await tx.socialPost.updateMany({ where: { id, updated_at: opts.expectUpdatedAt }, data });
        if (n.count !== 1) throw conflict();
      } else await tx.socialPost.update({ where: { id }, data });
      await tx.socialPostTarget.createMany({
        data: v.targets.map((t) => ({ post_id: id, account_id: t.account.id, network: t.account.network, caption: t.caption, options: t.options as Prisma.InputJsonValue, next_attempt_at: at })),
      });
    });
    await this.refreshStatus(id);
    return this.get(id);
  }

  /** Chỉ đổi giờ hẹn (kéo-thả trên lịch). */
  async reschedule(id: number, scheduledAt: unknown): Promise<PostWithTargets> {
    const { live } = await this.editable(id);
    const at = this.newSchedule(scheduledAt);
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.socialPostTarget.updateMany({ where: { id: { in: live.map((t) => t.id) }, status: 'queued' }, data: { next_attempt_at: at } });
      if (moved.count !== live.length) throw new ConflictException('Bài vừa bắt đầu đăng — không đổi giờ được nữa.');
      await tx.socialPost.update({ where: { id }, data: { scheduled_at: at } });
    });
    return this.get(id);
  }

  async list(q: { status?: string; from?: string; to?: string; limit?: number; cursor?: number }) {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const where: Prisma.SocialPostWhereInput = {};
    if (q.status) where.status = q.status;
    const range: Prisma.DateTimeFilter = {};
    if (q.from && !Number.isNaN(Date.parse(q.from))) range.gte = new Date(q.from);
    if (q.to && !Number.isNaN(Date.parse(q.to))) range.lte = new Date(q.to);
    // Lịch: bài hẹn giờ theo giờ hẹn, bài đăng ngay theo giờ tạo.
    if (range.gte || range.lte) where.OR = [{ scheduled_at: range }, { scheduled_at: null, created_at: range }];
    if (q.cursor) where.id = { lt: q.cursor };
    const rows = await this.prisma.socialPost.findMany({ where, orderBy: { id: 'desc' }, take: limit + 1 });
    const page = rows.slice(0, limit);
    const data = await this.withTargets(page);
    return { data, next_cursor: rows.length > limit ? page[page.length - 1].id : null };
  }

  async get(id: number): Promise<PostWithTargets> {
    const p = await this.prisma.socialPost.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Không tìm thấy bài đăng');
    return (await this.withTargets([p]))[0];
  }

  private async withTargets(posts: SocialPost[]): Promise<PostWithTargets[]> {
    if (posts.length === 0) return [];
    const targets = await this.prisma.socialPostTarget.findMany({ where: { post_id: { in: posts.map((p) => p.id) } }, orderBy: { id: 'asc' } });
    const accounts = await this.prisma.socialAccount.findMany({ where: { id: { in: [...new Set(targets.map((t) => t.account_id))] } }, select: { id: true, name: true } });
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    return posts.map((p) => ({ ...p, targets: targets.filter((t) => t.post_id === p.id).map((t) => ({ ...t, account_name: names.get(t.account_id) ?? null })) }));
  }

  /** Huỷ các kênh chưa đăng của bài (bài đã lên mạng thì không gỡ ở đây). */
  async cancel(id: number): Promise<PostWithTargets> {
    const p = await this.get(id);
    const n = await this.prisma.socialPostTarget.updateMany({ where: { post_id: id, status: { in: ['queued', 'failed'] } }, data: { status: 'cancelled' } });
    if (n.count === 0 && !p.targets.some((t) => t.status === 'cancelled')) throw new BadRequestException('Không còn kênh nào chờ đăng để huỷ.');
    await this.refreshStatus(id);
    return this.get(id);
  }

  /** Thử lại một kênh bị lỗi (người dùng đã sửa quyền / liên kết lại). */
  async retry(targetId: number): Promise<PostWithTargets> {
    const t = await this.prisma.socialPostTarget.findUnique({ where: { id: targetId } });
    if (!t) throw new NotFoundException('Không tìm thấy kênh của bài');
    if (t.status !== 'failed') throw new BadRequestException('Chỉ thử lại được kênh đang báo lỗi.');
    const a = await this.prisma.socialAccount.findUnique({ where: { id: t.account_id } });
    if (!a || a.status !== 'active') throw new BadRequestException('Kênh cần liên kết lại trước khi thử lại.');
    await this.prisma.socialPostTarget.update({ where: { id: targetId }, data: { status: 'queued', attempts: 0, next_attempt_at: new Date(), last_error: null } });
    await this.refreshStatus(t.post_id);
    this.kick();
    return this.get(t.post_id);
  }

  /** Gỡ bài đã đăng khỏi mạng (nếu mạng cho phép). */
  async deleteRemote(targetId: number): Promise<PostWithTargets> {
    const t = await this.prisma.socialPostTarget.findUnique({ where: { id: targetId } });
    if (!t) throw new NotFoundException('Không tìm thấy kênh của bài');
    if (t.status !== 'published' || !t.external_post_id) throw new BadRequestException('Kênh này chưa có bài đã đăng để gỡ.');
    const a = await this.prisma.socialAccount.findUnique({ where: { id: t.account_id } });
    if (!a || a.status === 'disabled' || !isSocialNetwork(a.network)) throw new BadRequestException('Kênh đã bị gỡ khỏi Trinity — gỡ bài trực tiếp trên mạng.');
    const p = this.providers.get(a.network);
    if (!p.deletePost) throw new BadRequestException(`${NETWORK_LABELS[a.network]} không cho gỡ bài qua API — gỡ trực tiếp trên mạng.`);
    try {
      await p.deletePost(await this.freshAccount(p, a), t.external_post_id);
    } catch (err) {
      throw new BadRequestException(err instanceof SocialPublishError ? err.message : 'Gỡ bài không thành công.');
    }
    await this.prisma.socialPostTarget.update({ where: { id: targetId }, data: { status: 'cancelled', last_error: 'Đã gỡ bài khỏi mạng', url: null } });
    await this.refreshStatus(t.post_id);
    return this.get(t.post_id);
  }

  async refreshStatus(postId: number): Promise<void> {
    const post = await this.prisma.socialPost.findUnique({ where: { id: postId }, select: { scheduled_at: true } });
    if (!post) return;
    const targets = await this.prisma.socialPostTarget.findMany({ where: { post_id: postId }, select: { status: true } });
    const scheduled = Boolean(post.scheduled_at && post.scheduled_at.getTime() > Date.now());
    await this.prisma.socialPost.update({ where: { id: postId }, data: { status: aggregateStatus(targets, scheduled) } });
  }

  /**
   * Nhặt bài đến hạn (bài hẹn giờ, lượt thử lại) khi có người đang mở Trinity. Serverless không có timer, còn Vercel Cron
   * gói thường chỉ chạy mỗi ngày một lần, nên web gọi `POST social/tick` mỗi phút để bài hẹn lên đúng giờ.
   * Mỗi instance kiểm DB tối đa một lần mỗi 20 giây; không có việc đến hạn thì không làm gì.
   */
  /** Giờ của bài chờ đăng / chờ thử lại sớm nhất (null = không còn gì chờ) — web hẹn lượt tick kế tiếp đúng giờ này. */
  async nextDueAt(): Promise<Date | null> {
    const r = await this.prisma.socialPostTarget.aggregate({ where: { status: { in: ['queued', 'publishing'] } }, _min: { next_attempt_at: true } });
    return r._min.next_attempt_at ?? null;
  }

  async kickIfDue(now = Date.now()): Promise<{ due: boolean }> {
    if (this.running || now - this.lastDueCheck < 20_000) return { due: false };
    this.lastDueCheck = now;
    const at = new Date(now);
    const due = await this.prisma.socialPostTarget.findFirst({
      where: { OR: [{ status: 'queued', next_attempt_at: { lte: at } }, { status: 'publishing', next_attempt_at: { lte: at } }] },
      select: { id: true },
    });
    if (due) this.kick();
    return { due: Boolean(due) };
  }

  /** Đăng ngay sau request (serverless: giữ hàm sống tới khi xong; VPS: chạy nền). */
  kick(): void {
    runInBackground(
      () => this.runDue(40_000),
      (err) => this.logger.error(`Đăng bài nền lỗi: ${(err as Error)?.message}`),
    );
  }

  /**
   * Một lượt job: dọn việc kẹt → nhận từng việc đến hạn (`FOR UPDATE SKIP LOCKED`) → đăng → ghi kết quả.
   * Ngừng nhận việc mới khi đã dùng quá nửa ngân sách (video có thể mất nhiều chục giây). Không chạy chồng trong cùng process.
   */
  async runDue(budgetMs: number): Promise<{ published: number; failed: number; retry: number; stale: number }> {
    const out = { published: 0, failed: 0, retry: 0, stale: 0 };
    if (this.running) return out;
    this.running = true;
    const t0 = Date.now();
    try {
      out.stale = await this.sweepStale();
      while (Date.now() - t0 < budgetMs / 2) {
        const [row] = await this.claim(1);
        if (!row) break;
        const r = await this.processOne(row.id);
        out[r]++;
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  async claim(limit: number): Promise<ClaimedTarget[]> {
    return this.prisma.$queryRaw<ClaimedTarget[]>`
      UPDATE social_post_targets t
         SET status = 'publishing', attempts = t.attempts + 1, claimed_at = now(),
             next_attempt_at = now() + make_interval(secs => ${SOCIAL_LEASE_SECONDS}), updated_at = now()
       WHERE t.id IN (
         SELECT t2.id FROM social_post_targets t2
          WHERE t2.status = 'queued' AND t2.next_attempt_at <= now()
          ORDER BY t2.next_attempt_at ASC
          LIMIT ${limit}
          FOR UPDATE OF t2 SKIP LOCKED)
      RETURNING t.id`;
  }

  /** Việc "đang đăng" quá hạn giữ = tiến trình chết giữa chừng; không biết bài đã lên chưa nên báo lỗi để người dùng kiểm rồi bấm Thử lại. */
  async sweepStale(): Promise<number> {
    const stale = await this.prisma.socialPostTarget.findMany({ where: { status: 'publishing', next_attempt_at: { lte: new Date() } }, select: { id: true, post_id: true } });
    if (stale.length === 0) return 0;
    await this.prisma.socialPostTarget.updateMany({
      where: { id: { in: stale.map((s) => s.id) }, status: 'publishing' },
      data: { status: 'failed', last_error: 'Bị gián đoạn khi đang đăng — kiểm trên kênh xem bài đã lên chưa, rồi mới bấm Thử lại.' },
    });
    for (const postId of new Set(stale.map((s) => s.post_id))) await this.refreshStatus(postId);
    return stale.length;
  }

  /** Lấy số của các bài đến hạn (job định kỳ). Lỗi một bài không chặn bài khác; lần lấy được ghi `metrics_at` cả khi lỗi. */
  async refreshMetricsDue(budgetMs: number, now = Date.now()): Promise<{ updated: number; failed: number }> {
    const started = Date.now();
    const rows = await this.prisma.socialPostTarget.findMany({
      where: {
        status: 'published',
        external_post_id: { not: null },
        published_at: { gte: new Date(now - METRICS_WINDOW_MS) },
        OR: [{ metrics_at: null }, { metrics_at: { lt: new Date(now - 60 * MINUTE) } }],
      },
      orderBy: [{ metrics_at: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: 40,
    });
    let updated = 0;
    let failed = 0;
    for (const t of rows) {
      if (Date.now() - started > budgetMs) break;
      if (!t.published_at || !metricsDue(t.published_at, t.metrics_at, now) || isRemoved(t)) continue;
      if (await this.fetchTargetMetrics(t)) updated++;
      else failed++;
    }
    return { updated, failed };
  }

  /** Bấm "Cập nhật số" trên một bài: lấy ngay mọi kênh đã đăng (bỏ qua kênh vừa lấy dưới 1 phút). */
  async refreshPostMetrics(postId: number): Promise<PostWithTargets> {
    return (await this.refreshPostMetricsReport(postId)).post;
  }

  /** Như `refreshPostMetrics` nhưng báo kênh nào lấy số không được (số hiện ra là của lần lấy trước). */
  async refreshPostMetricsReport(postId: number): Promise<{ post: PostWithTargets; failed: number[]; throttled: number[] }> {
    const p = await this.get(postId);
    const now = Date.now();
    const failed: number[] = [];
    // Vừa thử dưới 1 phút trước (thành công hay lỗi đều đóng mốc metrics_at) ⇒ không gọi mạng lại, báo riêng để không hiểu nhầm là số mới.
    const throttled: number[] = [];
    for (const t of p.targets) {
      if (t.status !== 'published' || !t.external_post_id || isRemoved(t)) continue;
      if (t.metrics_at && now - t.metrics_at.getTime() < MINUTE) {
        throttled.push(t.id);
        continue;
      }
      if (!(await this.fetchTargetMetrics(t))) failed.push(t.id);
    }
    return { post: await this.get(postId), failed, throttled };
  }

  private async fetchTargetMetrics(t: SocialPostTarget): Promise<boolean> {
    const stamp = () => this.prisma.socialPostTarget.update({ where: { id: t.id }, data: { metrics_at: new Date() } });
    const account = await this.prisma.socialAccount.findUnique({ where: { id: t.account_id } });
    if (!account || account.status !== 'active' || !isSocialNetwork(account.network) || !t.external_post_id) {
      await stamp();
      return false;
    }
    const provider = this.providers.get(account.network);
    if (!provider.fetchMetrics) {
      await stamp();
      return false;
    }
    try {
      const m = await provider.fetchMetrics(await this.freshAccount(provider, account), t.external_post_id);
      await this.prisma.socialPostTarget.update({ where: { id: t.id }, data: { metrics: m as unknown as Prisma.InputJsonValue, metrics_at: new Date() } });
      return true;
    } catch (err) {
      if (err instanceof SocialPostGoneError) {
        // Bài đã bị xoá trên kênh: giữ số lần lấy cuối (nếu có), gắn cờ để thôi lấy và giao diện hiện "đã bị xoá".
        const last = storedMetrics(t) ?? { views: null, reactions: null, comments: null, shares: null };
        await this.prisma.socialPostTarget.update({ where: { id: t.id }, data: { metrics: { ...last, removed: true } as unknown as Prisma.InputJsonValue, metrics_at: new Date() } });
        return false;
      }
      // Không đánh dấu kênh cần liên kết lại ở đây: lỗi lấy số không được làm hỏng việc đăng bài.
      this.logger.warn(`Lấy số target ${t.id} (${account.network}) lỗi: ${(err as Error)?.message}`);
      await stamp();
      return false;
    }
  }

  /**
   * Thống kê bài đã đăng trong khoảng ngày (theo giờ đăng lên mạng): tổng, theo kênh, bài tương tác cao nhất.
   * Số là lần lấy gần nhất (`updated_at`), không gọi mạng.
   */
  async stats(q: { from: Date; to: Date; top?: number }) {
    const targets = await this.prisma.socialPostTarget.findMany({
      where: { status: 'published', published_at: { gte: q.from, lte: q.to } },
      orderBy: { published_at: 'desc' },
    });
    const posts = await this.prisma.socialPost.findMany({ where: { id: { in: [...new Set(targets.map((t) => t.post_id))] } }, select: { id: true, content: true } });
    const accounts = await this.prisma.socialAccount.findMany({ where: { id: { in: [...new Set(targets.map((t) => t.account_id))] } }, select: { id: true, name: true } });
    const content = new Map(posts.map((p) => [p.id, p.content]));
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    // Bài đã xoá trên kênh mà chưa từng lấy được số ⇒ coi như không có số (đếm riêng ở `removed`).
    const metricsOf = (t: SocialPostTarget) => {
      const m = storedMetrics(t);
      return m && !(m.removed && m.views === null && m.reactions === null && m.comments === null && m.shares === null) ? m : null;
    };
    const byAccount = new Map<number, SocialPostTarget[]>();
    for (const t of targets) byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t]);
    const stamps = targets.map((t) => t.metrics_at?.getTime() ?? 0).filter(Boolean);
    return {
      from: q.from,
      to: q.to,
      totals: { posts: new Set(targets.map((t) => t.post_id)).size, published: targets.length, ...sumMetrics(targets.map(metricsOf)) },
      by_account: [...byAccount.entries()].map(([id, list]) => ({
        account_id: id,
        account_name: names.get(id) ?? null,
        network: list[0].network,
        published: list.length,
        /** Số lượt đăng đã lấy được số; 0 ⇒ giao diện hiện "—" thay vì 0. */
        with_metrics: list.filter((t) => metricsOf(t)).length,
        ...sumMetrics(list.map(metricsOf)),
      })),
      top: targets
        .filter((t) => metricsOf(t))
        .sort((a, b) => engagementOf(metricsOf(b)) - engagementOf(metricsOf(a)) || (metricsOf(b)?.views ?? 0) - (metricsOf(a)?.views ?? 0))
        .slice(0, Math.min(Math.max(q.top ?? 5, 1), 20))
        .map((t) => ({
          post_id: t.post_id,
          target_id: t.id,
          account_name: names.get(t.account_id) ?? null,
          network: t.network,
          content: (content.get(t.post_id) ?? '').slice(0, 160),
          url: t.url,
          published_at: t.published_at,
          metrics: metricsOf(t),
          engagement: engagementOf(metricsOf(t)),
          removed: isRemoved(t),
        })),
      /** Bài chưa lấy được số lần nào (vừa đăng, hoặc mạng chưa cho lấy). */
      without_metrics: targets.filter((t) => !metricsOf(t) && !isRemoved(t)).length,
      /** Lượt đăng mà bài/video đã bị xoá trên kênh. */
      removed: targets.filter(isRemoved).length,
      updated_at: stamps.length ? new Date(Math.max(...stamps)) : null,
    };
  }

  /** Giải mã token; token sắp hết hạn (YouTube: 1 giờ) thì làm mới và lưu lại trước khi gọi mạng. */
  private async freshAccount(provider: SocialProvider, account: Parameters<SocialAccountsService['forPublish']>[0]): Promise<AccountForPublish> {
    const acc = this.accounts.forPublish(account);
    if (!provider.refresh || !acc.token_expires_at || acc.token_expires_at.getTime() >= Date.now() + 5 * MINUTE) return acc;
    const fresh = await provider.refresh(acc);
    if (!fresh) return acc;
    await this.accounts.saveRefreshed(account.id, fresh);
    return { ...acc, access_token: fresh.access_token, refresh_token: fresh.refresh_token ?? acc.refresh_token, token_expires_at: fresh.token_expires_at ?? null };
  }

  /** Webhook ra ngoài cho một lượt đăng (lỗi phát sự kiện không làm hỏng việc đăng). */
  private async publishEvent(t: SocialPostTarget, type: 'social_post.published' | 'social_post.failed', url: string | null, error: string | null): Promise<void> {
    await publishIntegrationEvent(
      this.prisma,
      type,
      { post_id: t.post_id, target_id: t.id, network: t.network, account_id: t.account_id, url, error },
      { resourceId: t.id, actorUserId: null },
    ).catch((e) => this.logger.warn(`Sự kiện webhook đăng bài lỗi: ${(e as Error).message}`));
  }

  async processOne(targetId: number): Promise<'published' | 'failed' | 'retry'> {
    const t = await this.prisma.socialPostTarget.findUnique({ where: { id: targetId } });
    if (!t) return 'failed';
    const fail = async (message: string): Promise<'failed'> => {
      await this.prisma.socialPostTarget.update({ where: { id: t.id }, data: { status: 'failed', last_error: message.slice(0, 500) } });
      await this.refreshStatus(t.post_id);
      await this.publishEvent(t, 'social_post.failed', null, message.slice(0, 500));
      return 'failed';
    };
    const [post, account] = await Promise.all([
      this.prisma.socialPost.findUnique({ where: { id: t.post_id } }),
      this.prisma.socialAccount.findUnique({ where: { id: t.account_id } }),
    ]);
    if (!post) return fail('Bài đăng không còn.');
    if (!account || account.status !== 'active' || !isSocialNetwork(account.network)) return fail('Kênh cần liên kết lại (hoặc đã bị gỡ).');
    const provider = this.providers.get(account.network);
    try {
      const acc = await this.freshAccount(provider, account);
      const media = (Array.isArray(post.media) ? post.media : []) as unknown as SocialMedia[];
      // UTM gắn ngay trước khi gọi mạng: bài lưu trong CRM vẫn là bản sạch.
      const sent = applyUtmToTarget(account.network, t.caption ?? post.content, (t.options && typeof t.options === 'object' ? t.options : {}) as Record<string, unknown>);
      const res = await provider.publish(acc, {
        text: sent.text,
        media,
        options: sent.options,
        load: (m) => this.media.load(m),
        publicUrl: (m) => `${socialBaseUrl() ?? ''}/api/v1/social/media-link/${signMediaLink(m)}/tep.${mediaLinkExt(m.content_type)}`,
      });
      await this.prisma.socialPostTarget.update({
        where: { id: t.id },
        data: { status: 'published', external_post_id: res.external_post_id.slice(0, 120), url: res.url, published_at: new Date(), last_error: null },
      });
      await this.refreshStatus(t.post_id);
      await this.publishEvent(t, 'social_post.published', res.url ?? null, null);
      // Facebook: bình luận đầu tiên (tuỳ chọn) — lỗi không làm hỏng bài đã lên.
      const firstComment = account.network === 'facebook' ? firstCommentOf(sent.options) : null;
      if (firstComment) {
        // Lỗi ⇒ ghi lên kênh (bài vẫn "đã đăng") để người dùng thấy bình luận chưa lên.
        const note = await postFirstComment(this.prisma, account.external_id, res.external_post_id, firstComment)
          .then((r) => (r === 'no_page' ? `Fanpage ${account.name} không còn kết nối ở mục Fanpage Facebook` : null))
          .catch((e: Error) => e.message);
        if (note) {
          this.logger.warn(`Bài ${t.post_id}: bình luận đầu tiên — ${note}`);
          await this.prisma.socialPostTarget.update({ where: { id: t.id }, data: { last_error: `Bài đã lên; chưa đăng được bình luận đầu tiên: ${note}`.slice(0, 500) } }).catch(() => undefined);
        }
      }
      return 'published';
    } catch (err) {
      const e =
        err instanceof SocialPublishError
          ? err
          : err instanceof HttpException
            ? new SocialPublishError('invalid', err.message)
            : new SocialPublishError('temporary', `Lỗi máy chủ khi đăng (${(err as Error)?.message ?? 'không rõ'}).`);
      this.logger.warn(`Đăng target ${t.id} (${account.network}) lỗi ${e.kind}: ${e.message}`);
      if (e.kind === 'token') {
        await this.accounts.markReauth(account.id, e.message);
        return fail(e.message);
      }
      // Serverless không có nhịp chạy nền thường xuyên ⇒ không tự thử lại; người dùng bấm Thử lại (retry_social_post_target).
      const delay = isServerless() ? undefined : SOCIAL_RETRY_DELAYS_MS[t.attempts - 1];
      if (e.retryable && delay !== undefined) {
        await this.prisma.socialPostTarget.update({
          where: { id: t.id },
          data: { status: 'queued', next_attempt_at: new Date(Date.now() + delay), last_error: `${e.message} Sẽ tự thử lại sau ${Math.round(delay / 60_000)} phút.`.slice(0, 500) },
        });
        await this.refreshStatus(t.post_id);
        return 'retry';
      }
      return fail(e.retryable ? `${e.message} Bấm Thử lại để đăng lại.` : e.message);
    }
  }
}
