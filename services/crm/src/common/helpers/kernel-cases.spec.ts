/**
 * Bảng ca dùng chung TS ↔ Rust (K26, docs/rust/PLAN.md mục 6.3): `server/contracts/cases/kernel.json`.
 * Phía TS là chuẩn: spec này tính lại mọi ca bằng helper TS hiện có (và đúng kiểu gọi `toLocale*`/`Intl`/`localeCompare`
 * ở các chỗ dùng) rồi so với cột kết quả trong bảng. Rust chạy cùng bảng ở `server/crates/trinity-kernel/tests/`.
 * Sinh lại cột kết quả sau khi thêm ca: `UPDATE_KERNEL_CASES=1 npx jest kernel-cases` (trong services/crm).
 */
import * as fs from 'fs';
import * as path from 'path';
import { foldVi, SQL_FOLD_FROM, SQL_FOLD_TO } from '../../custom-objects/refs/fold-vi';
import { foldContains } from './fold-search.helper';
import { normalizePhone, phoneVariants } from './phone.helper';
import { parseVnDateRangeOptional } from './parse-vn-date-range.helper';

const FILE = path.resolve(__dirname, '../../../../../server/contracts/cases/kernel.json');
const TZ = 'Asia/Ho_Chi_Minh';

type Row = Record<string, unknown>;
type Table = Record<string, unknown> & { [k: string]: Row[] | unknown };

/** JSON không có NaN/±Infinity/-0: các giá trị này ghi dạng chuỗi. */
const num = (v: unknown): number => (typeof v === 'string' ? Number(v) : (v as number));

function part(d: Date, locale: string, opts: Intl.DateTimeFormatOptions, type: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts }).formatToParts(d).find((p) => p.type === type)?.value ?? '';
}

/** Mỗi kiểu là một cách gọi đang có trong mã TS (ghi chỗ gọi tiêu biểu). */
const DATE_STYLES: Record<string, (d: Date) => string> = {
  // contacts-export.service.ts: toLocaleDateString('vi-VN', VN_TZ)
  day_month_year: (d) => d.toLocaleDateString('vi-VN', { timeZone: TZ }),
  // employee-list-export.service.ts, employee-birthday-export.service.ts: en-GB formatToParts → dd/mm/yyyy
  day_month_year_2: (d) => {
    const o: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' };
    return `${part(d, 'en-GB', o, 'day')}/${part(d, 'en-GB', o, 'month')}/${part(d, 'en-GB', o, 'year')}`;
  },
  // attendance-export.service.ts formatVnTime, attendance-matrix.helper.ts vnHhmm
  hour_minute: (d) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d),
  // packages/utils formatDateTime (với múi giờ VN tường minh)
  hour_minute_day_month_year_2: (d) =>
    d.toLocaleString('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
  // integrations/mcp/actions/action-helpers.ts
  short_date_time: (d) => new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(d),
  // attendance.service.ts getVnDateString, ai-activity-tool.ts vnToday, report-def.ts
  iso_date: (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d),
  // payroll employees.service.ts, attendance-matrix-export.service.ts
  iso_month: (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(d),
  // reports/helpers/report-time-buckets.helper.ts formatVnLabel (ngày / tháng)
  day_month_2: (d) => {
    const o: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
    return `${part(d, 'en-CA', o, 'day')}/${part(d, 'en-CA', o, 'month')}`;
  },
  month_year_2: (d) => {
    const o: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
    return `${part(d, 'en-CA', o, 'month')}/${part(d, 'en-CA', o, 'year')}`;
  },
};

const COMPARE: Record<string, (a: string, b: string) => number> = {
  vi: (a, b) => a.localeCompare(b, 'vi'),
  'en-numeric': (a, b) => a.localeCompare(b, 'en', { numeric: true }),
  // Mã chạy thật gọi `localeCompare(b)` không locale = locale mặc định của tiến trình (en-US trên máy chủ và CI);
  // ghim 'en-US' để kết quả của spec không phụ thuộc máy chạy.
  root: (a, b) => a.localeCompare(b, 'en-US'),
};

function compute(t: Table): Table {
  const rows = (k: string) => t[k] as Row[];
  const err = (f: () => unknown) => {
    try {
      return f();
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  return {
    ...t,
    sql_fold: { from: SQL_FOLD_FROM, to: SQL_FOLD_TO },
    fold_vi: rows('fold_vi').map((r) => ({ in: r.in, out: foldVi(r.in as string) })),
    fold_contains: rows('fold_contains').map((r) => ({ in: r.in, out: foldContains(r.in as string) })),
    normalize_phone: rows('normalize_phone').map((r) => ({ in: r.in, out: normalizePhone(r.in as string) })),
    phone_variants: rows('phone_variants').map((r) => ({ in: r.in, out: phoneVariants(r.in as string) })),
    parse_vn_date_range_optional: rows('parse_vn_date_range_optional').map((r) => ({
      from: r.from,
      to: r.to,
      out: err(() => {
        const { dateFrom, dateTo } = parseVnDateRangeOptional(
          (r.from as string | null) ?? undefined,
          (r.to as string | null) ?? undefined,
        );
        // Bản TS để lọt `Invalid Date` (rồi lỗi 500 ở truy vấn); Rust trả 400. Ghi lại biên nào hỏng.
        if (dateFrom && Number.isNaN(dateFrom.getTime())) return { invalid_date: 'from' };
        if (dateTo && Number.isNaN(dateTo.getTime())) return { invalid_date: 'to' };
        return { from: dateFrom?.toISOString() ?? null, to: dateTo?.toISOString() ?? null };
      }),
    })),
    format_vn_number: rows('format_vn_number').map((r) => ({ in: r.in, out: num(r.in).toLocaleString('vi-VN') })),
    format_vn_date: rows('format_vn_date').map((r) => ({
      at: r.at,
      style: r.style,
      out: DATE_STYLES[r.style as string](new Date(r.at as string)),
    })),
    compare: rows('compare').map((r) => ({
      locale: r.locale,
      a: r.a,
      b: r.b,
      out: Math.sign(COMPARE[r.locale as string](r.a as string, r.b as string)),
    })),
  };
}

describe('bảng ca dùng chung TS ↔ Rust (server/contracts/cases/kernel.json)', () => {
  const fresh = compute(JSON.parse(fs.readFileSync(FILE, 'utf8')) as Table);
  // Chế độ sinh lại: ghi bảng mới rồi so với chính nó (lượt này chỉ để sinh; lượt thường mới là lượt kiểm).
  const update = process.env.UPDATE_KERNEL_CASES === '1';
  if (update) fs.writeFileSync(FILE, `${JSON.stringify(fresh, null, 1)}\n`);
  const table = update ? fresh : (JSON.parse(fs.readFileSync(FILE, 'utf8')) as Table);

  it('có ít nhất 300 ca', () => {
    const n = Object.values(fresh).reduce<number>((s, v) => s + (Array.isArray(v) ? v.length : 0), 0);
    expect(n).toBeGreaterThanOrEqual(300);
  });

  for (const key of Object.keys(fresh).filter((k) => k !== '_doc')) {
    it(`${key} khớp bản TS`, () => {
      expect(fresh[key]).toEqual(table[key]);
    });
  }
});
