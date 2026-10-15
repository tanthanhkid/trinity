import { BadRequestException } from '@nestjs/common';
import { KANBAN_PRIORITIES } from '../../../kanban/common/kanban.constants';
import { CreateKanbanCardDto } from '../../../kanban/cards/dto/create-card.dto';
import { isBoardVisibleToUser, loadKanbanAccessContext, loadVisibleBoardOrNotFound } from '../../../kanban/common/kanban-rbac.helper';
import type { AuthUser } from '@trinity/rbac-nest';
import { optInt } from '../tools/tool-types';
import { ActionUserError, type ActionDeps, type ActionToolDef } from './action-types';
import { assertContactForDraft, cleanText, compact, fmtDateVn, line, lines, shown, validateDto } from './action-helpers';

/** Cột mặc định: cột đầu (chưa ẩn, chưa phải "Hoàn thành") của bảng đầu tiên mà người dùng thấy. */
async function defaultColumn(deps: ActionDeps, user: AuthUser): Promise<number> {
  const access = await loadKanbanAccessContext(deps.prisma, deps.scope, user);
  const boards = await deps.prisma.kanbanBoard.findMany({ where: { deleted_at: null }, orderBy: { id: 'asc' }, take: 50 });
  for (const b of boards.filter((x) => isBoardVisibleToUser(user, access, x))) {
    const col = await deps.prisma.kanbanColumn.findFirst({ where: { board_id: b.id, is_archived: false, is_done: false }, orderBy: { position: 'asc' }, select: { id: true } });
    if (col) return col.id;
  }
  // Lỗi kiểu người dùng (không phải 404): AI nhận đúng câu này thay vì "không tìm thấy bản ghi".
  throw new ActionUserError(
    'Bạn chưa có bảng công việc (Kanban) nào có cột đang mở để tạo thẻ. Hãy nhờ quản trị tạo một bảng ở mục Công việc (hoặc cấp quyền xem bảng), rồi thử lại; nếu đã có bảng thì truyền column_id lấy từ list_crm_options.',
  );
}

/** Người được giao: chính mình, hoặc người trong phạm vi `kanban.manage` của mình (own = chỉ mình, team, tất cả…). */
async function assignableIds(deps: ActionDeps, user: AuthUser): Promise<number[] | 'all'> {
  const ids = await deps.scope.ownerIds(user, 'kanban.manage');
  return ids === 'all' ? 'all' : [...new Set([user.userId, ...(ids ?? [])])];
}

/** Tìm người được giao theo email (khớp đúng) hoặc tên (chứa), trong phạm vi quyền. Bỏ trống = chính người dùng. */
async function resolveAssignee(deps: ActionDeps, user: AuthUser, query: string | undefined): Promise<{ id: number; name: string }> {
  const q = query?.trim();
  if (!q) return { id: user.userId, name: 'Bạn' };
  const allowed = await assignableIds(deps, user);
  const scope = allowed === 'all' ? {} : { id: { in: allowed } };
  const base = { status: 'active', deleted_at: null, ...scope };
  const byEmail = await deps.prisma.user.findFirst({ where: { ...base, email: { equals: q, mode: 'insensitive' } }, select: { id: true, full_name: true } });
  if (byEmail) return { id: byEmail.id, name: byEmail.full_name };
  // Tên khớp đúng tra riêng (không bị cắt bởi giới hạn kết quả gần đúng bên dưới).
  const exact = await deps.prisma.user.findMany({ where: { ...base, full_name: { equals: q, mode: 'insensitive' } }, select: { id: true, full_name: true, email: true }, take: 6 });
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].full_name };
  const found = exact.length > 1 ? exact : await deps.prisma.user.findMany({ where: { ...base, full_name: { contains: q, mode: 'insensitive' } }, select: { id: true, full_name: true, email: true }, take: 6 });
  if (found.length === 1) return { id: found[0].id, name: found[0].full_name };
  if (found.length === 0) {
    throw new ActionUserError(`Không tìm thấy người tên hoặc email "${q}" trong phạm vi bạn được giao việc. Hỏi lại người dùng tên đầy đủ hoặc email; nếu bạn chỉ được giao việc cho chính mình thì bỏ trống assignee.`);
  }
  throw new ActionUserError(`Có nhiều người khớp "${q}": ${found.map((u) => `${u.full_name} (${u.email})`).join(', ')}. Hỏi người dùng chọn một người rồi gửi lại assignee bằng email.`);
}

export const createTaskAction: ActionToolDef = {
  name: 'create_task',
  label: 'Tạo công việc',
  title: 'Tạo công việc / Create a task',
  description:
    'Tạo một thẻ công việc (Kanban). Mặc định giao cho chính người dùng; muốn giao cho người khác thì điền assignee = tên hoặc email của họ (chỉ người trong phạm vi quyền giao việc của người dùng — nhiều người trùng tên thì hỏi lại người dùng). column_id lấy từ list_crm_options (bỏ trống = cột đầu của bảng đầu tiên). Tạo ngay. / ' +
    'Creates a Kanban task, immediately. Assigned to the user unless assignee (a colleague\'s name or email, within the user\'s permission scope) is given.',
  permissions: ['kanban.manage'],
  destructive: false,
  idempotent: false,
  input: (z) => ({
    title: z.string().min(1).max(200).describe('Tiêu đề công việc / Title'),
    description: z.string().max(2000).optional().describe('Mô tả / Description'),
    due_at: z.string().max(40).optional().describe('Hạn xử lý, ISO 8601 / Due date'),
    priority: z.enum(KANBAN_PRIORITIES).optional().describe('Độ ưu tiên / Priority'),
    contact_id: z.number().int().min(1).max(2_147_483_647).optional().describe('Gắn với khách hàng: id số của khách — từ search (contact:12 ⇒ 12), list_contacts hoặc list_records contacts; bỏ trống = không gắn khách nào / Linked contact id (from search "contact:12" ⇒ 12, or list_contacts)'),
    column_id: z.number().int().min(1).max(2_147_483_647).optional().describe('Cột đích (id từ list_crm_options) / Column id'),
    assignee: z.string().max(200).optional().describe('Giao cho ai: tên hoặc email đồng nghiệp; bỏ trống = chính người dùng / Assign to a colleague by name or email; empty = the user'),
  }),
  async prepare(args, { deps, user }) {
    const columnId = optInt(args.column_id) ?? (await defaultColumn(deps, user));
    const assignee = await resolveAssignee(deps, user, typeof args.assignee === 'string' ? args.assignee : undefined);
    const params = compact({
      column_id: columnId, title: cleanText(args.title, 200), description: cleanText(args.description, 2000), due_at: cleanText(args.due_at, 40),
      priority: args.priority, contact_id: optInt(args.contact_id), assignee_id: assignee.id,
    });
    const { assignee_id: _assignee, ...cardParams } = params;
    const dto = await validateDto(CreateKanbanCardDto, cardParams);
    const access = await loadKanbanAccessContext(deps.prisma, deps.scope, user);
    const col = await deps.prisma.kanbanColumn.findUnique({ where: { id: columnId }, select: { name: true, board_id: true, is_archived: true } });
    if (!col) throw new BadRequestException('column_id không hợp lệ — xem list_crm_options');
    const board = await loadVisibleBoardOrNotFound(deps.prisma, user, access, col.board_id);
    if (col.is_archived) throw new BadRequestException('Cột đã ẩn — chọn cột khác');
    if (dto.contact_id != null) await assertContactForDraft(deps, user, dto.contact_id);
    const due = dto.due_at ? fmtDateVn(dto.due_at) : null;
    return {
      params,
      summary: shown(`Tạo công việc "${dto.title}" (bảng ${board.name}, cột ${col.name}${due ? `, hạn ${due}` : ''}), giao cho ${assignee.id === user.userId ? 'bạn' : assignee.name}`),
      details: lines(line('Tiêu đề', dto.title), line('Mô tả', dto.description, 2000), line('Bảng / cột', `${board.name} / ${col.name}`), line('Hạn', due), line('Ưu tiên', dto.priority), line('Khách hàng gắn kèm', dto.contact_id ? `#${dto.contact_id}` : null), line('Người phụ trách', assignee.id === user.userId ? 'Bạn' : assignee.name)),
    };
  },
  async execute(params, { deps, user }) {
    // Người phụ trách: kiểm lại phạm vi lúc chạy (quyền có thể đã đổi từ lúc soạn nháp); không có ⇒ chính người dùng.
    const { assignee_id, ...rest } = params as Record<string, unknown> & { assignee_id?: number };
    const target = typeof assignee_id === 'number' ? assignee_id : user.userId;
    if (target !== user.userId) {
      const allowed = await assignableIds(deps, user);
      if (allowed !== 'all' && !allowed.includes(target)) throw new ActionUserError('Người được giao không còn trong phạm vi quyền giao việc của bạn.');
    }
    const dto = await validateDto(CreateKanbanCardDto, { ...rest, assignee_ids: [target] });
    const access = await loadKanbanAccessContext(deps.prisma, deps.scope, user);
    const card = await deps.cards.create(user, access, dto);
    return { card_id: card.id, title: card.title };
  },
};
