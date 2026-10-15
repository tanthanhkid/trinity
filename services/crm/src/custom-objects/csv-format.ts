import type { FieldDef } from './field-types';
import type { RecordView, RelationLabel } from './record-presenter.service';

/** Chống “CSV injection”: ô văn bản bắt đầu bằng = + - @ hoặc tab/CR bị Excel hiểu là công thức. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const p2 = (n: number): string => String(n).padStart(2, '0');

export function vnDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}

export function vnDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t + 7 * 3_600_000);
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

const titles = (v: RelationLabel | RelationLabel[] | undefined): string =>
  (Array.isArray(v) ? v : v ? [v] : []).map((x) => (x.title === null ? '(không xem được)' : x.code ? `${x.code} ${x.title}` : x.title)).join('; ');

/** Giá trị 1 ô xuất CSV: nhãn thay vì mã, ngày dd/mm/yyyy, SĐT đã che sẵn bởi presenter. */
export function exportValue(f: FieldDef, view: RecordView): unknown {
  const v = view.data[f.key];
  if (v === undefined || v === null) return '';
  switch (f.type) {
    case 'date': return vnDate(String(v));
    case 'datetime': return vnDateTime(String(v));
    case 'boolean': return v === true ? 'Có' : 'Không';
    case 'select': return f.options.choices?.find((c) => c.value === v)?.label ?? v;
    case 'multi_select': return (Array.isArray(v) ? v : []).map((x) => f.options.choices?.find((c) => c.value === x)?.label ?? x).join('; ');
    case 'relation': case 'user': case 'link': return titles(view.relations[f.key]);
    default: return v;
  }
}
