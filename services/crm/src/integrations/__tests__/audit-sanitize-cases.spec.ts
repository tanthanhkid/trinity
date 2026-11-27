/**
 * Bảng ca dùng chung TS ↔ Rust (C12b, docs/rust/PLAN.md mục 6.3): `server/contracts/cases/audit-sanitize.json`.
 * Hai ca e2e cũ gọi `IntegrationAuditService.log` rồi đọc dòng nhật ký để kiểm "nhật ký KHÔNG lưu SĐT đầy đủ/secret dù caller nhét vào";
 * ở hộp đen không có đường gọi trực tiếp, nên phần che dữ liệu thành bảng ca cho hàm thuần `sanitizeText` / `sanitizeMetadata`
 * (đúng hai hàm `log` dùng cho `error` và `metadata`). Phía TS là chuẩn: spec tính lại mọi ca rồi so với cột `expect` trong bảng và
 * khẳng định không chuỗi nhạy cảm nào còn sót. Rust chạy cùng bảng khi viết lại bộ che nhật ký.
 * Sinh lại cột kết quả sau khi thêm ca: `UPDATE_AUDIT_CASES=1 npx jest audit-sanitize-cases` (trong services/crm).
 */
import * as fs from 'fs';
import * as path from 'path';
import { MAX_ERROR, MAX_STRING, sanitizeMetadata, sanitizeText } from '../../../../../packages/prisma/src/integrations/audit-sanitize';

const FILE = path.resolve(__dirname, '../../../../../server/contracts/cases/audit-sanitize.json');

interface TextCase { name: string; input: string; max?: number; leaks: string[]; expect?: string }
interface MetaCase { name: string; input: Record<string, unknown> | null; leaks: string[]; expect?: unknown }
interface Table { _doc: string; limits: { max_string: number; max_error: number }; text: TextCase[]; metadata: MetaCase[] }

/** Cột `error` của `log` cắt theo MAX_ERROR; `metadata` theo MAX_STRING cho từng chuỗi. */
const run = {
  text: (c: TextCase): string => sanitizeText(c.input, c.max ?? MAX_ERROR),
  metadata: (c: MetaCase): unknown => JSON.parse(JSON.stringify(sanitizeMetadata(c.input))),
};

describe('bảng ca che nhật ký tích hợp (server/contracts/cases/audit-sanitize.json)', () => {
  const table = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Table;
  const update = process.env.UPDATE_AUDIT_CASES === '1';

  it('hằng giới hạn khớp mã', () => {
    expect(table.limits).toEqual({ max_string: MAX_STRING, max_error: MAX_ERROR });
  });

  it.each(table.text.map((c) => [c.name, c] as const))('text: %s', (_n, c) => {
    const out = run.text(c);
    for (const leak of c.leaks) expect(out).not.toContain(leak);
    if (update) c.expect = out;
    else expect(out).toBe(c.expect);
  });

  it.each(table.metadata.map((c) => [c.name, c] as const))('metadata: %s', (_n, c) => {
    const out = run.metadata(c);
    const json = JSON.stringify(out);
    for (const leak of c.leaks) expect(json).not.toContain(leak);
    if (update) c.expect = out;
    else expect(out).toEqual(c.expect);
  });

  afterAll(() => {
    if (update) fs.writeFileSync(FILE, `${JSON.stringify(table, null, 1)}\n`);
  });
});
