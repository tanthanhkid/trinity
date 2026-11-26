/**
 * K29 — golden xlsx dùng chung với Rust (`server/crates/trinity-docgen`). Bảng mẫu: `server/contracts/cases/xlsx.json`.
 * - Bộ ghi tham chiếu bằng exceljs (thư viện bản Node đang dùng) ghi bảng mẫu, đọc lại ⇒ khớp `expected`.
 * - `exceljs.xlsx` (tệp exceljs ghi, Rust phải đọc được) và `rust.xlsx` (tệp Rust ghi) đọc bằng exceljs — bộ đọc của
 *   test hợp đồng — đều ra đúng `expected`, kể cả định dạng số/ngày của ô.
 * Ghi lại tệp exceljs.xlsx: `UPDATE_XLSX_FIXTURE=1 pnpm --filter @trinity/crm exec jest docgen-xlsx-golden`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ExcelJS from 'exceljs';

const ROOT = join(__dirname, '../../../../../..');
const CASES = JSON.parse(readFileSync(join(ROOT, 'server/contracts/cases/xlsx.json'), 'utf8')) as {
  sheet: string; title: string; subtitle: string; columns: Array<[string, number]>;
  rows: Array<Array<Record<string, unknown> | null>>; expected: unknown[][];
};
const FIXTURES = join(ROOT, 'server/crates/trinity-docgen/tests/fixtures');
const FMT: Record<string, string> = { int: '#,##0', dec2: '#,##0.00' };
/** Như `csvCell`: ô mở đầu bằng ký tự công thức ⇒ thêm `'`. */
const safe = (s: string) => (/^[=+\-@\t\r\n]/.test(s) ? `'${s}` : s);

async function writeWithExceljs(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(CASES.sheet);
  const last = CASES.columns.length;
  ws.mergeCells(1, 1, 1, last);
  ws.getCell(1, 1).value = CASES.title;
  ws.mergeCells(2, 1, 2, last);
  ws.getCell(2, 1).value = CASES.subtitle;
  CASES.columns.forEach(([h, w], i) => {
    ws.getCell(4, i + 1).value = h;
    ws.getColumn(i + 1).width = w;
  });
  CASES.rows.forEach((r, ri) =>
    r.forEach((c, ci) => {
      if (!c) return;
      const cell = ws.getCell(5 + ri, ci + 1);
      if (typeof c.s === 'string') cell.value = safe(c.s);
      else if (typeof c.n === 'number') {
        cell.value = c.n;
        if (typeof c.fmt === 'string') cell.numFmt = FMT[c.fmt];
      } else if (typeof c.b === 'boolean') cell.value = c.b;
      else if (typeof c.d === 'string') {
        cell.value = new Date(`${c.d}T00:00:00Z`);
        cell.numFmt = 'dd/mm/yyyy';
      } else if (typeof c.dt === 'string') {
        cell.value = new Date(Date.parse(c.dt) + 7 * 3_600_000); // giờ Việt Nam ghi như giờ hiển thị
        cell.numFmt = 'dd/mm/yyyy hh:mm';
      }
    }),
  );
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const p2 = (n: number) => String(n).padStart(2, '0');
const fmtOf = (c: ExcelJS.Cell) => (c.numFmt && c.numFmt !== 'General' ? c.numFmt : null);

/** Nội dung từng ô (ô phụ của vùng gộp ⇒ trống, như Rust/calamine), bỏ ô trống cuối dòng. */
async function dump(buf: Buffer): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const ws = wb.worksheets[0];
  const out: unknown[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row: unknown[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const cell = ws.getCell(r, c);
      const v = cell.isMerged && cell.master !== cell ? null : cell.value;
      if (v === null || v === undefined || v === '') row.push(null);
      else if (typeof v === 'string') row.push({ t: 's', v });
      else if (typeof v === 'number') row.push({ t: 'n', v, f: fmtOf(cell) });
      else if (typeof v === 'boolean') row.push({ t: 'b', v });
      else if (v instanceof Date) {
        const t = new Date(Math.round(v.getTime() / 1000) * 1000);
        row.push({ t: 'd', v: `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())} ${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())}`, f: fmtOf(cell) });
      } else row.push({ t: '?', v: JSON.stringify(v) });
    }
    while (row.length && row[row.length - 1] === null) row.pop();
    out.push(row);
  }
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out;
}

describe('golden xlsx (exceljs ↔ Rust)', () => {
  it('bộ ghi tham chiếu exceljs ra đúng nội dung mẫu', async () => {
    const buf = await writeWithExceljs();
    if (process.env.UPDATE_XLSX_FIXTURE === '1') writeFileSync(join(FIXTURES, 'exceljs.xlsx'), buf);
    expect(await dump(buf)).toEqual(CASES.expected);
  });

  it.each(['exceljs.xlsx', 'rust.xlsx'])('%s đọc bằng exceljs khớp mẫu (giá trị + định dạng số/ngày)', async (name) => {
    const file = join(FIXTURES, name);
    expect(existsSync(file)).toBe(true);
    expect(await dump(readFileSync(file))).toEqual(CASES.expected);
  });
});
