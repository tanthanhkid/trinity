import { ForbiddenException } from '@nestjs/common';
import { can, type Permission } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import type { QueryKanbanCardsDto } from '../../../kanban/cards/dto/query-cards.dto';
import { loadKanbanAccessContext } from '../../../kanban/common/kanban-rbac.helper';
import { contactVisibility } from './search-fetch';
import { listContactsTool, getContactTool } from './contacts-tools';
import { listDealsTool } from './deals-dashboard-tools';
import { clampLimit, optInt, ToolUserError, type ToolContext } from './tool-types';

/** Bảng LÕI mà list_records/get_record/create_record/update_record gửi sang service nghiệp vụ sẵn có. */
export const CORE_KEYS = ['contacts', 'deals', 'tasks'] as const;
export type CoreKey = (typeof CORE_KEYS)[number];
export const isCoreKey = (k: string): k is CoreKey => (CORE_KEYS as readonly string[]).includes(k);

/** Quyền XEM và GHI của từng bảng lõi (khớp các controller web). */
export const CORE_PERMS: Record<CoreKey, { view: Permission; create: Permission; update: Permission }> = {
  contacts: { view: 'contacts.view', create: 'contacts.create', update: 'contacts.update' },
  deals: { view: 'deals.view', create: 'deals.manage', update: 'deals.manage' },
  tasks: { view: 'kanban.view', create: 'kanban.manage', update: 'kanban.manage' },
};

/** own = chỉ dữ liệu của mình · team = mình + cấp dưới trực tiếp · subtree = cả cây cấp dưới · all = tất cả. */
export const scopeName = (g: unknown): string | null => (g === undefined ? null : g === true ? 'all' : String(g));

/** Thiếu quyền ⇒ 403 kèm tên quyền (HttpException: cả lúc gọi tool lẫn lúc duyệt đều được đổi thành lỗi rõ ràng). */
export function requirePerm(user: AuthUser, perm: Permission): void {
  if (!can(user.grants, perm)) throw new ForbiddenException(`Bạn không có quyền thực hiện thao tác này (cần quyền ${perm}).`);
}

export interface CoreList { records: unknown[]; next_cursor: string | null }

const FILTER_KEYS: Record<CoreKey, string[]> = {
  contacts: ['stage_id', 'contact_status_id', 'source_id', 'assigned_to', 'uncontacted_days'],
  deals: ['status', 'assigned_to'],
  tasks: ['board_id', 'column_id', 'contact_id', 'assignee_id', 'overdue'],
};

function readFilter(key: CoreKey, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ToolUserError('filter phải là object {khoá_trường: giá trị}.');
  const bad = Object.keys(raw).filter((k) => !FILTER_KEYS[key].includes(k));
  if (bad.length) throw new ToolUserError(`Bảng ${key} chỉ lọc được theo: ${FILTER_KEYS[key].join(', ')} (không có: ${bad.slice(0, 5).join(', ')}).`);
  return raw as Record<string, unknown>;
}

const unwrap = (out: { structured: Record<string, unknown> }): Record<string, unknown> => out.structured.data as Record<string, unknown>;
const cursorOf = (v: unknown): number | undefined => (typeof v === 'string' && /^\d{1,10}$/.test(v) ? optInt(Number(v)) : undefined);
const nextOf = (v: unknown): string | null => (typeof v === 'number' ? String(v) : null);

export interface CoreListArgs { filter?: unknown; search?: string; limit: number; cursor?: string }

/** Việc → khoá THEO describe_schema (title, description, due_at, priority, contact_id, column_id) + phần phụ chỉ đọc (TASK_EXTRAS). `contact_id` chỉ có khi khách còn thấy được. */
export function taskRecord(c: { id: number; code?: string | null; title: string; description?: string | null; due_at: unknown; priority: unknown; column_id: number; board_id: number; is_overdue: boolean; labels: string[]; assignee_ids: number[]; contact?: { id: number; full_name: string | null } | null; completed_at: unknown }): Record<string, unknown> {
  return {
    id: c.id, code: c.code ?? null, title: c.title, description: c.description ?? null, due_at: c.due_at, priority: c.priority, contact_id: c.contact?.id ?? null, column_id: c.column_id,
    board_id: c.board_id, assignee_ids: c.assignee_ids, contact: c.contact?.full_name ?? null, completed: c.completed_at != null, is_overdue: c.is_overdue, labels: c.labels,
  };
}

/** Khách → khoá THEO describe_schema (`assigned_to` = id người phụ trách; tên ở `assigned_to_name`). */
export function contactRecord(d: Record<string, unknown>): Record<string, unknown> {
  const owner = d.assigned_to;
  const isObj = owner !== null && typeof owner === 'object';
  const { assigned_to: _drop, ...rest } = d;
  void _drop;
  return { ...rest, assigned_to: isObj ? (owner as { id: number }).id : (owner ?? null), assigned_to_name: isObj ? (owner as { full_name: string | null }).full_name : null };
}

/** Deal → khoá THEO describe_schema: `assigned_to` = id người phụ trách (tên ở `assignee`, chỉ đọc). */
export function dealRecord(d: Record<string, unknown>): Record<string, unknown> {
  return { ...d, assigned_to: d.assigned_to ?? null };
}

/** Khoá phụ chỉ đọc mà mỗi bảng lõi trả thêm ngoài trường của schema (đưa vào describe_schema.read_only_fields). */
export const CORE_EXTRAS: Record<CoreKey, Record<string, string>> = {
  contacts: { id: 'ID bản ghi', code: 'Mã chung (KH001…) — dùng để gắn liên kết', assigned_to_name: 'Tên người phụ trách', stage: 'Nhãn giai đoạn', status: 'Nhãn trạng thái', source: 'Nhãn nguồn', created_at: 'Tạo lúc', updated_at: 'Sửa lúc', phone_2: 'SĐT 2 (che)', team: 'Tên team', deals: 'Deal của khách', recent_activities: 'Hoạt động gần đây' },
  deals: { id: 'ID bản ghi', code: 'Mã chung (DL001…)', assignee: 'Tên người phụ trách', created_at: 'Tạo lúc', updated_at: 'Sửa lúc' },
  tasks: { id: 'ID bản ghi', code: 'Mã chung (CV001…)', board_id: 'ID bảng Kanban', assignee_ids: 'ID người được giao', contact: 'Tên khách gắn kèm', completed: 'Đã hoàn thành', is_overdue: 'Quá hạn', labels: 'Nhãn', checklist: 'Tiến độ checklist', created_at: 'Tạo lúc', updated_at: 'Sửa lúc' },
};

async function listTasks(args: CoreListArgs, f: Record<string, unknown>, ctx: ToolContext): Promise<CoreList> {
  const { deps, principal } = ctx;
  const access = await loadKanbanAccessContext(deps.prisma, deps.scope, principal.user);
  const query = { search: args.search, limit: args.limit, cursor: cursorOf(args.cursor), board_id: optInt(f.board_id), column_id: optInt(f.column_id), contact_id: optInt(f.contact_id), assignee_id: optInt(f.assignee_id), overdue: f.overdue === true ? true : undefined };
  const res = await deps.cards.list(principal.user, access, query as unknown as QueryKanbanCardsDto);
  const records = res.cards.map((c) => taskRecord(c));
  return { records, next_cursor: nextOf(res.next_cursor) };
}

/** Đọc danh sách bảng lõi: cùng phạm vi + che SĐT như tool riêng (list_contacts/list_deals) và như giao diện web. */
export async function listCore(key: CoreKey, args: CoreListArgs, ctx: ToolContext): Promise<CoreList> {
  requirePerm(ctx.principal.user, CORE_PERMS[key].view);
  const f = readFilter(key, args.filter);
  const limit = clampLimit(args.limit);
  const base = { limit, cursor: cursorOf(args.cursor) };
  if (key === 'tasks') return listTasks({ ...args, limit }, f, ctx);
  if (key === 'contacts') {
    const d = unwrap(await listContactsTool.run({ ...f, ...base, name: args.search }, ctx));
    return { records: (d.contacts as Record<string, unknown>[]).map(contactRecord), next_cursor: nextOf(d.next_cursor) };
  }
  const d = unwrap(await listDealsTool.run({ ...f, ...base, search: args.search }, ctx));
  return { records: (d.deals as Record<string, unknown>[]).map(dealRecord), next_cursor: nextOf(d.next_cursor) };
}

async function getDeal(id: number, ctx: ToolContext): Promise<Record<string, unknown>> {
  const d = await ctx.deps.deals.findOne(id, ctx.principal.user);
  const seeContact = await contactVisibility(ctx, [d.contact_id]);
  return dealRecord({
    id: d.id, code: d.code ?? null, title: d.title, description: d.description, value: d.value, status: d.status, note: d.note,
    contact_id: seeContact(d.contact) ? d.contact_id : null, assigned_to: d.assigned_to, assignee: d.assignee?.full_name ?? null, created_at: d.created_at, updated_at: d.updated_at,
  });
}

async function getTask(id: number, ctx: ToolContext): Promise<Record<string, unknown>> {
  const { deps, principal } = ctx;
  const access = await loadKanbanAccessContext(deps.prisma, deps.scope, principal.user);
  const c = await deps.cards.findOne(principal.user, access, id);
  return {
    ...taskRecord(c),
    checklist: c.checklist_total ? `${c.checklist_done}/${c.checklist_total}` : null, created_at: c.created_at, updated_at: c.updated_at,
  };
}

/** Chi tiết 1 bản ghi bảng lõi (id ngoài phạm vi ⇒ NotFound như web). */
export async function getCore(key: CoreKey, id: number, ctx: ToolContext): Promise<Record<string, unknown>> {
  requirePerm(ctx.principal.user, CORE_PERMS[key].view);
  if (key === 'contacts') return contactRecord(unwrap(await getContactTool.run({ id }, ctx)));
  return key === 'deals' ? getDeal(id, ctx) : getTask(id, ctx);
}
