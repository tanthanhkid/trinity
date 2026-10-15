import { createHmac } from 'node:crypto';
import { safeEqual } from '../integrations/oauth/oauth-crypto';
import type { SocialMedia } from './providers/provider.types';

/** Hạn link: đủ cho mạng tải tệp (Instagram tải video có khi vài phút), không để link sống lâu. */
export const MEDIA_LINK_TTL_SEC = 2 * 60 * 60;

function key(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET chưa đặt');
  return createHmac('sha256', 'trinity-social-media-link-v1').update(secret).digest();
}

/**
 * Link tải tệp CÔNG KHAI có chữ ký cho mạng chỉ nhận ảnh/video qua URL (Instagram). Chứa key tệp + loại + hạn, ký HMAC;
 * không đăng nhập vẫn tải được nhưng chỉ đúng tệp đó, tới hết hạn.
 */
export function signMediaLink(m: Pick<SocialMedia, 'key' | 'content_type'>, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ k: m.key, t: m.content_type, e: Math.floor(now / 1000) + MEDIA_LINK_TTL_SEC })).toString('base64url');
  return `${body}.${createHmac('sha256', key()).update(body).digest('base64url')}`;
}

export function verifyMediaLink(token: string, now = Date.now()): { key: string; contentType: string } | null {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  if (!safeEqual(mac, createHmac('sha256', key()).update(body).digest('base64url'))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { k?: unknown; t?: unknown; e?: unknown };
    if (typeof c.k !== 'string' || typeof c.t !== 'string' || typeof c.e !== 'number' || c.e * 1000 < now) return null;
    return { key: c.k, contentType: c.t };
  } catch {
    return null;
  }
}

/** Đuôi tệp theo loại — Instagram đọc loại từ URL/headers; thêm đuôi cho chắc. */
export function mediaLinkExt(contentType: string): string {
  const map: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
  return map[contentType] ?? 'bin';
}
