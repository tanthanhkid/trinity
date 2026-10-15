import { integrationFlags } from '@trinity/prisma';

/** Scope MCP. `crm.write` cho phép AI GHI dữ liệu ngay, trong đúng quyền của người dùng (trừ khi quản trị viên bật "Yêu cầu duyệt thay đổi do AI" ⇒ AI chỉ tạo đề xuất chờ duyệt). */
export const OAUTH_SCOPES = ['crm.read', 'crm.write'] as const;
export type OauthScope = (typeof OAUTH_SCOPES)[number];
/** Giá trị quảng bá ở AS metadata. `offline_access` chỉ để client (Claude) xin refresh token; ta luôn cấp refresh, không lưu scope này. */
export const ADVERTISED_SCOPES: readonly string[] = [...OAUTH_SCOPES, 'offline_access'];
export const DEFAULT_SCOPES: readonly OauthScope[] = ['crm.read'];

export const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_SEC = 60 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CONSENT_TTL_SEC = 10 * 60;

/** Nhãn tiếng Việt cho màn đồng ý. */
export const SCOPE_LABELS: Record<OauthScope, { label: string; description: string; available: boolean; optional: boolean }> = {
  'crm.read': {
    label: 'Đọc dữ liệu CRM',
    description: 'Xem khách hàng, deal, lịch sử chăm sóc, công việc và báo cáo tổng quan trong ĐÚNG phạm vi quyền của bạn. Số điện thoại luôn bị che.',
    available: true,
    optional: false,
  },
  'crm.write': {
    label: 'Cho phép AI thay đổi dữ liệu (trong phạm vi quyền của bạn)',
    description:
      'Cho phép ứng dụng GHI dữ liệu trực tiếp: tạo khách hàng, thêm ghi chú, đổi giai đoạn, tạo công việc, chuyển người phụ trách, tạo/sửa bản ghi của bảng tuỳ biến, nhập dữ liệu hàng loạt. Thay đổi có hiệu lực NGAY, theo đúng quyền và phạm vi dữ liệu của bạn — AI không làm được gì bạn không làm được. Mọi thao tác được ghi lại ở mục Hoạt động AI. Bỏ chọn quyền này nếu chỉ muốn AI đọc dữ liệu.',
    available: true,
    optional: true,
  },
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * URL gốc công khai (`INTEGRATIONS_PUBLIC_BASE_URL`, vd `https://crm.example.com`). 🔴 KHÔNG suy từ header `Host` của request:
 * issuer/`resource`/`authorization_endpoint` mà suy từ header client gửi được thì metadata bị đầu độc (mix-up).
 * Phải là https (http chỉ cho localhost khi NODE_ENV=test|development), không path/query/fragment/userinfo.
 */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  let raw = (env.INTEGRATIONS_PUBLIC_BASE_URL ?? '').trim();
  // Vercel injects the production hostname itself (system env, not client-controlled), so a fresh deploy needs no extra setting.
  if (!raw && env.VERCEL === '1' && env.VERCEL_PROJECT_PRODUCTION_URL) raw = `https://${env.VERCEL_PROJECT_PRODUCTION_URL.trim()}`;
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const devOk = (env.NODE_ENV === 'test' || env.NODE_ENV === 'development') && u.protocol === 'http:' && LOOPBACK.has(u.hostname);
  if (u.protocol !== 'https:' && !devOk) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  return u.origin;
}

export const issuerUrl = (base: string): string => `${base}/api/v1/oauth`;
export const mcpResourceUrl = (base: string): string => `${base}/api/v1/mcp`;
export const authorizationEndpoint = (base: string): string => `${base}/oauth/authorize`;
/** URL PRM mà `WWW-Authenticate` trỏ tới — phục vụ THẲNG bởi monolith (không phụ thuộc rewrite của Next). */
export const protectedResourceMetadataUrl = (base: string): string => `${issuerUrl(base)}/protected-resource`;

/** Cờ + URL gốc: thiếu 1 trong 2 ⇒ mọi route OAuth/MCP trả 404. */
export function oauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return integrationFlags.mcpEnabled(env) && publicBaseUrl(env) !== null;
}

/** So khớp `resource` (RFC 8707) với URL MCP chuẩn tắc — bỏ qua `/` cuối và hoa/thường của scheme+host. */
export function isCanonicalResource(candidate: string, base: string): boolean {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password || u.search) return false;
  const norm = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return norm === mcpResourceUrl(base);
}
