import { Injectable, Logger } from '@nestjs/common';
import {
  SocialPostGoneError,
  SocialPublishError,
  type AccountForPublish,
  type ConnectedAccount,
  type PostMetrics,
  type PublishInput,
  type PublishResult,
  type RefreshedToken,
  type SocialMedia,
  type SocialProvider,
} from './provider.types';

/**
 * `youtube.upload` để đăng video; `youtube.force-ssl` để đọc kênh của người liên kết (tên, ảnh) và gỡ video
 * (`videos.delete` không nhận `youtube.upload`/`youtube.readonly`).
 * Màn đồng ý OAuth ở chế độ Testing: refresh token hết hạn sau 7 ngày ⇒ kênh chuyển "cần liên kết lại".
 */
export const YOUTUBE_SOCIAL_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'] as const;

export const YOUTUBE_PRIVACY = ['private', 'unlisted', 'public'] as const;
export type YoutubePrivacy = (typeof YOUTUBE_PRIVACY)[number];
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
/** YouTube giới hạn tổng độ dài tags 500 ký tự (tag có khoảng trắng tính thêm 2 dấu nháy). */
const TAGS_MAX = 500;

/** Danh mục video YouTube hay dùng (id cố định của YouTube Data API, vùng VN). Mặc định 22 = Mọi người & Blog. */
export const YOUTUBE_CATEGORIES = {
  '22': 'Mọi người & Blog',
  '27': 'Giáo dục',
  '28': 'Khoa học & Công nghệ',
  '26': 'Hướng dẫn & Phong cách',
  '24': 'Giải trí',
  '10': 'Âm nhạc',
  '20': 'Trò chơi',
  '25': 'Tin tức & Chính trị',
  '17': 'Thể thao',
  '19': 'Du lịch & Sự kiện',
  '1': 'Phim & Hoạt hình',
  '2': 'Ô tô & Xe cộ',
  '15': 'Thú cưng & Động vật',
  '23': 'Hài kịch',
  '29': 'Tổ chức phi lợi nhuận',
} as const;
export type YoutubeCategory = keyof typeof YOUTUBE_CATEGORIES;

/** Tags người đăng nhập (mảng hoặc chuỗi cách nhau dấu phẩy) → mảng sạch, bỏ trùng. */
export function youtubeTags(options: Record<string, unknown>): string[] {
  const raw = Array.isArray(options.tags) ? options.tags : typeof options.tags === 'string' ? options.tags.split(',') : [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const c = t.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    if (c && !out.some((x) => x.toLocaleLowerCase('vi') === c.toLocaleLowerCase('vi'))) out.push(c);
  }
  return out;
}

const tagsLength = (tags: string[]) => tags.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0), 0) + Math.max(0, tags.length - 1);

/** Ảnh thumbnail đã kiểm ở bước tạo bài (tệp trong thư viện, JPG/PNG ≤ 2 MB). */
function youtubeThumbnail(options: Record<string, unknown>): SocialMedia | null {
  const t = options.thumbnail as Partial<SocialMedia> | undefined;
  return t && typeof t.key === 'string' && t.type === 'image' && typeof t.content_type === 'string' ? (t as SocialMedia) : null;
}

interface YoutubeConfig {
  clientId: string;
  clientSecret: string;
}

export function loadYoutubeConfig(env: NodeJS.ProcessEnv = process.env): YoutubeConfig {
  return { clientId: env.GOOGLE_SOCIAL_CLIENT_ID?.trim() ?? '', clientSecret: env.GOOGLE_SOCIAL_CLIENT_SECRET?.trim() ?? '' };
}

interface GoogleErrorBody {
  error?: string | { code?: number; message?: string; errors?: Array<{ reason?: string; message?: string }> };
  error_description?: string;
}

/** Lỗi Google (OAuth token endpoint hoặc YouTube Data API) → loại lỗi để job quyết định. */
export function classifyGoogleError(status: number, body: GoogleErrorBody): SocialPublishError {
  if (typeof body.error === 'string') {
    // Token endpoint: invalid_grant = refresh token hết hạn/bị thu hồi (Testing mode: 7 ngày).
    const msg = (body.error_description || body.error).slice(0, 300);
    if (body.error === 'invalid_grant' || body.error === 'unauthorized_client') return new SocialPublishError('token', `YouTube: quyền truy cập đã hết hạn hoặc bị thu hồi — liên kết lại. (${msg})`);
    if (status >= 500) return new SocialPublishError('temporary', `Google tạm thời lỗi. (${msg})`);
    return new SocialPublishError('invalid', `Google từ chối: ${msg}`);
  }
  const e = body.error ?? {};
  const reason = e.errors?.[0]?.reason ?? '';
  const msg = (e.message || e.errors?.[0]?.message || `HTTP ${status}`).slice(0, 300);
  if (status === 401) return new SocialPublishError('token', `YouTube: phiên đăng nhập của kênh đã hết hạn — liên kết lại. (${msg})`);
  if (status === 429 || ['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'uploadLimitExceeded'].includes(reason)) {
    return new SocialPublishError('rate', `YouTube hết hạn mức gọi API. (${msg})`);
  }
  if (status === 403 && (reason === 'insufficientPermissions' || /insufficient authentication scopes/i.test(msg))) {
    return new SocialPublishError('permission', `YouTube: kênh chưa cấp đủ quyền cho thao tác này — liên kết lại kênh ở mục Kênh. (${msg})`);
  }
  if (status === 403) return new SocialPublishError('permission', `YouTube: tài khoản không có quyền đăng lên kênh này. (${msg})`);
  if (status >= 500) return new SocialPublishError('temporary', `YouTube tạm thời lỗi. (${msg})`);
  return new SocialPublishError('invalid', `YouTube từ chối video: ${msg}`);
}

/** Tiêu đề: tuỳ chọn `title`, không có thì dòng đầu nội dung. YouTube cấm `<` `>` và giới hạn 100 ký tự. */
export function youtubeTitle(text: string, options: Record<string, unknown>): string {
  const raw = typeof options.title === 'string' && options.title.trim() ? options.title : text.split('\n').find((l) => l.trim()) ?? '';
  const clean = raw.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…` : clean;
}

export function youtubePrivacy(options: Record<string, unknown>): YoutubePrivacy {
  return (YOUTUBE_PRIVACY as readonly unknown[]).includes(options.privacy) ? (options.privacy as YoutubePrivacy) : 'private';
}

/**
 * Đăng video lên kênh YouTube (YouTube Data API v3, fetch thẳng). Mỗi bài đúng một video; tải lên kiểu resumable một lượt.
 * Mặc định `private` — người đăng chọn công khai/không công khai trong tuỳ chọn kênh. KHÔNG BAO GIỜ log token/secret.
 */
@Injectable()
export class YoutubeSocialProvider implements SocialProvider {
  private readonly logger = new Logger(YoutubeSocialProvider.name);
  readonly network = 'youtube' as const;
  readonly supported = true;
  readonly usesPkce = false;
  readonly envNames = ['GOOGLE_SOCIAL_CLIENT_ID', 'GOOGLE_SOCIAL_CLIENT_SECRET'] as const;
  readonly scopes = YOUTUBE_SOCIAL_SCOPES;

  configured(): boolean {
    const c = loadYoutubeConfig();
    return Boolean(c.clientId && c.clientSecret);
  }

  validateMedia(media: SocialMedia[]): string | null {
    const videos = media.filter((m) => m.type === 'video').length;
    if (videos !== 1 || media.length !== 1) return 'YouTube: mỗi bài cần đúng một video, không kèm ảnh.';
    return null;
  }

  validateOptions(text: string, options: Record<string, unknown>): string | null {
    if (options.privacy !== undefined && !(YOUTUBE_PRIVACY as readonly unknown[]).includes(options.privacy)) return 'YouTube: quyền xem phải là private, unlisted hoặc public.';
    if (options.title !== undefined && typeof options.title !== 'string') return 'YouTube: tiêu đề phải là chữ.';
    if (!youtubeTitle(text, options)) return 'YouTube: cần tiêu đề (hoặc dòng đầu nội dung).';
    if (options.description !== undefined && (typeof options.description !== 'string' || options.description.length > DESCRIPTION_MAX)) return `YouTube: mô tả phải là chữ, tối đa ${DESCRIPTION_MAX} ký tự.`;
    if (options.tags !== undefined && !Array.isArray(options.tags) && typeof options.tags !== 'string') return 'YouTube: tags phải là danh sách chữ.';
    if (tagsLength(youtubeTags(options)) > TAGS_MAX) return `YouTube: tổng độ dài tags tối đa ${TAGS_MAX} ký tự.`;
    if (options.category_id !== undefined && !Object.prototype.hasOwnProperty.call(YOUTUBE_CATEGORIES, String(options.category_id))) return 'YouTube: danh mục không hợp lệ.';
    if (options.made_for_kids !== undefined && typeof options.made_for_kids !== 'boolean') return 'YouTube: "dành cho trẻ em" phải là có/không.';
    if (options.playlist_id !== undefined && options.playlist_id !== '' && (typeof options.playlist_id !== 'string' || !/^[A-Za-z0-9_-]{10,64}$/.test(options.playlist_id))) return 'YouTube: playlist không hợp lệ.';
    return null;
  }

  /** Playlist của kênh (để chọn khi đăng). Dùng quyền youtube.force-ssl sẵn có. */
  async listPlaylists(account: AccountForPublish): Promise<Array<{ id: string; title: string }>> {
    const out: Array<{ id: string; title: string }> = [];
    let pageToken: string | undefined;
    // YouTube trả tối đa 50 playlist mỗi trang; đi tiếp theo nextPageToken (chặn 20 trang = 1.000 playlist).
    for (let i = 0; i < 20; i++) {
      const r = await this.api<{ items?: Array<{ id: string; snippet?: { title?: string } }>; nextPageToken?: string }>('GET', 'youtube/v3/playlists', account.access_token, {
        query: { part: 'snippet', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}) },
      });
      out.push(...(r.items ?? []).map((p) => ({ id: p.id, title: p.snippet?.title || p.id })));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const c = loadYoutubeConfig();
    const q = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      state,
      access_type: 'offline',
      // Luôn hỏi lại để Google trả refresh token cả khi người dùng từng đồng ý.
      prompt: 'consent',
      // Không gộp quyền cũ (include_granted_scopes): màn đồng ý và token chỉ mang đúng hai scope đã khai với Google.
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
  }

  async exchange(code: string, redirectUri: string): Promise<ConnectedAccount[]> {
    const c = loadYoutubeConfig();
    const t = await this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: c.clientId, client_secret: c.clientSecret });
    if (!t.refresh_token) throw new SocialPublishError('invalid', 'Google không trả refresh token — gỡ quyền ứng dụng trong tài khoản Google rồi liên kết lại.');
    const granted = (t.scope ?? '').split(' ').filter(Boolean);
    if (!granted.includes(YOUTUBE_SOCIAL_SCOPES[0])) throw new SocialPublishError('permission', 'Chưa cấp quyền tải video lên YouTube — liên kết lại và tích đủ quyền.');
    const ch = await this.api<{ items?: Array<{ id: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }> }>('GET', 'youtube/v3/channels', t.access_token, {
      query: { part: 'snippet', mine: 'true' },
    });
    const items = ch.items ?? [];
    if (items.length === 0) throw new SocialPublishError('invalid', 'Tài khoản Google này chưa có kênh YouTube — tạo kênh trước rồi liên kết lại.');
    const expires = t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null;
    return items.map((it) => ({
      external_id: it.id,
      name: it.snippet?.title || it.id,
      avatar_url: it.snippet?.thumbnails?.default?.url ?? null,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      token_expires_at: expires,
      scopes: granted,
    }));
  }

  async refresh(account: AccountForPublish): Promise<RefreshedToken | null> {
    if (!account.refresh_token) throw new SocialPublishError('token', 'YouTube: thiếu refresh token — liên kết lại kênh.');
    const c = loadYoutubeConfig();
    const t = await this.token({ grant_type: 'refresh_token', refresh_token: account.refresh_token, client_id: c.clientId, client_secret: c.clientSecret });
    return { access_token: t.access_token, refresh_token: t.refresh_token ?? null, token_expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null };
  }

  async publish(account: AccountForPublish, input: PublishInput): Promise<PublishResult> {
    const video = input.media.find((m) => m.type === 'video');
    if (!video) throw new SocialPublishError('invalid', 'YouTube: bài không có video.');
    const f = await input.load(video);
    const o = input.options;
    const description = typeof o.description === 'string' && o.description.trim() ? o.description : input.text;
    const tags = youtubeTags(o);
    const metadata = {
      snippet: {
        title: youtubeTitle(input.text, o),
        description: description.replace(/[<>]/g, ''),
        categoryId: Object.prototype.hasOwnProperty.call(YOUTUBE_CATEGORIES, String(o.category_id)) ? String(o.category_id) : '22',
        ...(tags.length ? { tags } : {}),
      },
      status: { privacyStatus: youtubePrivacy(o), selfDeclaredMadeForKids: o.made_for_kids === true },
    };
    // Resumable: tạo phiên (nhận Location) rồi PUT toàn bộ tệp một lượt.
    const init = await this.fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': f.content_type,
        'X-Upload-Content-Length': String(f.body.length),
      },
      body: JSON.stringify(metadata),
    }, 20_000);
    if (!init.ok) throw classifyGoogleError(init.status, await safeJson(init));
    const location = init.headers.get('location');
    if (!location) throw new SocialPublishError('temporary', 'YouTube không trả địa chỉ tải lên.');
    const up = await this.fetch(location, { method: 'PUT', headers: { 'Content-Type': f.content_type }, body: new Uint8Array(f.body) }, 300_000);
    const json = (await safeJson(up)) as { id?: string } & GoogleErrorBody;
    if (!up.ok || !json.id) throw classifyGoogleError(up.status, json);
    // Video đã lên: thumbnail / playlist lỗi không làm hỏng lượt đăng (kênh chưa xác minh không đặt được thumbnail riêng).
    await this.afterUpload(account, json.id, o, input).catch((err: Error) => this.logger.warn(`YouTube video ${json.id}: ${err.message}`));
    return { external_post_id: json.id, url: `https://www.youtube.com/watch?v=${json.id}` };
  }

  private async afterUpload(account: AccountForPublish, videoId: string, o: Record<string, unknown>, input: PublishInput): Promise<void> {
    const thumb = youtubeThumbnail(o);
    if (thumb) {
      const img = await input.load(thumb);
      const r = await this.fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': img.content_type },
        body: new Uint8Array(img.body),
      }, 60_000);
      if (!r.ok) this.logger.warn(`YouTube thumbnail lỗi: ${classifyGoogleError(r.status, await safeJson(r)).message}`);
    }
    if (typeof o.playlist_id === 'string' && o.playlist_id) {
      const r = await this.fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
        method: 'POST',
        headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ snippet: { playlistId: o.playlist_id, resourceId: { kind: 'youtube#video', videoId } } }),
      }, 20_000);
      if (!r.ok) this.logger.warn(`YouTube thêm vào playlist lỗi: ${classifyGoogleError(r.status, await safeJson(r)).message}`);
    }
  }

  async deletePost(account: AccountForPublish, externalPostId: string): Promise<void> {
    await this.api('DELETE', 'youtube/v3/videos', account.access_token, { query: { id: externalPostId } });
  }

  /** Lượt xem, thích, bình luận của video (YouTube không có số chia sẻ qua API). Video đã bị xoá ⇒ `SocialPostGoneError`. */
  async fetchMetrics(account: AccountForPublish, externalPostId: string): Promise<PostMetrics> {
    const r = await this.api<{ items?: Array<{ statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }> }>('GET', 'youtube/v3/videos', account.access_token, {
      query: { part: 'statistics', id: externalPostId },
    });
    const st = r.items?.[0]?.statistics;
    if (!st) throw new SocialPostGoneError('YouTube: video không còn trên kênh (đã bị xoá).');
    const n = (v?: string) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
    return { views: n(st.viewCount), reactions: n(st.likeCount), comments: n(st.commentCount), shares: null };
  }

  private async token(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
    const res = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }, 20_000);
    const json = (await safeJson(res)) as { access_token?: string } & GoogleErrorBody;
    if (!res.ok || !json.access_token) throw classifyGoogleError(res.status, json);
    return json as { access_token: string };
  }

  private async api<T>(method: 'GET' | 'DELETE', path: string, token: string, opts: { query?: Record<string, string> } = {}): Promise<T> {
    const qs = new URLSearchParams(opts.query ?? {});
    const res = await this.fetch(`https://www.googleapis.com/${path}${qs.size ? `?${qs.toString()}` : ''}`, { method, headers: { Authorization: `Bearer ${token}` } }, 20_000);
    const json = (await safeJson(res)) as T & GoogleErrorBody;
    if (!res.ok) throw classifyGoogleError(res.status, json);
    return json;
  }

  private async fetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new SocialPublishError('temporary', `Không gọi được Google (${(err as Error).name})`);
    }
  }
}

async function safeJson(res: Response): Promise<GoogleErrorBody & Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as GoogleErrorBody & Record<string, unknown>;
}
