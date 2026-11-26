/**
 * Số điện thoại Việt Nam (thuần, không DB) — dùng chung cho danh bạ, API công khai, kết nối và tool MCP.
 */

/** Chuẩn hoá SĐT về dạng nội địa 0xxxxxxxxx (nhận +84/84/0, bỏ dấu cách chấm gạch). Không hợp lệ → null. */
export function normalizePhone(raw: string | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[\s.\-()]/g, '');
  if (d.startsWith('+84')) d = `0${d.slice(3)}`;
  else if (d.startsWith('84') && d.length === 11) d = `0${d.slice(2)}`;
  else if (/^[1-9]\d{8}$/.test(d)) d = `0${d}`; // Excel/Sheet hay làm rụng số 0 đầu
  return /^0\d{9}$/.test(d) ? d : null;
}

/** Các dạng lưu có thể có của cùng một SĐT nội địa (0…, 84…, +84…) — dùng khi kiểm trùng. */
export function phoneVariants(local: string): string[] {
  return /^0\d{9}$/.test(local) ? [local, `84${local.slice(1)}`, `+84${local.slice(1)}`] : [local];
}
