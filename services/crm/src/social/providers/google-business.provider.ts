import { Injectable } from '@nestjs/common';
import {
  SocialPostGoneError,
  SocialPublishError,
  type AccountForPublish,
  type PostMetrics,
  type ConnectedAccount,
  type PublishInput,
  type PublishResult,
  type RefreshedToken,
  type SocialMedia,
  type SocialProvider,
} from './provider.types';
import { classifyGoogleError, loadYoutubeConfig } from './youtube.provider';

/** Một quyền cho cả đăng bài cập nhật và đọc/trả lời đánh giá. */
export const GOOGLE_BUSINESS_SCOPES = ['https://www.googleapis.com/auth/business.manage'] as const;

/** Bài cập nhật (local post) — Google giới hạn 1.500 ký tự. */
export const GBP_SUMMARY_MAX = 1500;
/** Câu trả lời đánh giá — Google giới hạn 4.096 byte. */
export const GBP_REPLY_MAX_BYTES = 4096;

const ACCOUNTS_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const V4 = 'https://mybusiness.googleapis.com/v4';
/** Chờ Google duyệt bài (PROCESSING → LIVE/REJECTED) tối đa chừng này trong lượt đăng; quá thì đối chiếu tiếp ở lượt lấy số. */
const STATE_WAIT_MS = 24_000;

/**
 * Google mặc định cấp 0 lượt gọi/phút cho Business Profile API tới khi duyệt đơn "Application for Basic API Access"
 * (mỗi project Google Cloud nộp đơn riêng). Chỉ bật khi đã được duyệt: GOOGLE_BUSINESS_ENABLED=true.
 * Chưa bật ⇒ màn Kênh hiện "Sắp có".
 */
export function googleBusinessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GOOGLE_BUSINESS_ENABLED?.trim().toLowerCase() === 'true';
}

/** `external_id` của kênh = "<accountId>/<locationId>" (chỉ số — cột 64 ký tự); đường dẫn v4 dựng lại từ đây. */
export function gbpLocationPath(externalId: string): string {
  const [a, l] = externalId.split('/');
  if (!/^\d+$/.test(a ?? '') || !/^\d+$/.test(l ?? '')) throw new SocialPublishError('invalid', 'Google Business: mã địa điểm không hợp lệ — liên kết lại.');
  return `accounts/${a}/locations/${l}`;
}

export type GbpStar = 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export interface GbpReview {
  /** Mã đánh giá (đoạn cuối của `name`). */
  id: string;
  reviewer: string;
  reviewer_photo: string | null;
  stars: number | null;
  comment: string | null;
  created_at: string | null;
  updated_at: string | null;
  reply: { comment: string; updated_at: string | null } | null;
}

interface RawReview {
  name?: string;
  reviewId?: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

export function mapReview(r: RawReview): GbpReview {
  const id = r.reviewId || (r.name ?? '').split('/').pop() || '';
  return {
    id,
    reviewer: r.reviewer?.isAnonymous ? 'Người dùng Google' : r.reviewer?.displayName || 'Người dùng Google',
    reviewer_photo: r.reviewer?.profilePhotoUrl ?? null,
    stars: STARS[r.starRating ?? ''] ?? null,
    // Google gắn bản dịch máy vào cuối bình luận: "(Translated by Google) …" — giữ nguyên, người đọc tự thấy.
    comment: r.comment ?? null,
    created_at: r.createTime ?? null,
    updated_at: r.updateTime ?? null,
    reply: r.reviewReply?.comment ? { comment: r.reviewReply.comment, updated_at: r.reviewReply.updateTime ?? null } : null,
  };
}

/**
 * Google Business Profile: mỗi ĐỊA ĐIỂM là một kênh. Đăng bài cập nhật (local post, chữ + tối đa 1 ảnh) và đọc/trả lời
 * đánh giá. Dùng chung app OAuth Google với YouTube (GOOGLE_SOCIAL_CLIENT_ID/SECRET) — chỉ thêm scope business.manage.
 * KHÔNG BAO GIỜ log token/secret.
 */
@Injectable()
export class GoogleBusinessSocialProvider implements SocialProvider {
  readonly network = 'google_business' as const;
  readonly supported = true;
  readonly usesPkce = false;
  readonly envNames = ['GOOGLE_SOCIAL_CLIENT_ID', 'GOOGLE_SOCIAL_CLIENT_SECRET', 'GOOGLE_BUSINESS_ENABLED'] as const;
  readonly scopes = GOOGLE_BUSINESS_SCOPES;

  configured(): boolean {
    const c = loadYoutubeConfig();
    return googleBusinessEnabled() && Boolean(c.clientId && c.clientSecret);
  }

  validateMedia(media: SocialMedia[]): string | null {
    if (media.some((m) => m.type === 'video')) return 'Google Business: bài cập nhật chỉ nhận ảnh, không nhận video.';
    if (media.length > 1) return 'Google Business: mỗi bài cập nhật tối đa 1 ảnh.';
    if (media.some((m) => m.content_type !== 'image/jpeg' && m.content_type !== 'image/png')) return 'Google Business: ảnh phải là JPG hoặc PNG.';
    return null;
  }

  validateOptions(text: string): string | null {
    if (!text.trim()) return 'Google Business: bài cập nhật cần nội dung chữ.';
    return null;
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
      prompt: 'consent',
      // Cùng OAuth client với YouTube: không gộp quyền cũ để mỗi lần liên kết chỉ xin đúng scope của mình.
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
  }

  async exchange(code: string, redirectUri: string): Promise<ConnectedAccount[]> {
    const c = loadYoutubeConfig();
    const t = await this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: c.clientId, client_secret: c.clientSecret });
    if (!t.refresh_token) throw new SocialPublishError('invalid', 'Google không trả refresh token — gỡ quyền ứng dụng trong tài khoản Google rồi liên kết lại.');
    const granted = (t.scope ?? '').split(' ').filter(Boolean);
    if (!granted.includes(GOOGLE_BUSINESS_SCOPES[0])) throw new SocialPublishError('permission', 'Chưa cấp quyền quản lý hồ sơ doanh nghiệp — liên kết lại và tích đủ quyền.');
    const accounts = await this.collect<{ name?: string }>(`${ACCOUNTS_API}/accounts`, 'accounts', t.access_token);
    const expires = t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null;
    const out: ConnectedAccount[] = [];
    for (const a of accounts) {
      const accountId = (a.name ?? '').split('/')[1];
      if (!accountId) continue;
      const locs = await this.collect<{ name?: string; title?: string }>(`${INFO_API}/accounts/${accountId}/locations?readMask=name,title&pageSize=100`, 'locations', t.access_token);
      for (const l of locs) {
        const locationId = (l.name ?? '').split('/')[1];
        if (!locationId) continue;
        out.push({
          external_id: `${accountId}/${locationId}`,
          name: l.title || `Địa điểm ${locationId}`,
          avatar_url: null,
          access_token: t.access_token,
          refresh_token: t.refresh_token,
          token_expires_at: expires,
          scopes: granted,
        });
      }
    }
    if (out.length === 0) throw new SocialPublishError('invalid', 'Tài khoản Google này chưa quản lý hồ sơ doanh nghiệp nào trên Google — thêm quyền quản lý hồ sơ rồi liên kết lại.');
    return out;
  }

  async refresh(account: AccountForPublish): Promise<RefreshedToken | null> {
    if (!account.refresh_token) throw new SocialPublishError('token', 'Google Business: thiếu refresh token — liên kết lại.');
    const c = loadYoutubeConfig();
    const t = await this.token({ grant_type: 'refresh_token', refresh_token: account.refresh_token, client_id: c.clientId, client_secret: c.clientSecret });
    return { access_token: t.access_token, refresh_token: t.refresh_token ?? null, token_expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null };
  }

  async publish(account: AccountForPublish, input: PublishInput): Promise<PublishResult> {
    const summary = input.text.trim();
    if (!summary) throw new SocialPublishError('invalid', 'Google Business: bài cập nhật cần nội dung chữ.');
    if (summary.length > GBP_SUMMARY_MAX) throw new SocialPublishError('invalid', `Google Business: nội dung tối đa ${GBP_SUMMARY_MAX} ký tự.`);
    const photo = input.media.find((m) => m.type === 'image');
    const body: Record<string, unknown> = { languageCode: 'vi', summary, topicType: 'STANDARD' };
    // Google tự tải ảnh từ link công khai (có chữ ký, hạn 2 giờ) — không gửi tệp.
    if (photo) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: input.publicUrl(photo) }];
    const post = await this.call<{ name?: string; searchUrl?: string; state?: string }>('POST', `${V4}/${gbpLocationPath(account.external_id)}/localPosts`, account.access_token, body);
    const id = (post.name ?? '').split('/').pop();
    if (!id) throw new SocialPublishError('temporary', 'Google Business không trả mã bài.');
    // Google duyệt bài bất đồng bộ: PROCESSING chưa hiện trên Google và có thể thành REJECTED. Hỏi lại chính bài đó (không tạo lại).
    let state = post.state;
    let searchUrl = post.searchUrl ?? null;
    const deadline = Date.now() + STATE_WAIT_MS;
    while (state === 'PROCESSING' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      const p = await this.call<{ state?: string; searchUrl?: string }>('GET', `${V4}/${gbpLocationPath(account.external_id)}/localPosts/${id}`, account.access_token);
      state = p.state;
      searchUrl = p.searchUrl ?? searchUrl;
    }
    if (state === 'REJECTED') throw new SocialPublishError('invalid', 'Google từ chối bài cập nhật (vi phạm chính sách nội dung).');
    // Vẫn PROCESSING sau thời gian chờ: bài đã tạo trên Google (không tạo lại); lượt lấy số đối chiếu tiếp, bị từ chối thì đánh dấu.
    return { external_post_id: id, url: state === 'LIVE' ? searchUrl : null };
  }

  /**
   * Google không trả lượt xem/tương tác của bài cập nhật qua API này (cần Performance API riêng) ⇒ số để trống.
   * Dùng lượt lấy số để đối chiếu trạng thái: bài bị Google từ chối hoặc đã bị xoá ⇒ đánh dấu "không còn trên kênh".
   */
  async fetchMetrics(account: AccountForPublish, externalPostId: string): Promise<PostMetrics> {
    if (!/^[\w-]+$/.test(externalPostId)) throw new SocialPublishError('invalid', 'Google Business: mã bài không hợp lệ.');
    let p: { state?: string };
    try {
      p = await this.call<{ state?: string }>('GET', `${V4}/${gbpLocationPath(account.external_id)}/localPosts/${externalPostId}`, account.access_token);
    } catch (err) {
      if (err instanceof SocialPublishError && /404|not found|NOT_FOUND/i.test(err.message)) throw new SocialPostGoneError('Bài không còn trên Google.');
      throw err;
    }
    if (p.state === 'REJECTED') throw new SocialPostGoneError('Google từ chối bài cập nhật.');
    return { views: null, reactions: null, comments: null, shares: null };
  }

  async deletePost(account: AccountForPublish, externalPostId: string): Promise<void> {
    if (!/^[\w-]+$/.test(externalPostId)) throw new SocialPublishError('invalid', 'Google Business: mã bài không hợp lệ.');
    await this.call('DELETE', `${V4}/${gbpLocationPath(account.external_id)}/localPosts/${externalPostId}`, account.access_token);
  }

  /** Một trang đánh giá (mới cập nhật trước), kèm điểm trung bình và tổng số. */
  async listReviews(account: AccountForPublish, pageToken?: string): Promise<{ reviews: GbpReview[]; average: number | null; total: number; next_page_token: string | null }> {
    const q = new URLSearchParams({ pageSize: '50', orderBy: 'updateTime desc' });
    if (pageToken) q.set('pageToken', pageToken);
    const r = await this.call<{ reviews?: RawReview[]; averageRating?: number; totalReviewCount?: number; nextPageToken?: string }>(
      'GET',
      `${V4}/${gbpLocationPath(account.external_id)}/reviews?${q.toString()}`,
      account.access_token,
    );
    return { reviews: (r.reviews ?? []).map(mapReview), average: r.averageRating ?? null, total: r.totalReviewCount ?? 0, next_page_token: r.nextPageToken ?? null };
  }

  /** Trả lời (hoặc sửa câu trả lời) một đánh giá — câu trả lời hiện công khai trên Google. */
  async replyReview(account: AccountForPublish, reviewId: string, comment: string): Promise<{ comment: string; updated_at: string | null }> {
    if (!/^[\w-]+$/.test(reviewId)) throw new SocialPublishError('invalid', 'Google Business: mã đánh giá không hợp lệ.');
    const text = comment.trim();
    if (!text) throw new SocialPublishError('invalid', 'Nội dung trả lời trống.');
    if (Buffer.byteLength(text, 'utf8') > GBP_REPLY_MAX_BYTES) throw new SocialPublishError('invalid', 'Câu trả lời quá dài (Google cho tối đa 4.096 byte).');
    const r = await this.call<{ comment?: string; updateTime?: string }>('PUT', `${V4}/${gbpLocationPath(account.external_id)}/reviews/${reviewId}/reply`, account.access_token, { comment: text });
    return { comment: r.comment ?? text, updated_at: r.updateTime ?? null };
  }

  /** Gom đủ các trang của một danh sách (accounts / locations). */
  private async collect<T>(url: string, key: string, token: string): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 20; i++) {
      const u = pageToken ? `${url}${url.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(pageToken)}` : url;
      const r = await this.call<Record<string, unknown> & { nextPageToken?: string }>('GET', u, token);
      out.push(...((r[key] as T[] | undefined) ?? []));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  private async token(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
    const res = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const json = (await safeJson(res)) as { access_token?: string };
    if (!res.ok || !json.access_token) throw gbpError(res.status, json);
    return json as { access_token: string };
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=UTF-8';
    const res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await safeJson(res);
    if (!res.ok) throw gbpError(res.status, json);
    return json as T;
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new SocialPublishError('temporary', `Không gọi được Google (${(err as Error).name})`);
    }
  }
}

/** Lỗi Google → loại lỗi; đổi chữ "YouTube" của bộ phân loại chung sang "Google Business"; quota 0 (chưa duyệt) báo rõ. */
export function gbpError(status: number, body: Record<string, unknown>): SocialPublishError {
  const e = classifyGoogleError(status, body as never);
  const msg = e.message.replace(/YouTube/g, 'Google Business').replace(/ video/g, ' bài');
  if (status === 429 && /quota|per minute|0/i.test(JSON.stringify(body))) {
    return new SocialPublishError('rate', 'Google Business: dự án chưa được Google cấp hạn mức API (đang chờ duyệt) hoặc đã hết hạn mức.');
  }
  return new SocialPublishError(e.kind, msg);
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}
