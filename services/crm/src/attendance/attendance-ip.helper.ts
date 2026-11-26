import type { Request } from 'express';
import { resolveClientIp } from '@trinity/rbac-nest';

export interface AttendanceOfficeIp {
  id: number;
  ips: string[];
  name: string;
}

/**
 * Chuẩn hoá IP: bỏ prefix ::ffff: (IPv4-mapped IPv6) và trim khoảng trắng.
 */
export function normalizeIp(raw: string): string {
  return raw.replace(/^::ffff:/i, '').trim();
}

/**
 * IP khách để chấm công — từ hàm dùng chung `resolveClientIp` (`@trinity/rbac-nest`, cấu hình `TRUSTED_PROXY`; xem
 * docs/deployment.md mục "Client IP"). Không còn đọc header ở đây.
 *
 * `null` = IP KHÔNG tin được (thiếu cấu hình proxy: loopback, cổng mặc định của container, dấu "không tin được" của
 * tiến trình biên). Khi đó KHÔNG đem so với IP văn phòng và KHÔNG khoá nhân viên: chấm công cho qua, lỗi cấu hình đã
 * được ghi log và dải cảnh báo quản trị bật (`resolveClientIp`).
 */
export function extractClientIp(req: Request): string | null {
  return resolveClientIp(req).ip;
}

/**
 * Kiểm tra IP đã chuẩn hoá có khớp với danh sách IP văn phòng không.
 */
export function ipMatchesOffice(clientIp: string, officeIps: string[]): boolean {
  const normalized = normalizeIp(clientIp);
  return officeIps.map(normalizeIp).includes(normalized);
}
