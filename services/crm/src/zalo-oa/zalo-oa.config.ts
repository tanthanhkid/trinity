/**
 * Cấu hình Zalo OA chính thức — toàn bộ qua env, KHÔNG có giá trị mặc định cho secret.
 * Nguồn tài liệu: https://developers.zalo.me/docs/official-account (OAuth v4 của OA, Webhook, API v3.0, ZNS).
 */
export const ZALO_URLS = {
  /** Trang người quản trị OA cấp quyền cho ứng dụng (OAuth v4, hỗ trợ PKCE). */
  permission: 'https://oauth.zaloapp.com/v4/oa/permission',
  /** Đổi code → token, và làm mới token (header `secret_key` = khoá bí mật của ứng dụng). */
  token: 'https://oauth.zaloapp.com/v4/oa/access_token',
  /** OA API v3.0 (gửi tin tư vấn, lấy hồ sơ người dùng). */
  api: 'https://openapi.zalo.me/v3.0/oa',
  /** ZNS: gửi tin thông báo theo mẫu đã duyệt. */
  zns: 'https://business.openapi.zalo.me/message/template',
} as const;

/** Tin tư vấn chỉ gửi được trong 48 giờ kể từ tin gần nhất của khách. */
export const CONSULT_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Làm mới token khi còn dưới ngần này so với hạn. */
export const REFRESH_SKEW_MS = 10 * 60 * 1000;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface ZaloOaConfig {
  appId: string | null;
  appSecret: string | null;
  /** "Khoá bí mật OA" — dùng ký webhook (`ZALO_WEBHOOK_SECRET`). */
  webhookSecret: string | null;
  /** URL callback khai trên Zalo (ứng dụng > Official Account > Cài đặt chung). */
  redirectUri: string | null;
  /** Nơi đưa trình duyệt về sau khi cấp quyền. */
  postConnectUrl: string;
  /** 'development' = ZNS chế độ thử (chỉ tới số quản trị đã khai, không tốn quota). */
  znsMode: 'development' | null;
}

const clean = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);

export function zaloOaConfig(env: NodeJS.ProcessEnv = process.env): ZaloOaConfig {
  return {
    appId: clean(env.ZALO_OA_APP_ID),
    appSecret: clean(env.ZALO_OA_APP_SECRET),
    webhookSecret: clean(env.ZALO_WEBHOOK_SECRET),
    redirectUri: clean(env.ZALO_OA_REDIRECT_URI),
    postConnectUrl: clean(env.ZALO_OA_POST_CONNECT_URL) ?? '/settings',
    znsMode: clean(env.ZALO_ZNS_MODE) === 'development' ? 'development' : null,
  };
}

/** Đủ biến để chạy luồng OAuth + gọi API. Webhook cần thêm `webhookSecret`. */
export function isZaloOaConfigured(c: ZaloOaConfig = zaloOaConfig()): boolean {
  return Boolean(c.appId && c.appSecret && c.redirectUri);
}

/** 0912… / +84912… / 84912… → 84912… (định dạng Zalo/ZNS yêu cầu). null nếu không giống SĐT VN. */
export function toZaloPhone(raw: string): string | null {
  const d = raw.replace(/[\s.\-()]/g, '').replace(/^\+/, '');
  if (/^0\d{9}$/.test(d)) return `84${d.slice(1)}`;
  if (/^84\d{9}$/.test(d)) return d;
  return null;
}

/** 84912… → 0912… (định dạng lưu trong Contact). */
export const toLocalPhone = (zalo: string): string => (zalo.startsWith('84') ? `0${zalo.slice(2)}` : zalo);
