import { Injectable } from '@nestjs/common';
import {
  SocialPublishError,
  type AccountForPublish,
  type ConnectedAccount,
  type PublishInput,
  type PublishResult,
  type RefreshedToken,
  type SocialMedia,
  type SocialProvider,
} from './provider.types';

/** Content Posting API — đăng thẳng (Direct Post). `user.info.basic` để lấy tên/ảnh tài khoản. */
export const TIKTOK_SOCIAL_SCOPES = ['user.info.basic', 'video.publish'] as const;

export const TIKTOK_PRIVACY = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'PUBLIC_TO_EVERYONE'] as const;
export type TiktokPrivacy = (typeof TIKTOK_PRIVACY)[number];

const API = 'https://open.tiktokapis.com/v2';
const MB = 1024 * 1024;
/** Quy tắc chia khúc: tệp < 5 MB tải nguyên; mỗi khúc 5–64 MB, khúc cuối gánh phần dư (tối đa 128 MB). */
const CHUNK = 10 * MB;
const SINGLE_MAX = 64 * MB;
/** Chờ TikTok xử lý tối đa chừng này trong lượt đăng; quá thì trả publish_id (bài vẫn tiếp tục lên). */
const STATUS_WAIT_MS = 20_000;

interface TiktokConfig {
  clientKey: string;
  clientSecret: string;
}

export function loadTiktokConfig(env: NodeJS.ProcessEnv = process.env): TiktokConfig {
  return { clientKey: env.TIKTOK_CLIENT_KEY?.trim() ?? '', clientSecret: env.TIKTOK_CLIENT_SECRET?.trim() ?? '' };
}

/** Quyền xem người đăng đã chọn; null = chưa chọn (TikTok cấm chọn sẵn thay người đăng). */
export function tiktokPrivacy(options: Record<string, unknown>): TiktokPrivacy | null {
  return (TIKTOK_PRIVACY as readonly unknown[]).includes(options.privacy_level) ? (options.privacy_level as TiktokPrivacy) : null;
}

/** Tuỳ chọn đăng TikTok sau khi chuẩn hoá. Tương tác mặc định TẮT; công bố thương mại mặc định không. */
export interface TiktokPostOptions {
  privacy_level: TiktokPrivacy | null;
  allow_comment: boolean;
  allow_duet: boolean;
  allow_stitch: boolean;
  /** Quảng bá thương hiệu của chính người đăng ⇒ TikTok gắn nhãn "Promotional content". */
  brand_organic: boolean;
  /** Hợp tác trả phí với bên thứ ba ⇒ nhãn "Paid partnership"; không được để Chỉ mình tôi. */
  brand_content: boolean;
  /** Thời lượng video (giây) do màn soạn đo được; dùng để đối chiếu giới hạn của tài khoản lúc đăng. */
  video_duration_sec: number | null;
}

export function tiktokOptions(options: Record<string, unknown>): TiktokPostOptions {
  const dur = Number(options.video_duration_sec);
  return {
    privacy_level: tiktokPrivacy(options),
    allow_comment: options.allow_comment === true,
    allow_duet: options.allow_duet === true,
    allow_stitch: options.allow_stitch === true,
    brand_organic: options.brand_organic === true,
    brand_content: options.brand_content === true,
    video_duration_sec: options.video_duration_sec != null && Number.isFinite(dur) && dur > 0 ? dur : null,
  };
}

/** Thông tin người đăng TikTok hiển thị ở màn soạn (creator_info). */
export interface TiktokCreatorInfo {
  nickname: string | null;
  username: string | null;
  avatar_url: string | null;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number | null;
}

/** Kế hoạch chia khúc theo quy tắc của TikTok. */
export function tiktokChunks(size: number): { chunk_size: number; total_chunk_count: number } {
  if (size <= SINGLE_MAX) return { chunk_size: size, total_chunk_count: 1 };
  return { chunk_size: CHUNK, total_chunk_count: Math.floor(size / CHUNK) };
}

interface TiktokApiError {
  error?: string | { code?: string; message?: string; log_id?: string };
  error_description?: string;
}

/** Lỗi TikTok (token endpoint `{error, error_description}` hoặc API `{error:{code,message}}`) → loại lỗi để job quyết định. */
export function classifyTiktokError(status: number, body: TiktokApiError): SocialPublishError {
  if (typeof body.error === 'string') {
    const msg = (body.error_description || body.error).slice(0, 300);
    if (body.error === 'invalid_grant' || status === 401) return new SocialPublishError('token', `TikTok: quyền truy cập đã hết hạn hoặc bị thu hồi — liên kết lại. (${msg})`);
    if (status >= 500) return new SocialPublishError('temporary', `TikTok tạm thời lỗi. (${msg})`);
    return new SocialPublishError('invalid', `TikTok từ chối: ${msg}`);
  }
  const code = body.error?.code ?? '';
  const msg = (body.error?.message || code || `HTTP ${status}`).slice(0, 300);
  if (status === 401 || code === 'access_token_invalid') return new SocialPublishError('token', `TikTok: phiên đăng nhập đã hết hạn — liên kết lại. (${msg})`);
  if (status === 429 || code === 'rate_limit_exceeded') return new SocialPublishError('rate', `TikTok giới hạn tần suất. (${msg})`);
  if (code === 'spam_risk_too_many_posts' || code === 'spam_risk_user_banned_from_posting' || code === 'reached_active_user_cap') {
    return new SocialPublishError('permission', `TikTok tạm chặn đăng từ tài khoản này. (${msg})`);
  }
  if (code === 'unaudited_client_can_only_post_to_private_accounts') {
    return new SocialPublishError('permission', 'TikTok: ứng dụng chưa qua kiểm duyệt nên chỉ đăng được chế độ "Chỉ mình tôi".');
  }
  if (code === 'scope_not_authorized' || code === 'scope_permission_missed' || status === 403) return new SocialPublishError('permission', `TikTok: thiếu quyền đăng video. (${msg})`);
  if (status >= 500 || code === 'internal_error') return new SocialPublishError('temporary', `TikTok tạm thời lỗi. (${msg})`);
  return new SocialPublishError('invalid', `TikTok từ chối video: ${msg}`);
}

interface CreatorInfo {
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

/**
 * Đăng video lên TikTok (Content Posting API, Direct Post, FILE_UPLOAD). Trước mỗi lần đăng gọi creator_info để kiểm
 * quyền xem người đăng chọn còn được phép và thời lượng video chưa vượt giới hạn tài khoản. Không có giá trị mặc định
 * cho quyền xem; bình luận/Duet/Stitch chỉ bật khi người đăng bật VÀ tài khoản cho phép (UX guidelines của TikTok).
 * TikTok không có API gỡ bài ⇒ không có deletePost. KHÔNG BAO GIỜ log token/secret.
 */
@Injectable()
export class TiktokSocialProvider implements SocialProvider {
  readonly network = 'tiktok' as const;
  readonly supported = true;
  readonly usesPkce = false;
  readonly envNames = ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'] as const;
  readonly scopes = TIKTOK_SOCIAL_SCOPES;

  configured(): boolean {
    const c = loadTiktokConfig();
    return Boolean(c.clientKey && c.clientSecret);
  }

  validateMedia(media: SocialMedia[]): string | null {
    const videos = media.filter((m) => m.type === 'video').length;
    if (videos !== 1 || media.length !== 1) return 'TikTok: mỗi bài cần đúng một video, không kèm ảnh.';
    return null;
  }

  validateOptions(_text: string, options: Record<string, unknown>): string | null {
    if (options.privacy_level === undefined || options.privacy_level === null || options.privacy_level === '') return 'TikTok: chọn ai được xem video.';
    if (!(TIKTOK_PRIVACY as readonly unknown[]).includes(options.privacy_level)) {
      return `TikTok: quyền xem phải là một trong ${TIKTOK_PRIVACY.join(', ')}.`;
    }
    const o = tiktokOptions(options);
    if (o.brand_content && o.privacy_level === 'SELF_ONLY') return 'TikTok: nội dung hợp tác có trả phí không được để chế độ Chỉ mình tôi.';
    return null;
  }

  /** creator_info cho màn soạn: tên/ảnh tài khoản, quyền xem được chọn, tương tác bị tắt, thời lượng tối đa. */
  async creatorInfo(account: AccountForPublish): Promise<TiktokCreatorInfo> {
    const i = await this.api<CreatorInfo>('POST', 'post/publish/creator_info/query/', account.access_token, {});
    return {
      nickname: i.creator_nickname ?? null,
      username: i.creator_username ?? null,
      avatar_url: i.creator_avatar_url ?? null,
      privacy_level_options: i.privacy_level_options ?? [],
      comment_disabled: Boolean(i.comment_disabled),
      duet_disabled: Boolean(i.duet_disabled),
      stitch_disabled: Boolean(i.stitch_disabled),
      max_video_post_duration_sec: typeof i.max_video_post_duration_sec === 'number' ? i.max_video_post_duration_sec : null,
    };
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const c = loadTiktokConfig();
    const q = new URLSearchParams({ client_key: c.clientKey, scope: this.scopes.join(','), response_type: 'code', redirect_uri: redirectUri, state });
    return `https://www.tiktok.com/v2/auth/authorize/?${q.toString()}`;
  }

  async exchange(code: string, redirectUri: string): Promise<ConnectedAccount[]> {
    const c = loadTiktokConfig();
    const t = await this.token({ client_key: c.clientKey, client_secret: c.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri });
    const granted = (t.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!granted.includes('video.publish')) throw new SocialPublishError('permission', 'Chưa cấp quyền đăng video lên TikTok — liên kết lại và đồng ý đủ quyền.');
    const u = await this.api<{ user?: { open_id?: string; display_name?: string; avatar_url?: string } }>('GET', 'user/info/?fields=open_id,display_name,avatar_url', t.access_token);
    const openId = u.user?.open_id || t.open_id;
    if (!openId) throw new SocialPublishError('invalid', 'TikTok không trả mã tài khoản.');
    return [
      {
        external_id: openId,
        name: u.user?.display_name || 'TikTok',
        avatar_url: u.user?.avatar_url ?? null,
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? null,
        token_expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
        scopes: granted,
      },
    ];
  }

  async refresh(account: AccountForPublish): Promise<RefreshedToken | null> {
    if (!account.refresh_token) throw new SocialPublishError('token', 'TikTok: thiếu refresh token — liên kết lại tài khoản.');
    const c = loadTiktokConfig();
    const t = await this.token({ client_key: c.clientKey, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: account.refresh_token });
    return { access_token: t.access_token, refresh_token: t.refresh_token ?? null, token_expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null };
  }

  async publish(account: AccountForPublish, input: PublishInput): Promise<PublishResult> {
    const video = input.media.find((m) => m.type === 'video');
    if (!video) throw new SocialPublishError('invalid', 'TikTok: bài không có video.');
    const token = account.access_token;
    const info = await this.api<CreatorInfo>('POST', 'post/publish/creator_info/query/', token, {});
    const o = tiktokOptions(input.options);
    // Bài tạo trước khi bắt buộc chọn quyền xem (hẹn giờ qua MCP lưu `{}`) giữ đúng mức đã nhận lúc tạo: Chỉ mình tôi.
    // Bài mới không tới được đây khi thiếu quyền xem — validateOptions chặn từ lúc tạo.
    const privacy = o.privacy_level ?? 'SELF_ONLY';
    if (o.brand_content && privacy === 'SELF_ONLY') throw new SocialPublishError('invalid', 'TikTok: nội dung hợp tác có trả phí không được để chế độ Chỉ mình tôi.');
    const max = info.max_video_post_duration_sec;
    if (typeof max === 'number' && o.video_duration_sec != null && o.video_duration_sec > max) {
      throw new SocialPublishError('invalid', `TikTok: video dài ${Math.round(o.video_duration_sec)} giây, tài khoản này đăng được tối đa ${max} giây.`);
    }
    const allowed = info.privacy_level_options ?? [];
    if (allowed.length && !allowed.includes(privacy)) {
      throw new SocialPublishError('invalid', `TikTok: tài khoản này không cho quyền xem ${privacy} (được: ${allowed.join(', ')}).`);
    }
    const f = await input.load(video);
    const size = f.body.length;
    const plan = tiktokChunks(size);
    const init = await this.api<{ publish_id: string; upload_url: string }>('POST', 'post/publish/video/init/', token, {
      post_info: {
        title: input.text,
        privacy_level: privacy,
        disable_comment: Boolean(info.comment_disabled) || !o.allow_comment,
        disable_duet: Boolean(info.duet_disabled) || !o.allow_duet,
        disable_stitch: Boolean(info.stitch_disabled) || !o.allow_stitch,
        brand_content_toggle: o.brand_content,
        brand_organic_toggle: o.brand_organic,
      },
      source_info: { source: 'FILE_UPLOAD', video_size: size, ...plan },
    });
    for (let i = 0; i < plan.total_chunk_count; i++) {
      const start = i * plan.chunk_size;
      const end = i === plan.total_chunk_count - 1 ? size : start + plan.chunk_size;
      const res = await this.fetch(init.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': f.content_type, 'Content-Range': `bytes ${start}-${end - 1}/${size}`, 'Content-Length': String(end - start) },
        body: new Uint8Array(f.body.subarray(start, end)),
      }, 120_000);
      if (!res.ok) throw classifyTiktokError(res.status, await safeJson(res));
    }
    // TikTok xử lý bất đồng bộ: chờ ngắn, bài riêng tư không có link công khai ⇒ trả publish_id.
    const deadline = Date.now() + STATUS_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      const s = await this.api<{ status?: string; fail_reason?: string; publicaly_available_post_id?: Array<string | number> }>('POST', 'post/publish/status/fetch/', token, {
        publish_id: init.publish_id,
      });
      if (s.status === 'FAILED') throw new SocialPublishError('invalid', `TikTok không đăng được video: ${s.fail_reason ?? 'không rõ lý do'}.`);
      const pub = s.publicaly_available_post_id?.[0];
      if (pub) return { external_post_id: String(pub), url: `https://www.tiktok.com/video/${pub}` };
      if (s.status === 'PUBLISH_COMPLETE') break;
    }
    return { external_post_id: init.publish_id, url: null };
  }

  private async token(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; open_id?: string; scope?: string }> {
    const res = await this.fetch(`${API}/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }, 20_000);
    const json = (await safeJson(res)) as { access_token?: string } & TiktokApiError;
    if (!res.ok || !json.access_token) throw classifyTiktokError(res.status, json);
    return json as { access_token: string };
  }

  private async api<T>(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=UTF-8';
    const res = await this.fetch(`${API}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, 20_000);
    const json = (await safeJson(res)) as { data?: T } & TiktokApiError;
    const err = json.error;
    if (!res.ok || (typeof err === 'object' && err?.code && err.code !== 'ok')) throw classifyTiktokError(res.status, json);
    return (json.data ?? {}) as T;
  }

  private async fetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new SocialPublishError('temporary', `Không gọi được TikTok (${(err as Error).name})`);
    }
  }
}

async function safeJson(res: Response): Promise<TiktokApiError & Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as TiktokApiError & Record<string, unknown>;
}
