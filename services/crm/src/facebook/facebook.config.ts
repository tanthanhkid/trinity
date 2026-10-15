import { publicBaseUrl } from '../integrations/oauth/oauth-config';

/**
 * Cấu hình Facebook qua env. Meta docs:
 * - Graph API versions: https://developers.facebook.com/docs/graph-api/changelog/versions
 * - Webhooks Messenger: https://developers.facebook.com/docs/messenger-platform/webhooks
 */
export const DEFAULT_GRAPH_VERSION = 'v25.0';

/**
 * Quyền xin khi đăng nhập Facebook — đúng bộ của use case Messenger trên app Meta (cần App Review ở chế độ Live).
 * Lead Ads cần thêm `leads_retrieval` + `pages_manage_ads` (use case Marketing): thêm lại khi app có use case đó,
 * nếu xin quyền app chưa có thì Facebook báo lỗi "Invalid Scopes" và không liên kết được.
 */
export const FACEBOOK_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
] as const;

/**
 * Trường webhook đăng ký cho mỗi Page. `messaging_referrals`: khách mở link/QR mở chat (`m.me/<page>?ref=`) khi đã có hội thoại. `leadgen` cần quyền `leads_retrieval` (use case Marketing): đăng ký kèm khi app
 * chưa có quyền đó thì Facebook từ chối CẢ lệnh, Page không nhận được tin nhắn nào.
 */
export const SUBSCRIBED_FIELDS = ['messages', 'messaging_postbacks', 'messaging_referrals'] as const;

/**
 * Tự xử lý bình luận (kiểu ManyChat): bật bằng `FACEBOOK_COMMENT_AUTOMATION=1` SAU KHI app Meta đã có các quyền dưới đây
 * (xin quyền app chưa có ⇒ "Invalid Scopes", không liên kết được). Bật rồi phải kết nối lại Fanpage để token có quyền mới.
 * - `pages_read_user_content`: đọc nội dung bình luận của người dùng.
 * - `pages_manage_engagement`: trả lời / ẩn bình luận.
 * - `pages_messaging` (đã có): Private Reply.
 * Docs: https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages
 *       https://developers.facebook.com/docs/messenger-platform/discovery/private-replies
 */
export const COMMENT_SCOPES = ['pages_read_user_content', 'pages_manage_engagement'] as const;
export const COMMENT_FIELDS = ['feed'] as const;

export function commentAutomationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes'].includes((env.FACEBOOK_COMMENT_AUTOMATION ?? '').trim().toLowerCase());
}

/** Quyền xin khi đăng nhập (thêm quyền bình luận khi đã bật). */
export function facebookScopes(env: NodeJS.ProcessEnv = process.env): string[] {
  return commentAutomationEnabled(env) ? [...FACEBOOK_SCOPES, ...COMMENT_SCOPES] : [...FACEBOOK_SCOPES];
}

/** Trường webhook đăng ký cho Page (thêm `feed` khi đã bật). */
export function subscribedFields(env: NodeJS.ProcessEnv = process.env): string[] {
  return commentAutomationEnabled(env) ? [...SUBSCRIBED_FIELDS, ...COMMENT_FIELDS] : [...SUBSCRIBED_FIELDS];
}

export interface FacebookConfig {
  appId: string;
  appSecret: string;
  verifyToken: string;
  graphVersion: string;
  /** URL gốc công khai (INTEGRATIONS_PUBLIC_BASE_URL) — dựng redirect_uri; null nếu chưa đặt. */
  baseUrl: string | null;
}

export function loadFacebookConfig(env: NodeJS.ProcessEnv = process.env): FacebookConfig {
  return {
    appId: (env.FACEBOOK_APP_ID ?? '').trim(),
    appSecret: (env.FACEBOOK_APP_SECRET ?? '').trim(),
    verifyToken: (env.FACEBOOK_WEBHOOK_VERIFY_TOKEN ?? '').trim(),
    graphVersion: (env.FACEBOOK_GRAPH_VERSION ?? '').trim() || DEFAULT_GRAPH_VERSION,
    baseUrl: publicBaseUrl(env),
  };
}

/** Đủ để chạy đăng nhập Facebook (app id/secret + URL gốc). Webhook cần thêm verify token. */
export function isFacebookConfigured(c: FacebookConfig): boolean {
  return Boolean(c.appId && c.appSecret && c.baseUrl);
}

/**
 * Chuyển tiếp webhook sang bản Trinity khác (vd PROD nhận chính rồi chuyển sang demo, vì mỗi app Meta chỉ có MỘT callback cho object Page).
 * Đặt `FACEBOOK_WEBHOOK_FORWARD_URL` = URL webhook đầy đủ của bản kia; hai bản phải dùng cùng app Meta (cùng app secret) vì body và chữ ký
 * `X-Hub-Signature-256` được chuyển NGUYÊN VĂN, bản kia tự kiểm chữ ký như khi Meta gửi thẳng.
 */
export function webhookForwardUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.FACEBOOK_WEBHOOK_FORWARD_URL ?? '').trim();
  return /^https?:\/\//.test(v) ? v : null;
}

/** Header đánh dấu sự kiện đã được chuyển tiếp một lần — bản nhận không chuyển tiếp tiếp nữa (chống vòng lặp). */
export const FORWARDED_HEADER = 'x-trinity-forwarded';

export const oauthRedirectUri = (c: FacebookConfig): string => `${c.baseUrl}/api/v1/facebook/oauth/callback`;
