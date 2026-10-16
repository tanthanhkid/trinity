import { publicBaseUrl } from '../integrations/oauth/oauth-config';

/** Scope tối thiểu: đọc/ghi Sheet + file do chính app tạo. KHÔNG xin quyền đọc toàn bộ Drive. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
] as const;

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Client id/secret nằm ở env (KHÔNG ở DB, KHÔNG ở mã). Thiếu một trong hai → null: màn hình báo "chưa cấu hình",
 * module vẫn khởi động bình thường. `redirectUri` mặc định suy từ INTEGRATIONS_PUBLIC_BASE_URL.
 */
export function loadGoogleConfig(env: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const explicit = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  const base = publicBaseUrl(env);
  const redirectUri = explicit || (base ? `${base}/api/v1/integrations/google/oauth/callback` : '');
  if (!redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/** Trang web sau khi nối xong Google (người dùng được chuyển về đây). */
export function settingsReturnUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = publicBaseUrl(env) ?? env.WEB_BASE_URL ?? '';
  return `${base}/connections?muc=google-sheets&google=`;
}
