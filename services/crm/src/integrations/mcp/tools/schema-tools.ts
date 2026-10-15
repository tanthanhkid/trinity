import { can } from '@trinity/rbac';
import { isObjectVisible, loadObjectAccess, toFieldDef } from '../../../custom-objects/custom-object-access';
import { CHOICE_COLORS, CUSTOM_ICONS, FIELD_TYPES, LIMITS, type FieldDef } from '../../../custom-objects/field-types';
import { DATA_NOTICE, sanitizeForAi } from '../ai-output';
import { scopeName } from './core-records';
import { CORE_TABLES } from './schema-core';
import { ToolUserError, type McpDeps, type ToolDef } from './tool-types';
import { VIEW_TYPES } from '../../../custom-objects/view-config';
import type { AuthUser } from '@trinity/rbac-nest';

export interface FieldDescription {
  key: string; label: string; type: string; required: boolean; unique: boolean; is_title: boolean; read_only: boolean;
  help_text: string | null; choices?: { value: string; label: string }[]; relation?: { table: string; multiple: boolean };
}

const MAX_TABLES = 60;

function describeField(f: FieldDef, tableKeyById: Map<number, string>): FieldDescription {
  const d: FieldDescription = {
    key: f.key, label: f.label, type: f.type, required: f.required, unique: f.is_unique, is_title: f.is_title,
    read_only: f.type === 'formula', help_text: f.help_text,
  };
  if (f.options.choices?.length) d.choices = f.options.choices.map((c) => ({ value: c.value, label: c.label }));
  if (f.type === 'user') d.relation = { table: 'users (id từ list_crm_options)', multiple: false };
  if (f.type === 'link') d.help_text = f.help_text ?? 'Liên kết tới bản ghi ở BẤT KỲ bảng nào: danh sách MÃ, vd ["HS001","KH002"] (không ràng buộc bảng).';
  if (f.type === 'long_text' && !f.help_text) d.help_text = 'Văn bản; gắn thẻ bản ghi khác bằng @MÃ (vd "Khám cho @BN001") — Trinity tự tạo liên kết.';
  if (f.type === 'relation') {
    const target = f.options.target === 'contact' ? 'contacts' : tableKeyById.get(f.options.target_object_id as number);
    // Bảng đích người dùng không được thấy ⇒ không lộ khoá/tên của nó.
    d.relation = { table: target ?? '(bảng bạn không có quyền xem)', multiple: !!f.options.multiple };
  }
  return d;
}

/** Bảng tuỳ biến người dùng được thấy (theo `visible_role_ids`/bật-tắt) + quyền xem/tạo/sửa thật của họ. */
export async function describeCustomTables(deps: McpDeps, user: AuthUser, only?: string) {
  if (!can(user.grants, 'custom_records.view')) return [];
  const access = await loadObjectAccess(deps.prisma, user);
  const all = await deps.prisma.customObject.findMany({ where: { deleted_at: null }, orderBy: [{ nav_order: 'asc' }, { id: 'asc' }], take: MAX_TABLES });
  const visible = all.filter((o) => isObjectVisible(o, access));
  const tableKeyById = new Map(visible.map((o) => [o.id, o.key]));
  const picked = only ? visible.filter((o) => o.key === only) : visible;
  const rows = await deps.prisma.customField.findMany({
    where: { object_id: { in: picked.map((o) => o.id) }, deleted_at: null },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });
  const views = await deps.prisma.customView.findMany({
    where: { object_id: { in: picked.map((o) => o.id) }, deleted_at: null },
    orderBy: [{ nav_order: 'asc' }, { id: 'asc' }],
    select: { object_id: true, key: true, label: true, type: true, config: true, show_in_nav: true },
  });
  const canWrite = can(user.grants, 'custom_records.manage');
  const canArchive = can(user.grants, 'custom_records.delete');
  const dataScope = scopeName(user.grants['custom_records.view']);
  return picked.map((o) => ({
    key: o.key, label: o.label, label_plural: o.label_plural, kind: 'custom' as const, description: o.description, is_active: o.is_active,
    code_prefix: o.code_prefix, code_example: o.code_prefix ? `${o.code_prefix}001` : null,
    permissions: { view: true, create: canWrite, update: canWrite, archive: canWrite && canArchive },
    data_scope: dataScope,
    fields: rows.filter((r) => r.object_id === o.id).map((r) => describeField(toFieldDef(r), tableKeyById)),
    show_in_nav: o.show_in_nav,
    views: views.filter((v) => v.object_id === o.id).map((v) => ({ key: v.key, label: v.label, type: v.type, group_by: (v.config as { group_by?: string } | null)?.group_by ?? null, show_in_nav: v.show_in_nav })),
    tools: { read: ['list_records', 'get_record'], write: canWrite ? ['create_record', 'update_record', ...(canArchive ? ['archive_record'] : [])] : [] },
  }));
}

/** Phần AI cần để dựng cấu trúc (chỉ người có quyền quản trị tính năng tuỳ biến mới thấy chi tiết). */
export function describeStructure(user: AuthUser) {
  if (!can(user.grants, 'custom_objects.manage')) return { can_edit: false, note: 'Bạn không có quyền sửa cấu trúc bảng (chỉ quản trị viên). Hãy nhờ quản trị viên.' };
  return {
    can_edit: true,
    tools: ['get_setup_guide', 'propose_workspace', 'import_records', 'link_records', 'find_by_code', 'complete_setup', 'list_screen_types', 'create_view', 'update_view', 'set_menu', 'create_objects', 'create_object', 'update_object', 'add_field', 'update_field', 'archive_field', 'list_object_templates', 'install_object_template', 'list_structure_versions', 'restore_structure_version'],
    field_types: FIELD_TYPES, screen_types: VIEW_TYPES, icons: CUSTOM_ICONS, choice_colors: CHOICE_COLORS,
    limits: { max_objects: LIMITS.maxObjects, max_fields_per_object: LIMITS.maxFieldsPerObject, max_choices: LIMITS.maxChoices },
  };
}

async function otherTables(deps: Parameters<typeof describeCustomTables>[0], user: Parameters<typeof describeCustomTables>[1], only: string): Promise<{ key: string; label: string }[]> {
  const core = CORE_TABLES.map((t) => t.describe(user)).filter((t): t is NonNullable<typeof t> => t !== null) as unknown as { key: string; label: string }[];
  const custom = (await describeCustomTables(deps, user, undefined)) as unknown as { key: string; label: string }[];
  return [...core, ...custom].filter((t) => t.key !== only).map((t) => ({ key: t.key, label: t.label }));
}

export const describeSchemaTool: ToolDef = {
  name: 'describe_schema',
  title: 'Cấu trúc dữ liệu / Describe schema',
  description:
    'GỌI TOOL NÀY TRƯỚC khi đọc/ghi dữ liệu theo bảng. Trả danh sách bảng bạn được thấy: bảng lõi (contacts khách hàng, deals, tasks việc) và mọi BẢNG TUỲ BIẾN — tất cả dùng chung list_records/get_record/create_record/update_record. ' +
    'Mỗi bảng có code_prefix: MỌI bản ghi có MÃ CHUNG = tiền tố + số (HS001, KH012) — dùng mã để tra (find_by_code, get_record code) và để LIÊN KẾT (trường kiểu link, gắn thẻ @HS001 trong ô chữ dài, import_records ghép liên kết). ' +
    'Mỗi bảng gồm khoá, tên, các trường (khoá, nhãn, kiểu, bắt buộc, duy nhất, lựa chọn của select, bảng liên kết), quyền xem/tạo/sửa của bạn và data_scope (own = chỉ dữ liệu của bạn · team = của bạn + cấp dưới · subtree = cả cây cấp dưới · all = tất cả). ' +
    'Khi chỉ mô tả một bảng, other_tables liệt kê các bảng còn lại (khoá, tên) — thông tin liên quan tới bảng này có thể nằm ở đó. Bảng hoặc trường bạn không có quyền sẽ không xuất hiện. `structure` cho biết bạn có sửa được cấu trúc bảng không (chỉ quản trị viên) và các kiểu trường hợp lệ. Tool này chỉ đọc. / ' +
    'CALL THIS FIRST: lists the tables you can see (core + custom) with fields, types, required flags, select choices, relations, your permissions and data scope. `structure` says whether you may change table structure (admins only).',
  permissions: [],
  input: (z) => ({ object: z.string().min(1).max(48).optional().describe('Chỉ mô tả bảng này (khoá bảng); bỏ trống = mọi bảng / One table key, or all') }),
  output: (z) => ({ notice: z.string(), data: z.object({ tables: z.array(z.record(z.string(), z.unknown())), structure: z.record(z.string(), z.unknown()), other_tables: z.array(z.record(z.string(), z.unknown())).optional() }) }),
  async run(args, { deps, principal }) {
    const only = typeof args.object === 'string' && args.object.trim() ? args.object.trim() : undefined;
    const core = CORE_TABLES.filter((t) => !only || t.key === only).map((t) => t.describe(principal.user)).filter((t): t is NonNullable<typeof t> => t !== null);
    const custom = await describeCustomTables(deps, principal.user, only);
    if (only && core.length + custom.length === 0) throw new ToolUserError(`Không có bảng “${only.slice(0, 48)}” (hoặc bạn không được thấy). Gọi describe_schema không tham số để xem danh sách.`);
    // Cây tables → trường → lựa chọn sâu hơn trần MAX_DEPTH của wrapData ⇒ bắt đầu từ độ sâu -1 (vẫn che SĐT, bỏ khoá nhạy cảm, cắt độ dài).
    // Mô tả một bảng ⇒ kèm tên các bảng khác: dữ liệu liên quan (vd quận trên đơn hàng) có thể nằm ở bảng khác.
    const other_tables = only ? await otherTables(deps, principal.user, only) : undefined;
    const out = { notice: DATA_NOTICE, data: sanitizeForAi({ tables: [...core, ...custom], structure: describeStructure(principal.user), ...(other_tables ? { other_tables } : {}) }, '', -1) as { tables: unknown[] } };
    return { structured: out, text: JSON.stringify(out) };
  },
};
