import { assertInScope } from '@trinity/rbac-nest';
import type { RecordData } from '../../../custom-objects/field-types';
import { parseRef } from '../../../custom-objects/refs/ref-types';
import { idFromCode, readCodes } from '../tools/code-tools';
import { isCoreKey, requirePerm } from '../tools/core-records';
import type { Z } from '../tools/tool-types';
import { ActionUserError, type ActionToolDef } from './action-types';
import { cleanText, line, lines, shown } from './action-helpers';
import { loadDefForAction } from './action-view-tools';
import { validateOrExplain } from './action-record-tools';

const MODES = ['add', 'replace', 'remove'] as const;
type Mode = (typeof MODES)[number];

/**
 * Gắn liên kết bằng MÃ giữa hai bản ghi bất kỳ (vd khách hàng KH001 → đơn hàng DH001, DH002) qua trường kiểu "link" của bản ghi nguồn
 * (bảng tuỳ biến). Không ràng buộc bảng đích. Ghi ngay như mọi thao tác ghi của AI; kiểm người dùng thấy được mọi bản ghi.
 */
export const linkRecordsAction: ActionToolDef = {
  name: 'link_records',
  label: 'Gắn liên kết',
  title: 'Gắn liên kết giữa bản ghi bằng mã / Link records by code',
  description:
    'Gắn (add, mặc định) / thay (replace) / gỡ (remove) liên kết từ MỘT bản ghi nguồn tới các bản ghi đích, tất cả bằng MÃ chung (HS001, KH012…). ' +
    'Nguồn phải là bản ghi bảng tuỳ biến có trường kiểu link ("Liên kết"); field = khoá trường đó (bỏ trống nếu bảng chỉ có một). Đích ở BẤT KỲ bảng nào (kể cả khách hàng KH…). ' +
    'Bảng chưa có trường link ⇒ gọi add_field type "link" trước, hoặc gắn thẻ @MÃ trong ô chữ dài bằng update_record. Ghi ngay. / Links one record to others by code immediately.',
  permissions: ['custom_records.manage'],
  destructive: false,
  idempotent: true,
  input: (z: Z) => ({
    source: z.string().min(2).max(20).describe('Mã bản ghi nguồn, vd PH001 / Source record code'),
    targets: z.array(z.string().min(2).max(20)).min(1).max(50).describe('Mã các bản ghi đích, vd ["HS001","HS002"] / Target codes'),
    field: z.string().min(1).max(48).optional().describe('Khoá trường link của bảng nguồn (bỏ trống nếu chỉ có một) / Link field key'),
    mode: z.enum(MODES).optional().describe('add (mặc định) | replace | remove'),
  }),
  async prepare(args, { deps, user }) {
    requirePerm(user, 'custom_records.manage');
    const src = await idFromCode(deps, user, args.source);
    if (isCoreKey(src.object)) throw new ActionUserError('Nguồn phải là bản ghi của bảng tuỳ biến (bảng lõi không có trường Liên kết). Đổi chiều: lấy bản ghi tuỳ biến làm nguồn.');
    const def = await loadDefForAction(deps, user, src.object);
    const links = def.fields.filter((f) => f.type === 'link');
    const fkey = args.field ? cleanText(args.field, 48) : links.length === 1 ? links[0].key : '';
    const field = links.find((f) => f.key === fkey);
    if (!field) throw new ActionUserError(links.length ? `Chọn field là một trong: ${links.map((f) => f.key).join(', ')}.` : `Bảng “${def.obj.label}” chưa có trường kiểu link — đề xuất add_field {type:"link"} trước.`);
    const row = await deps.prisma.customRecord.findFirst({ where: { id: src.id, object_id: def.obj.id, deleted_at: null } });
    const gone = new ActionUserError('Không tìm thấy bản ghi nguồn hoặc nằm ngoài phạm vi quyền của bạn.');
    if (!row) throw gone;
    await assertInScope(deps.scope, user, 'custom_records.manage', [row.owner_id, row.created_by]).catch(() => { throw gone; });
    const codes = readCodes(args.targets);
    const found = await deps.refs.resolveCodes(user, codes);
    const missing = codes.filter((c) => !found.has(c));
    if (missing.length) throw new ActionUserError(`Không tìm thấy (hoặc không có quyền xem): ${missing.join(', ')}. Kiểm bằng find_by_code.`);
    const before = (row.data && typeof row.data === 'object' ? (row.data as RecordData) : {});
    const cur = (Array.isArray(before[field.key]) ? (before[field.key] as unknown[]) : []).filter((x): x is string => typeof x === 'string' && !!parseRef(x));
    const want = codes.map((c) => found.get(c)?.ref as string);
    const mode: Mode = (MODES as readonly string[]).includes(String(args.mode)) ? (args.mode as Mode) : 'add';
    const next = mode === 'replace' ? want : mode === 'remove' ? cur.filter((r) => !want.includes(r)) : [...new Set([...cur, ...want])];
    if (JSON.stringify(next) === JSON.stringify(cur)) throw new ActionUserError('Không có thay đổi: các liên kết này đã có (hoặc chưa có để gỡ).');
    await validateOrExplain(() => deps.validator.validate(def, user, { [field.key]: next.length ? next : null }, before));
    const verb = mode === 'remove' ? 'Gỡ liên kết' : mode === 'replace' ? 'Đặt lại liên kết' : 'Gắn liên kết';
    const list = codes.map((c) => `${c} ${found.get(c)?.title ?? ''}`.trim()).join(', ');
    return {
      params: { object: src.object, id: src.id, field: field.key, values: next },
      summary: shown(`${verb} ${row.code ?? `#${row.id}`}${row.title ? ` "${row.title}"` : ''} → ${codes.join(', ')}`),
      details: lines(line('Bản ghi nguồn', `${row.code ?? ''} ${row.title ?? ''} (${def.obj.label})`.trim()), line('Trường', field.label), line(verb, list, 900), line('Sau khi duyệt', `${next.length} liên kết`)),
    };
  },
  async execute(params, { deps, user }) {
    requirePerm(user, 'custom_records.manage');
    const values = params.values as string[];
    const res = await deps.records.update(user, String(params.object), Number(params.id), { data: { [String(params.field)]: values.length ? values : null } });
    return { record_id: res.id, object: params.object, links: values.length };
  },
};
