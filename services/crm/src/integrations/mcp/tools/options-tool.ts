import { can } from '@trinity/rbac';
import { wrapData } from '../ai-output';
import { ForbiddenToolError, ToolUserError, optStr, rejectDigitProbe, type ToolDef } from './tool-types';
import { foldVi } from '../../../custom-objects/view-config';
import { isBoardVisibleToUser, loadKanbanAccessContext } from '../../../kanban/common/kanban-rbac.helper';

const GROUPS = { sources: 'contact_source', stages: 'contact_stage', statuses: 'contact_detail_status' } as const;

/** Danh mục id mà tool ghi cần (nguồn/giai đoạn/trạng thái, bảng + cột công việc, nhân viên nhận khách). CHỈ ĐỌC, theo quyền. */
export const optionsTool: ToolDef = {
  name: 'list_crm_options',
  title: 'Danh mục lựa chọn / List CRM options',
  description:
    'Liệt kê các id hợp lệ để dùng khi ghi dữ liệu: nguồn khách, giai đoạn, trạng thái (cần quyền xem/tạo khách), bảng + cột công việc (cần quyền công việc), nhân viên có thể nhận khách (cần quyền chuyển khách, lọc theo tên bằng user_name). / ' +
    'Valid ids for write actions: sources, stages, statuses, kanban boards/columns, assignable users.',
  permissions: [],
  input: (z) => ({ user_name: z.string().min(1).max(100).optional().describe('Lọc nhân viên theo tên / Filter users by name') }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const g = principal.user.grants;
    const data: Record<string, unknown> = {};
    if (can(g, 'contacts.view') || can(g, 'contacts.create')) {
      for (const [key, group] of Object.entries(GROUPS)) {
        data[key] = await deps.prisma.settingOption.findMany({ where: { group_key: group, is_active: true }, orderBy: { sort_order: 'asc' }, take: 50, select: { id: true, label: true } });
      }
    }
    if (can(g, 'kanban.view') || can(g, 'kanban.manage')) data.kanban_boards = await boards(deps, principal);
    if (can(g, 'contacts.transfer')) data.assignable_users = await users(deps, principal, optStr(args.user_name, 100));
    if (Object.keys(data).length === 0) throw new ForbiddenToolError('Bạn không có quyền nào cần danh mục này (contacts/kanban).');
    const out = wrapData(data);
    return { structured: out, text: JSON.stringify(out) };
  },
};

const GROUP_LABELS: Record<keyof typeof GROUPS, string> = { sources: 'nguồn khách', stages: 'giai đoạn khách hàng', statuses: 'trạng thái chăm sóc' };

/**
 * Thêm hoặc sửa một mục trong danh mục khách hàng (nguồn, giai đoạn, trạng thái) — đúng màn Cài đặt › Danh mục khách hàng.
 * Không có xoá: mục không dùng nữa thì tắt (active=false), dữ liệu khách cũ vẫn giữ nhãn.
 */
export const saveCrmOptionTool: ToolDef = {
  name: 'save_crm_option',
  title: 'Thêm/sửa mục danh mục khách hàng / Save CRM option',
  description:
    'Thêm mục mới hoặc sửa mục có sẵn trong danh mục khách hàng: list = sources (nguồn khách), stages (giai đoạn), statuses (trạng thái chăm sóc). ' +
    'Có id (từ list_crm_options) thì sửa nhãn / thứ tự / bật-tắt; không có id thì thêm mục mới với label. Tắt (active=false) để ẩn mục không dùng; không xoá. ' +
    'Cần quyền cấu hình danh mục khách. / Adds or edits a customer list item (source, stage, status); turning off hides it, nothing is deleted.',
  permissions: ['contacts.catalog'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    list: z.enum(['sources', 'stages', 'statuses']).describe('Danh mục / Which list'),
    id: z.number().int().positive().optional().describe('Id mục cần sửa; bỏ trống để thêm mới / Item id to edit; omit to add'),
    label: z.string().trim().min(1).max(100).optional().describe('Tên hiển thị / Display label'),
    sort_order: z.number().int().min(0).max(999).optional().describe('Thứ tự (nhỏ đứng trước) / Order'),
    active: z.boolean().optional().describe('false = ẩn mục / false hides the item'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const list = args.list as keyof typeof GROUPS;
    const group = GROUPS[list];
    if (!group) throw new ToolUserError('list phải là sources, stages hoặc statuses. / list must be sources, stages or statuses.');
    const label = optStr(args.label, 100);
    const sort = typeof args.sort_order === 'number' ? args.sort_order : undefined;
    const active = typeof args.active === 'boolean' ? args.active : undefined;
    const select = { id: true, label: true, value: true, sort_order: true, is_active: true, is_system: true } as const;
    let row;
    if (typeof args.id === 'number') {
      const cur = await deps.prisma.settingOption.findFirst({ where: { id: args.id, group_key: group }, select: { id: true } });
      if (!cur) throw new ToolUserError(`Không có mục id ${args.id} trong ${GROUP_LABELS[list]} (xem list_crm_options). / No such item in this list.`);
      if (label === undefined && sort === undefined && active === undefined) throw new ToolUserError('Chưa có gì để sửa: gửi label, sort_order hoặc active. / Nothing to change.');
      row = await deps.prisma.settingOption.update({
        where: { id: cur.id },
        data: { ...(label !== undefined ? { label } : {}), ...(sort !== undefined ? { sort_order: sort } : {}), ...(active !== undefined ? { is_active: active } : {}), updated_by: principal.userId },
        select,
      });
    } else {
      if (!label) throw new ToolUserError('Thêm mục mới cần label. / label is required to add an item.');
      const same = await deps.prisma.settingOption.findFirst({ where: { group_key: group, label: { equals: label, mode: 'insensitive' } }, select });
      if (same) throw new ToolUserError(`Đã có “${same.label}” (id ${same.id}${same.is_active ? '' : ', đang tắt'}) trong ${GROUP_LABELS[list]}; sửa mục đó bằng id thay vì thêm mới. / Already exists.`);
      const base = foldVi(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'muc';
      let value = base;
      for (let i = 2; await deps.prisma.settingOption.findUnique({ where: { group_key_value: { group_key: group, value } }, select: { id: true } }); i++) value = `${base}_${i}`;
      const last = await deps.prisma.settingOption.findFirst({ where: { group_key: group }, orderBy: { sort_order: 'desc' }, select: { sort_order: true } });
      row = await deps.prisma.settingOption.create({
        data: { group_key: group, value, label, sort_order: sort ?? (last?.sort_order ?? 0) + 1, is_active: active ?? true, is_system: false, updated_by: principal.userId },
        select,
      });
    }
    const out = wrapData({ list, item: row });
    return { structured: out, text: JSON.stringify(out) };
  },
};

async function boards(deps: Parameters<ToolDef['run']>[1]['deps'], principal: Parameters<ToolDef['run']>[1]['principal']) {
  const access = await loadKanbanAccessContext(deps.prisma, deps.scope, principal.user);
  const rows = await deps.prisma.kanbanBoard.findMany({
    where: { deleted_at: null }, orderBy: { id: 'asc' }, take: 30,
    include: { columns: { where: { is_archived: false }, orderBy: { position: 'asc' }, take: 20, select: { id: true, name: true, is_done: true } } },
  });
  return rows.filter((b) => isBoardVisibleToUser(principal.user, access, b)).slice(0, 10).map((b) => ({ id: b.id, name: b.name, columns: b.columns }));
}

async function users(deps: Parameters<ToolDef['run']>[1]['deps'], principal: Parameters<ToolDef['run']>[1]['principal'], name?: string) {
  if (name) rejectDigitProbe(name);
  const ids = await deps.scope.ownerIds(principal.user, 'contacts.transfer');
  const idFilter = ids === 'all' ? {} : { id: { in: ids ?? [] } };
  return deps.prisma.user.findMany({
    where: { AND: [idFilter, { status: 'active', deleted_at: null }, name ? { full_name: { contains: name, mode: 'insensitive' as const } } : {}] },
    orderBy: { full_name: 'asc' }, take: 30, select: { id: true, full_name: true },
  });
}
