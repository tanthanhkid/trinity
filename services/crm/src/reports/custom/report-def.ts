/**
 * Báo cáo dùng chung (#25) — định nghĩa do quản trị viên cấu hình, áp được cho MỌI bảng (lõi + tuỳ biến):
 * chọn bảng nguồn, trường ngày để chia kỳ, các cột cộng tổng, trường nhóm. Không có gì riêng một ngành —
 * mẫu cho từng ngành chỉ là một bộ định nghĩa cài sẵn (`report-presets.ts`).
 * Lưu một khoá JSON trong bảng `settings` (`REPORT_DEFS_KEY`) — không cần migration.
 */

export const REPORT_DEFS_KEY = 'report.definitions';

export const REPORT_LIMITS = { maxReports: 50, maxSums: 4, maxName: 80, maxGroups: 50, maxMonths: 24 } as const;

/** Nguồn: `contacts` · `deals` · `x:<khoá bảng tuỳ biến>`. */
export type ReportSourceKey = string;

export interface ReportDef {
  id: string;
  name: string;
  source: ReportSourceKey;
  /** Trường ngày chia kỳ (Tháng này / Tháng / Năm / Tất cả). */
  date_field: string;
  /** Các cột số được cộng tổng (ngoài số bản ghi luôn có). */
  sum_fields: string[];
  /** Trường nhóm (lựa chọn / người phụ trách / liên kết) — null = không nhóm. */
  group_by: string | null;
  /** Mẫu đã cài (vd `giao_duc`) — chỉ để biết nguồn gốc, không đổi cách chạy. */
  preset?: string;
}

export class ReportDefError extends Error {}

const ID_RE = /^[a-z][a-z0-9_]{0,47}$/;
const SOURCE_RE = /^(contacts|deals|x:[a-z][a-z0-9_]{0,47})$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,47}$/;

function str(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.trim() === '') throw new ReportDefError(`${what} không được trống`);
  const s = v.trim();
  if (s.length > max) throw new ReportDefError(`${what} tối đa ${max} ký tự`);
  return s;
}

function fieldKey(v: unknown, what: string): string {
  const s = str(v, what, 48);
  if (!FIELD_RE.test(s)) throw new ReportDefError(`${what} “${s.slice(0, 30)}” không hợp lệ`);
  return s;
}

/** Kiểm HÌNH DẠNG danh sách định nghĩa (trường có thật trong bảng không là việc của service). */
export function normalizeReportDefs(raw: unknown): ReportDef[] {
  if (!Array.isArray(raw)) throw new ReportDefError('Danh sách báo cáo phải là mảng');
  if (raw.length > REPORT_LIMITS.maxReports) throw new ReportDefError(`Tối đa ${REPORT_LIMITS.maxReports} báo cáo`);
  const seen = new Set<string>();
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object') throw new ReportDefError(`Báo cáo #${i + 1} không hợp lệ`);
    const o = r as Record<string, unknown>;
    const id = str(o.id, 'Mã báo cáo', 48);
    if (!ID_RE.test(id)) throw new ReportDefError(`Mã báo cáo “${id.slice(0, 30)}” chỉ gồm a-z, 0-9, _`);
    if (seen.has(id)) throw new ReportDefError(`Trùng mã báo cáo “${id}”`);
    seen.add(id);
    const name = str(o.name, 'Tên báo cáo', REPORT_LIMITS.maxName);
    const source = str(o.source, 'Bảng nguồn', 50);
    if (!SOURCE_RE.test(source)) throw new ReportDefError(`Bảng nguồn “${source.slice(0, 30)}” không hợp lệ`);
    const sums = o.sum_fields ?? [];
    if (!Array.isArray(sums)) throw new ReportDefError('Cột cộng tổng phải là danh sách');
    if (sums.length > REPORT_LIMITS.maxSums) throw new ReportDefError(`Tối đa ${REPORT_LIMITS.maxSums} cột cộng tổng`);
    const def: ReportDef = {
      id,
      name,
      source,
      date_field: fieldKey(o.date_field, 'Trường ngày'),
      sum_fields: [...new Set(sums.map((s) => fieldKey(s, 'Cột cộng tổng')))],
      group_by: o.group_by == null || o.group_by === '' ? null : fieldKey(o.group_by, 'Trường nhóm'),
    };
    if (typeof o.preset === 'string' && FIELD_RE.test(o.preset)) def.preset = o.preset;
    return def;
  });
}

/** Kỳ báo cáo: `this_month` · `month:YYYY-MM` · `year:YYYY` · `all`. */
export type ReportPeriod = { kind: 'all' } | { kind: 'range'; from: string; to: string; label: string };

/** Hôm nay theo giờ VN dạng YYYY-MM-DD. */
export function todayVnYmd(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Đọc kỳ từ query; sai dạng thì về "Tháng này". `to` là ngày ĐẦU kỳ sau (khoảng nửa mở). */
export function parseReportPeriod(raw: string | undefined, now = new Date()): ReportPeriod {
  const v = (raw ?? 'this_month').trim();
  if (v === 'all') return { kind: 'all' };
  let m = /^month:(\d{4})-(\d{2})$/.exec(v);
  if (m && +m[2] >= 1 && +m[2] <= 12) return monthRange(+m[1], +m[2]);
  m = /^year:(\d{4})$/.exec(v);
  if (m && +m[1] >= 1900 && +m[1] <= 2200) return { kind: 'range', from: `${m[1]}-01-01`, to: `${+m[1] + 1}-01-01`, label: `Năm ${m[1]}` };
  const [y, mo] = todayVnYmd(now).split('-').map(Number);
  return monthRange(y, mo);
}

function monthRange(y: number, mo: number): ReportPeriod {
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  return { kind: 'range', from: `${y}-${pad(mo)}-01`, to: `${ny}-${pad(nm)}-01`, label: `Tháng ${mo}/${y}` };
}
