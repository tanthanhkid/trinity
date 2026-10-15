/**
 * Ánh xạ cột ↔ trường CRM (thuần, không DB) — nhập và xuất dùng chung.
 * Mapping lưu dạng { khoá trường CRM: tên cột (nhãn ở dòng tiêu đề) }.
 */

export type ColumnMap = Record<string, string>;

/** Trường khách hàng cho phép ánh xạ (nhập ghi được; xuất đọc được). `phone` bắt buộc. */
export const CONTACT_FIELDS: ReadonlyArray<{ key: string; label: string; required?: boolean }> = [
  { key: 'phone', label: 'Số điện thoại', required: true },
  { key: 'full_name', label: 'Họ tên' },
  { key: 'email', label: 'Email' },
  { key: 'phone_2', label: 'Số điện thoại 2' },
  { key: 'zalo_account', label: 'Tài khoản Zalo' },
  { key: 'job_title', label: 'Nghề nghiệp / chức danh' },
  { key: 'company_name', label: 'Công ty' },
  { key: 'current_address', label: 'Địa chỉ hiện tại' },
];
export const CONTACT_FIELD_KEYS = CONTACT_FIELDS.map((f) => f.key);

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

export function normalizeEmail(raw: string | undefined): string | null {
  const e = (raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

/** Chỉ số cột theo tên tiêu đề (không phân biệt hoa/thường, bỏ khoảng trắng thừa); -1 nếu không có. */
export function columnIndex(headers: string[], name: string): number {
  const want = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === want);
}

export interface MappedRow {
  /** Số dòng trong Sheet (1-based, dòng tiêu đề = 1) — dùng báo lỗi cho người dùng. */
  row: number;
  fields: Record<string, string>;
}

export interface MapResult {
  rows: MappedRow[];
  /** Cột đã ánh xạ nhưng không có trong dòng tiêu đề (cấu hình lỗi thời) — dừng nhập, báo rõ. */
  missingColumns: string[];
}

/** Dòng 1 = tiêu đề; từ dòng 2 là dữ liệu. Bỏ dòng trống hoàn toàn ở các cột đã ánh xạ. */
export function mapRows(values: string[][], map: ColumnMap): MapResult {
  const headers = values[0] ?? [];
  const idx: Array<[string, number]> = [];
  const missingColumns: string[] = [];
  for (const [field, col] of Object.entries(map)) {
    const i = columnIndex(headers, col);
    if (i < 0) missingColumns.push(col);
    else idx.push([field, i]);
  }
  const rows: MappedRow[] = [];
  for (let r = 1; r < values.length; r++) {
    const fields: Record<string, string> = {};
    for (const [field, i] of idx) fields[field] = (values[r][i] ?? '').trim();
    if (Object.values(fields).some((v) => v !== '')) rows.push({ row: r + 1, fields });
  }
  return { rows, missingColumns };
}

/** Giá trị khử trùng của một dòng (đã chuẩn hoá) hoặc null nếu dòng không có/không hợp lệ. */
export function dedupeValue(key: string, fields: Record<string, string>): string | null {
  const raw = fields[key];
  if (key === 'phone') return normalizePhone(raw);
  if (key === 'email') return normalizeEmail(raw);
  const v = (raw ?? '').trim();
  return v === '' ? null : v.toLowerCase();
}

/** Khử trùng TRONG file: dòng sau cùng khoá bị coi là trùng (giữ dòng đầu), trả số trùng. */
export function dropDuplicateRows(rows: MappedRow[], key: string): { kept: MappedRow[]; duplicates: number; invalid: MappedRow[] } {
  const seen = new Set<string>();
  const kept: MappedRow[] = [];
  const invalid: MappedRow[] = [];
  let duplicates = 0;
  for (const r of rows) {
    const v = dedupeValue(key, r.fields);
    if (v === null) { invalid.push(r); continue; }
    if (seen.has(v)) { duplicates++; continue; }
    seen.add(v);
    kept.push(r);
  }
  return { kept, duplicates, invalid };
}
