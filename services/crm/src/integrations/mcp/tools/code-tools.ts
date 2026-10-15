import { parseCode } from '../../../custom-objects/record-codes';
import type { RefView } from '../../../custom-objects/refs/ref-types';
import { wrapData } from '../ai-output';
import { ToolUserError, type ToolDef } from './tool-types';

/** Khoá bảng theo cách AI gọi (describe_schema): bảng tuỳ biến = khoá bảng; bảng lõi = contacts | deals | tasks. */
export function tableKeyOf(v: RefView): string {
  if (v.type === 'record') return v.table_key ?? '';
  return v.type === 'contact' ? 'contacts' : v.type === 'deal' ? 'deals' : 'tasks';
}

export function refOut(v: RefView, baseUrl?: string): Record<string, unknown> {
  return { code: v.code, object: tableKeyOf(v), id: v.id, title: v.title, table: v.table, ref: v.ref, open_at: v.href ? `${baseUrl ?? ''}${v.href}` : null };
}

/** Chuẩn hoá danh sách mã AI gửi: bỏ "@", in hoa, đệm số; sai dạng ⇒ lỗi AI sửa được. */
export function readCodes(raw: unknown, max = 50): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const x of list) {
    if (typeof x !== 'string' || !x.trim()) continue;
    const c = parseCode(x.replace(/^@/, ''));
    if (!c) throw new ToolUserError(`“${String(x).slice(0, 30)}” không phải mã bản ghi (dạng tiền tố 2–4 chữ + số, vd SP001, KH012).`);
    if (!out.includes(c.code)) out.push(c.code);
  }
  if (out.length === 0) throw new ToolUserError('Cần ít nhất một mã, vd ["SP001"].');
  if (out.length > max) throw new ToolUserError(`Tối đa ${max} mã mỗi lần.`);
  return out;
}

export const findByCodeTool: ToolDef = {
  name: 'find_by_code',
  title: 'Tra bản ghi theo mã (SP001, KH012…) / Find records by code',
  description:
    'Mỗi bản ghi trong Trinity có MÃ CHUNG = tiền tố của bảng + số (sản phẩm SP001, khách hàng KH001, deal DL001, việc CV001; describe_schema cho biết tiền tố từng bảng). ' +
    'Tool này đổi danh sách mã → {object, id, title, table, open_at} trong phạm vi quyền xem của bạn (mã cũ trước khi đổi tiền tố vẫn tra được). Mã không thấy nằm ở not_found ' +
    '(không phân biệt "không tồn tại" và "không có quyền"). Dùng trước get_record/update_record khi người dùng nói theo mã, hoặc để kiểm mã trước khi gắn liên kết. Chỉ đọc. / ' +
    'Resolves record codes (SP001…) to {object, id, title} within your permissions.',
  permissions: [],
  input: (z) => ({ codes: z.array(z.string().min(2).max(20)).min(1).max(50).describe('Danh sách mã, vd ["SP001","KH012"] / Codes') }),
  output: (z) => ({ notice: z.string(), data: z.object({ found: z.array(z.record(z.string(), z.unknown())), not_found: z.array(z.string()) }) }),
  async run(args, { deps, principal, baseUrl }) {
    const codes = readCodes(args.codes);
    const map = await deps.refs.resolveCodes(principal.user, codes);
    const out = wrapData({ found: codes.filter((c) => map.has(c)).map((c) => ({ ...refOut(map.get(c) as RefView, baseUrl), requested: c })), not_found: codes.filter((c) => !map.has(c)) });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/** get_record/update_record theo mã: mã → id (kiểm đúng bảng nếu AI có ghi `object`). */
export async function idFromCode(deps: { refs: { resolveCodes: (u: never, c: string[]) => Promise<Map<string, RefView>> } }, user: unknown, raw: unknown, object?: string): Promise<{ object: string; id: number }> {
  const [code] = readCodes([raw], 1);
  const v = (await deps.refs.resolveCodes(user as never, [code])).get(code);
  if (!v) throw new ToolUserError(`Không tìm thấy bản ghi mã ${code} (hoặc bạn không có quyền xem). Dùng find_by_code / list_records để kiểm.`);
  const key = tableKeyOf(v);
  if (object && object !== key) throw new ToolUserError(`Mã ${code} thuộc bảng “${key}”, không phải “${object}”.`);
  return { object: key, id: v.id };
}
