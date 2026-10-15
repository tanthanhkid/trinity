import { Injectable } from '@nestjs/common';
import { loadFacebookConfig } from '../../facebook/facebook.config';
import { graphCall, type GraphCallOptions } from './facebook.provider';
import {
  SocialPostGoneError,
  SocialPublishError,
  type AccountForPublish,
  type ConnectedAccount,
  type PostMetrics,
  type PublishInput,
  type PublishResult,
  type SocialMedia,
  type SocialProvider,
} from './provider.types';

/**
 * Instagram API qua Facebook Login (tài khoản Instagram chuyên nghiệp gắn với một Fanpage) — dùng chung app Meta của Facebook.
 * `pages_show_list` + `business_management`: thấy Page (kể cả Page trong Business portfolio) để lấy tài khoản IG gắn với nó.
 */
export const INSTAGRAM_SOCIAL_SCOPES = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'business_management'] as const;

/** Chờ Instagram xử lý container (video có thể vài chục giây). Quá ngân sách ⇒ lỗi tạm, job thử lại sau. */
const READY_BUDGET_MS = 90_000;
const READY_POLL_MS = 3_000;

/** Bật cờ khi app Meta đã được duyệt quyền `instagram_content_publish` (hoặc ở môi trường thử với tài khoản tester). */
export const instagramPublishEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.INSTAGRAM_PUBLISH_ENABLED === 'true';

/**
 * Đăng lên Instagram (ảnh, nhiều ảnh, Reels). Instagram KHÔNG nhận tải tệp lên — chỉ nhận URL công khai ⇒ dùng `input.publicUrl`
 * (link có chữ ký, hạn 2 giờ). Quy trình: tạo container → chờ FINISHED → media_publish → lấy permalink.
 * Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
 */
@Injectable()
export class InstagramSocialProvider implements SocialProvider {
  readonly network = 'instagram' as const;
  readonly supported = true;
  readonly usesPkce = false;
  readonly envNames = ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'INSTAGRAM_PUBLISH_ENABLED'] as const;
  readonly scopes = INSTAGRAM_SOCIAL_SCOPES;

  /** Cho test rút ngắn thời gian chờ. */
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  configured(): boolean {
    const c = loadFacebookConfig();
    return Boolean(c.appId && c.appSecret) && instagramPublishEnabled();
  }

  validateMedia(media: SocialMedia[]): string | null {
    if (!media.length) return 'Instagram: bài phải có ảnh hoặc video.';
    const videos = media.filter((m) => m.type === 'video');
    const images = media.filter((m) => m.type === 'image');
    if (videos.length && images.length) return 'Instagram: không ghép video với ảnh trong cùng một bài.';
    if (videos.length > 1) return 'Instagram: mỗi bài chỉ một video (Reels).';
    if (images.length > 10) return 'Instagram: tối đa 10 ảnh mỗi bài.';
    if (images.some((m) => m.content_type !== 'image/jpeg')) return 'Instagram: chỉ nhận ảnh JPG.';
    if (videos.some((m) => !['video/mp4', 'video/quicktime'].includes(m.content_type))) return 'Instagram: video phải là MP4 hoặc MOV.';
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
    type Ig = { id: string; username?: string; profile_picture_url?: string };
    const pages = await this.call<{ data: Array<{ id: string; name: string; access_token?: string; instagram_business_account?: Ig }> }>('GET', 'me/accounts', {
      token: long.access_token,
      query: { fields: 'id,name,access_token,instagram_business_account{id,username,profile_picture_url}', limit: '100' },
    });
    // Mỗi tài khoản IG chuyên nghiệp gắn với một Page; token Page (dài hạn) dùng để đăng lên IG đó.
    const seen = new Set<string>();
    const out: ConnectedAccount[] = [];
    for (const p of pages.data ?? []) {
      const ig = p.instagram_business_account;
      if (!ig?.id || !p.access_token || seen.has(ig.id)) continue;
      seen.add(ig.id);
      out.push({
        external_id: ig.id,
        name: ig.username ? `@${ig.username}` : p.name,
        avatar_url: ig.profile_picture_url ?? null,
        access_token: p.access_token,
        refresh_token: null,
        token_expires_at: null,
        scopes: [...this.scopes],
      });
    }
    if (!out.length) {
      throw new SocialPublishError('invalid', 'Instagram: không thấy tài khoản Instagram chuyên nghiệp nào gắn với Fanpage bạn quản lý. Chuyển Instagram sang tài khoản chuyên nghiệp và liên kết với Fanpage rồi thử lại.');
    }
    return out;
  }

  async publish(account: AccountForPublish, input: PublishInput): Promise<PublishResult> {
    const ig = account.external_id;
    const token = account.access_token;
    const caption = input.text || undefined;
    const video = input.media.find((m) => m.type === 'video');
    const images = input.media.filter((m) => m.type === 'image');
    let creationId: string;
    if (video) {
      creationId = (await this.call<{ id: string }>('POST', `${ig}/media`, { token, body: { media_type: 'REELS', video_url: input.publicUrl(video), caption } })).id;
    } else if (images.length === 1) {
      creationId = (await this.call<{ id: string }>('POST', `${ig}/media`, { token, body: { image_url: input.publicUrl(images[0]), caption } })).id;
    } else if (images.length > 1) {
      const children: string[] = [];
      for (const img of images) {
        children.push((await this.call<{ id: string }>('POST', `${ig}/media`, { token, body: { image_url: input.publicUrl(img), is_carousel_item: true } })).id);
      }
      for (const id of children) await this.waitReady(id, token);
      creationId = (await this.call<{ id: string }>('POST', `${ig}/media`, { token, body: { media_type: 'CAROUSEL', children: children.join(','), caption } })).id;
    } else {
      throw new SocialPublishError('invalid', 'Instagram: bài phải có ảnh hoặc video.');
    }
    await this.waitReady(creationId, token);
    const published = await this.call<{ id: string }>('POST', `${ig}/media_publish`, { token, body: { creation_id: creationId } });
    const info = await this.call<{ permalink?: string }>('GET', published.id, { token, query: { fields: 'permalink' } }).catch(() => ({}) as { permalink?: string });
    return { external_post_id: published.id, url: info.permalink ?? null };
  }

  /** Lượt thích + bình luận. Lượt xem/tiếp cận cần `instagram_manage_insights` (chưa xin) nên để null. */
  async fetchMetrics(account: AccountForPublish, externalPostId: string): Promise<PostMetrics> {
    let r: { like_count?: number; comments_count?: number };
    try {
      r = await this.call('GET', externalPostId, { token: account.access_token, query: { fields: 'like_count,comments_count' } });
    } catch (err) {
      // Bài đã bị xoá trên Instagram: Graph trả lỗi 100 / subcode 33 ("does not exist").
      if (err instanceof SocialPublishError && err.kind === 'invalid' && /does not exist|cannot be loaded/i.test(err.message)) {
        throw new SocialPostGoneError('Instagram: bài không còn trên tài khoản (đã bị xoá).');
      }
      throw err;
    }
    return { views: null, reactions: r.like_count ?? 0, comments: r.comments_count ?? 0, shares: null };
  }

  private async waitReady(containerId: string, token: string): Promise<void> {
    const deadline = Date.now() + READY_BUDGET_MS;
    for (;;) {
      const s = await this.call<{ status_code?: string; status?: string }>('GET', containerId, { token, query: { fields: 'status_code,status' } });
      if (s.status_code === 'FINISHED' || s.status_code === 'PUBLISHED') return;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
        throw new SocialPublishError('invalid', `Instagram không xử lý được tệp (${s.status ?? s.status_code}). Kiểm định dạng, kích thước, tỉ lệ khung hình.`);
      }
      if (Date.now() + READY_POLL_MS > deadline) throw new SocialPublishError('temporary', 'Instagram đang xử lý tệp lâu hơn dự kiến — sẽ thử lại.');
      await this.sleep(READY_POLL_MS);
    }
  }

  /** Lỗi Graph mang chữ "Facebook" — đổi nhãn cho đúng mạng người dùng đang đăng. */
  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: GraphCallOptions = {}): Promise<T> {
    try {
      return await graphCall<T>(method, path, opts);
    } catch (err) {
      if (err instanceof SocialPublishError) throw new SocialPublishError(err.kind, err.message.replace(/Facebook/g, 'Instagram').replace('của trang', 'của tài khoản'));
      throw err;
    }
  }
}
