/**
 * Số điện thoại Việt Nam (thuần, không DB) — bộ chuẩn hoá DUY NHẤT cho danh bạ, nhập Sheet, webhook vào, Fanpage,
 * API công khai, kết nối và tool MCP.
 */

/**
 * Chuẩn hoá SĐT về dạng nội địa `0xxxxxxxxx`. Nhận `0…`, `+84…`, `84…`, `0084…`, `+84 (0) 9…` (số 0 thừa sau mã nước),
 * bỏ dấu cách, chấm, gạch, ngoặc. Không mã nước mà chỉ 9 số (Excel/Sheet làm rụng số 0 đầu) thì chỉ nhận đầu di động
 * 3/5/7/8/9. Không hợp lệ → null.
 */
export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const d = raw.replace(/[\s.\-()]/g, '');
  if (!/^\+?\d+$/.test(d)) return null;
  let rest: string;
  if (d.startsWith('+84')) rest = d.slice(3);
  else if (d.startsWith('+')) return null;
  else if (d.startsWith('0084')) rest = d.slice(4);
  else if (d.startsWith('84') && (d.length === 11 || (d.length === 12 && d[2] === '0'))) rest = d.slice(2);
  else if (d.startsWith('0')) return /^0\d{9}$/.test(d) ? d : null;
  else return /^[35789]\d{8}$/.test(d) ? `0${d}` : null;
  // Sau mã nước: 9 số, hoặc "(0)" + 9 số.
  if (/^0[1-9]\d{8}$/.test(rest)) return rest;
  return /^[1-9]\d{8}$/.test(rest) ? `0${rest}` : null;
}

/** Các dạng lưu có thể có của cùng một SĐT nội địa (0…, 84…, +84…) — dùng khi kiểm trùng. */
export function phoneVariants(local: string): string[] {
  return /^0\d{9}$/.test(local) ? [local, `84${local.slice(1)}`, `+84${local.slice(1)}`] : [local];
}
