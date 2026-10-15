import { can } from '@trinity/rbac';
import { wrapData } from '../ai-output';
import { ForbiddenToolError, optStr, rejectDigitProbe, type ToolDef } from './tool-types';
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
