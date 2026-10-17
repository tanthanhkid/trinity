import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { loadFacebookConfig } from '../../facebook/facebook.config';
import {
  SocialPostGoneError,
  SocialPublishError,
  type AccountForPublish,
  type ConnectedAccount,
  type PublishInput,
  type PostMetrics,
  type PublishResult,
  type SocialMedia,
  type SocialProvider,
} from './provider.types';

/**
 * Quyền đăng bài lên Fanpage (Facebook Login for Business, use case "Manage everything on your Page").
 * Video Page đăng bằng `pages_manage_posts` — không cần `publish_video` (quyền đó cho video lên trang cá nhân/nhóm).
 * `business_management`: Page nằm trong Business portfolio mới hiện ở /me/accounts.
 */
export const FACEBOOK_SOCIAL_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management'] as const;

type Query = Record<string, string | undefined>;
export interface GraphCallOptions {
  token?: string;
  query?: Query;
  body?: unknown;
  form?: FormData;
  host?: string;
}
interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean; error_user_msg?: string };
}

/** Graph error → loại lỗi để job quyết định thử lại / liên kết lại. Docs: https://developers.facebook.com/docs/graph-api/guides/error-handling */
export function classifyGraphError(status: number, body: GraphErrorBody): SocialPublishError {
  const e = body.error ?? {};
  const code = typeof e.code === 'number' ? e.code : null;
  const msg = (e.error_user_msg || e.message || `HTTP ${status}`).slice(0, 300);
  // Đối tượng không còn (bài/video đã bị xoá trên Facebook): code 100, subcode 33.
  if (code === 100 && e.error_subcode === 33) return new SocialPostGoneError(`Facebook: bài không còn trên trang (đã bị xoá). (${msg})`);
  if (code === 190 || code === 102) return new SocialPublishError('token', `Facebook: phiên đăng nhập của trang đã hết hạn hoặc bị thu hồi — liên kết lại. (${msg})`);
  if (status === 429 || (code !== null && [4, 17, 32, 613].includes(code))) return new SocialPublishError('rate', `Facebook giới hạn tần suất. (${msg})`);
  if (code === 10 || (code !== null && code >= 200 && code < 300)) return new SocialPublishError('permission', `Facebook: thiếu quyền đăng lên trang này. (${msg})`);
  // 408: Facebook hết giờ chờ nhận tệp (video lớn, đường truyền chậm) — thử lại được.
  if (e.is_transient || code === 1 || code === 2 || status === 408 || status >= 500) return new SocialPublishError('temporary', `Facebook tạm thời lỗi. (${msg})`);
  return new SocialPublishError('invalid', `Facebook từ chối bài: ${msg}`);
}

/**
 * Đăng lên Facebook Page qua Graph API (fetch thẳng, không SDK). Token gửi bằng header Bearer + `appsecret_proof`.
 * KHÔNG BAO GIỜ log token/secret.
 * - Chữ: POST /{page}/feed · 1 ảnh: POST /{page}/photos · nhiều ảnh: photos published=false rồi feed + attached_media
 * - Video: POST graph-video.facebook.com/{page}/videos (multipart `source`)
 */
@Injectable()
export class FacebookSocialProvider implements SocialProvider {
  readonly network = 'facebook' as const;
  readonly supported = true;
  readonly usesPkce = false;
  readonly envNames = ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'] as const;
  readonly scopes = FACEBOOK_SOCIAL_SCOPES;

  configured(): boolean {
    const c = loadFacebookConfig();
    return Boolean(c.appId && c.appSecret);
  }

  validateMedia(media: SocialMedia[]): string | null {
    const videos = media.filter((m) => m.type === 'video').length;
    const images = media.length - videos;
    if (videos > 1) return 'Facebook: mỗi bài chỉ một video.';
    if (videos === 1 && images > 0) return 'Facebook: không ghép video với ảnh trong cùng một bài.';
    if (images > 10) return 'Facebook: tối đa 10 ảnh mỗi bài.';
    return null;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const c = loadFacebookConfig();
    const q = new URLSearchParams({ client_id: c.appId, redirect_uri: redirectUri, state, scope: this.scopes.join(','), response_type: 'code' });
    return `https://www.facebook.com/${c.graphVersion}/dialog/oauth?${q.toString()}`;
  }

  async exchange(code: string, redirectUri: string): Promise<ConnectedAccount[]> {
    const c = loadFacebookConfig();
    const short = await this.call<{ access_token: string }>('GET', 'oauth/access_token', {
      query: { client_id: c.appId, client_secret: c.appSecret, redirect_uri: redirectUri, code },
    });
    const long = await this.call<{ access_token: string }>('GET', 'oauth/access_token', {
      query: { grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: short.access_token },
    });
    const pages = await this.call<{ data: Array<{ id: string; name: string; access_token?: string; tasks?: string[]; picture?: { data?: { url?: string } } }> }>(
      'GET',
      'me/accounts',
      { token: long.access_token, query: { fields: 'id,name,access_token,tasks,picture{url}', limit: '100' } },
    );
    // Token trang lấy từ token người dùng dài hạn ⇒ không hết hạn. Chỉ nhận trang người dùng có quyền tạo nội dung.
    return (pages.data ?? [])
      .filter((p) => p.access_token && (!p.tasks || p.tasks.includes('CREATE_CONTENT') || p.tasks.includes('MANAGE')))
      .map((p) => ({
        external_id: p.id,
        name: p.name,
        avatar_url: p.picture?.data?.url ?? null,
        access_token: p.access_token as string,
        refresh_token: null,
        token_expires_at: null,
        scopes: [...this.scopes],
      }));
  }

  validateOptions(_text: string, options: Record<string, unknown>): string | null {
    if (options.first_comment !== undefined && (typeof options.first_comment !== 'string' || options.first_comment.length > 8000)) return 'Facebook: bình luận đầu tiên phải là chữ, tối đa 8.000 ký tự.';
    return null;
  }

  async publish(account: AccountForPublish, input: PublishInput): Promise<PublishResult> {
    const page = account.external_id;
    const token = account.access_token;
    const video = input.media.find((m) => m.type === 'video');
    if (video) {
      const f = await input.load(video);
      const title = typeof input.options.title === 'string' ? input.options.title.trim() : '';
      const id = await this.uploadVideo(page, token, f.body, f.content_type, { description: input.text, ...(title ? { title: title.slice(0, 255) } : {}) });
      return { external_post_id: id, url: `https://www.facebook.com/${page}/videos/${id}` };
    }
    const images = input.media.filter((m) => m.type === 'image');
    if (images.length === 1) {
      const f = await input.load(images[0]);
      const form = new FormData();
      if (input.text) form.set('message', input.text);
      form.set('source', new Blob([new Uint8Array(f.body)], { type: f.content_type }), `image${extOf(f.content_type)}`);
      const r = await this.call<{ id: string; post_id?: string }>('POST', `${page}/photos`, { token, form });
      const id = r.post_id ?? r.id;
      return { external_post_id: id, url: `https://www.facebook.com/${id}` };
    }
    const body: Record<string, unknown> = { message: input.text };
    if (images.length > 1) {
      const ids: string[] = [];
      for (const img of images) {
        const f = await input.load(img);
        const form = new FormData();
        form.set('published', 'false');
        form.set('source', new Blob([new Uint8Array(f.body)], { type: f.content_type }), `image${extOf(f.content_type)}`);
        ids.push((await this.call<{ id: string }>('POST', `${page}/photos`, { token, form })).id);
      }
      body.attached_media = ids.map((media_fbid) => ({ media_fbid }));
    }
    const r = await this.call<{ id: string }>('POST', `${page}/feed`, { token, body });
    return { external_post_id: r.id, url: `https://www.facebook.com/${r.id}` };
  }

  /**
   * Video tải lên theo phiên (start → transfer từng phần → finish), mỗi phần một request ngắn: một request chứa cả video
   * vài chục MB hay bị Facebook trả HTTP 408 khi đường lên chậm. Docs: https://developers.facebook.com/docs/video-api/guides/publishing
   */
  private async uploadVideo(page: string, token: string, body: Buffer, contentType: string, fields: Record<string, string>): Promise<string> {
    const host = 'graph-video.facebook.com';
    const phase = (values: Record<string, string>, chunk?: Buffer) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(values)) form.set(k, v);
      if (chunk) form.set('video_file_chunk', new Blob([new Uint8Array(chunk)], { type: contentType }), `video${extOf(contentType)}`);
      return form;
    };
    const start = await this.call<{ upload_session_id: string; video_id: string; start_offset: string; end_offset: string }>('POST', `${page}/videos`, {
      token,
      host,
      form: phase({ upload_phase: 'start', file_size: String(body.length) }),
    });
    let from = Number(start.start_offset);
    let to = Number(start.end_offset);
    while (from < to) {
      const r = await this.call<{ start_offset: string; end_offset: string }>('POST', `${page}/videos`, {
        token,
        host,
        form: phase({ upload_phase: 'transfer', upload_session_id: start.upload_session_id, start_offset: String(from) }, body.subarray(from, to)),
      });
      from = Number(r.start_offset);
      to = Number(r.end_offset);
    }
    await this.call('POST', `${page}/videos`, { token, host, form: phase({ upload_phase: 'finish', upload_session_id: start.upload_session_id, ...fields }) });
    return start.video_id;
  }

  async deletePost(account: AccountForPublish, externalPostId: string): Promise<void> {
    await this.call('DELETE', externalPostId, { token: account.access_token });
  }

  /**
   * Bài (id `{page}_{post}`): cảm xúc, bình luận, chia sẻ. Video (id số): lượt xem + số của bài chứa video.
   * Lượt tiếp cận/hiển thị cần quyền `read_insights` (chưa xin) nên để null.
   */
  async fetchMetrics(account: AccountForPublish, externalPostId: string): Promise<PostMetrics> {
    const token = account.access_token;
    let postId = externalPostId;
    let views: number | null = null;
    if (!externalPostId.includes('_')) {
      const v = await this.call<{ views?: number; post_id?: string }>('GET', externalPostId, { token, query: { fields: 'views,post_id' } });
      views = typeof v.views === 'number' ? v.views : null;
      if (!v.post_id) return { views, reactions: null, comments: null, shares: null };
      postId = `${account.external_id}_${v.post_id}`;
    }
    const r = await this.call<{ reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } }; shares?: { count?: number } }>('GET', postId, {
      token,
      query: { fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares' },
    });
    return {
      views,
      reactions: r.reactions?.summary?.total_count ?? 0,
      comments: r.comments?.summary?.total_count ?? 0,
      // Graph bỏ hẳn trường `shares` khi chưa ai chia sẻ.
      shares: r.shares?.count ?? 0,
    };
  }

  private call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: GraphCallOptions = {}): Promise<T> {
    return graphCall<T>(method, path, opts);
  }
}

/** Gọi Graph API (fetch thẳng) với Bearer + `appsecret_proof`. Dùng chung cho Facebook Page và Instagram. */
export async function graphCall<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: GraphCallOptions = {},
): Promise<T> {
  const c = loadFacebookConfig();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, v);
  if (opts.token) qs.set('appsecret_proof', createHmac('sha256', c.appSecret).update(opts.token).digest('hex'));
  const url = `https://${opts.host ?? 'graph.facebook.com'}/${c.graphVersion}/${path.replace(/^\//, '')}${qs.size ? `?${qs.toString()}` : ''}`;
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let payload: FormData | string | undefined;
  if (opts.form) payload = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(opts.form ? 120_000 : 20_000) });
  } catch (err) {
    throw new SocialPublishError('temporary', `Không gọi được Facebook (${(err as Error).name})`);
  }
  const json = (await res.json().catch(() => ({}))) as T & GraphErrorBody;
  if (!res.ok || json.error) throw classifyGraphError(res.status, json);
  return json;
}

function extOf(contentType: string): string {
  const map: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
  return map[contentType] ?? '';
}
