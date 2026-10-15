import { BadRequestException, NotFoundException } from '@nestjs/common';
import { assertInScope } from '@trinity/rbac-nest';
import { CreateDealDto } from '../../../deals/dto/create-deal.dto';
import { UpdateDealDto } from '../../../deals/dto/update-deal.dto';
import { UpdateContactDto } from '../../../contacts/dto/update-contact.dto';
import { UpdateKanbanCardDto } from '../../../kanban/cards/dto/update-card.dto';
import { loadKanbanAccessContext } from '../../../kanban/common/kanban-rbac.helper';
import { CORE_PERMS, requirePerm, type CoreKey } from '../tools/core-records';
import { optInt } from '../tools/tool-types';
import { createContactAction } from './action-contact-tools';
import { createTaskAction } from './action-task-tool';
import { ActionUserError, type ActionCtx, type PreparedAction } from './action-types';
import { assertContactForDraft, cleanText, compact, line, lines, loadContactForDraft, renamed, shown, validateDto } from './action-helpers';

/** Trường AI được SỬA ở khách hàng — cố ý không gồm SĐT và dữ liệu cá nhân nhạy cảm (AI không đọc được chúng); đổi người phụ trách có tool assign_contact. */
const CONTACT_EDITABLE = ['full_name', 'job_title', 'company_name', 'email', 'stage_id', 'contact_status_id', 'source_id', 'reminder_at', 'reminder_notes'] as const;
const DEAL_EDITABLE = ['title', 'description', 'value', 'status', 'note'] as const;
const TASK_EDITABLE = ['title', 'description', 'due_at', 'priority', 'contact_id'] as const;

function only(values: Record<string, unknown>, allowed: readonly string[], table: string): Record<string, unknown> {
  const bad = Object.keys(values).filter((k) => !allowed.includes(k));
  if (bad.length) throw new ActionUserError(`Bảng ${table} chỉ sửa được: ${allowed.join(', ')} (không sửa được: ${bad.slice(0, 5).join(', ')}).`);
  return values;
}

const clean = (values: Record<string, unknown>): Record<string, unknown> =>
  compact(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'string' ? cleanText(v, 2000) : v])));

/** Khi SỬA, `null` có nghĩa là xoá giá trị (gỡ khách khỏi việc, xoá nhắc hẹn): chỉ bỏ undefined và chuỗi rỗng. */
const cleanUpdate = (values: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(values)
      .map(([k, v]): [string, unknown] => [k, typeof v === 'string' ? cleanText(v, 2000) : v])
      .filter(([, v]) => v !== undefined && v !== ''),
  );

const show = (values: Record<string, unknown>) => lines(...Object.entries(values).map(([k, v]) => line(k, typeof v === 'object' ? JSON.stringify(v) : String(v))));

/** Tạo bản ghi bảng lõi: nhờ chính tool tạo riêng (create_contact / create_task) hoặc DTO deal; tham số đã chuẩn hoá đi vào `params.values`. */
export async function prepareCoreCreate(key: CoreKey, values: Record<string, unknown>, ctx: ActionCtx): Promise<PreparedAction> {
  requirePerm(ctx.user, CORE_PERMS[key].create);
  let p: PreparedAction;
  if (key === 'contacts') p = await createContactAction.prepare(values, ctx);
  else if (key === 'tasks') p = await createTaskAction.prepare(values, ctx);
  else p = await prepareDealCreate(values, ctx);
  return { ...p, params: { object: key, values: p.params } };
}

export async function executeCoreCreate(key: CoreKey, params: Record<string, unknown>, ctx: ActionCtx, draftId: number): Promise<Record<string, unknown>> {
  requirePerm(ctx.user, CORE_PERMS[key].create);
  const v = params.values as Record<string, unknown>;
  if (key === 'contacts') return { object: key, ...(await createContactAction.execute(v, ctx, draftId)) };
  if (key === 'tasks') return { object: key, ...(await createTaskAction.execute(v, ctx, draftId)) };
  const dto = await validateDto(CreateDealDto, v);
  const d = await ctx.deps.deals.create(dto, ctx.user);
  return { object: key, record_id: d.id };
}

async function prepareDealCreate(values: Record<string, unknown>, { deps, user }: ActionCtx): Promise<PreparedAction> {
  const params = compact({ ...clean(values), assigned_to: optInt(values.assigned_to) ?? user.userId, contact_id: optInt(values.contact_id) });
  const dto = await validateDto(CreateDealDto, params);
  const owners = await deps.scope.ownerIds(user, 'deals.manage');
  if (owners !== 'all' && !(owners ?? []).includes(dto.assigned_to)) throw new ActionUserError('Không giao được thương vụ cho người này (ngoài phạm vi của bạn).');
  if (dto.contact_id != null) await assertContactForDraft(deps, user, dto.contact_id);
  return { params, summary: shown(`Tạo thương vụ "${dto.title}"${dto.value != null ? `, giá trị ${dto.value}` : ''}`), details: lines(line('Tiêu đề', dto.title), line('Giá trị', dto.value), line('Trạng thái', dto.status ?? 'open'), line('Người phụ trách', `#${dto.assigned_to}`), line('Khách hàng', dto.contact_id ? `#${dto.contact_id}` : null), line('Mô tả', dto.description), line('Ghi chú', dto.note)) };
}

/** Sửa bản ghi bảng lõi: chỉ các trường trong danh sách cho phép; phạm vi SỬA + XEM kiểm lúc tạo nháp, kiểm lại lúc duyệt (service nghiệp vụ). */
export async function prepareCoreUpdate(key: CoreKey, id: number, values: Record<string, unknown>, ctx: ActionCtx): Promise<PreparedAction> {
  requirePerm(ctx.user, CORE_PERMS[key].update);
  const { deps, user } = ctx;
  if (key === 'contacts') {
    const params = cleanUpdate(only(values, CONTACT_EDITABLE, 'khách hàng'));
    if (Object.keys(params).length === 0) throw new ActionUserError('Không có giá trị nào để sửa.');
    await validateDto(UpdateContactDto, params);
    const c = await loadContactForDraft(deps, user, id, 'contacts.update');
    return { params: { object: key, id, values: params }, summary: shown(`Sửa khách "${renamed(c.full_name, !c.full_name?.trim() || user.isAdmin ? params.full_name : undefined) || `#${c.id}`}": ${Object.keys(params).join(', ')}`), details: lines(line('Khách hàng', `${c.full_name ?? '(chưa có tên)'} (#${c.id})`), ...show(params)) };
  }
  if (key === 'deals') {
    const params = cleanUpdate(only(values, DEAL_EDITABLE, 'thương vụ'));
    if (Object.keys(params).length === 0) throw new ActionUserError('Không có giá trị nào để sửa.');
    await validateDto(UpdateDealDto, params);
    const d = await deps.deals.findOne(id, user);
    await assertInScope(deps.scope, user, 'deals.manage', [d.assigned_to, d.created_by]).catch(() => { throw new NotFoundException('Không tìm thấy thương vụ'); });
    return { params: { object: key, id, values: params }, summary: shown(`Sửa thương vụ "${renamed(d.title, params.title)}": ${Object.keys(params).join(', ')}`), details: lines(line('Thương vụ', `${d.title} (#${d.id})`), ...show(params)) };
  }
  const params = cleanUpdate(only(values, TASK_EDITABLE, 'việc'));
  if (Object.keys(params).length === 0) throw new ActionUserError('Không có giá trị nào để sửa.');
  await validateDto(UpdateKanbanCardDto, params);
  // gắn khách vào việc phải kiểm phạm vi NGAY lúc nhận (null = gỡ liên kết thì không cần).
  if (params.contact_id != null) await assertContactForDraft(deps, user, Number(params.contact_id));
  const access = await loadKanbanAccessContext(deps.prisma, deps.scope, user);
  const t = await deps.cards.findOne(user, access, id);
  return { params: { object: key, id, values: params }, summary: shown(`Sửa việc "${renamed(t.title, params.title)}": ${Object.keys(params).join(', ')}`), details: lines(line('Việc', `${t.title} (#${t.id})`), ...show(params)) };
}

export async function executeCoreUpdate(key: CoreKey, params: Record<string, unknown>, ctx: ActionCtx): Promise<Record<string, unknown>> {
  requirePerm(ctx.user, CORE_PERMS[key].update);
  const { deps, user } = ctx;
  const id = optInt(params.id);
  const v = params.values as Record<string, unknown>;
  if (!id) throw new BadRequestException('Dữ liệu đề xuất không hợp lệ');
  if (key === 'contacts') await deps.contacts.update(id, await validateDto(UpdateContactDto, v), user);
  else if (key === 'deals') await deps.deals.update(id, await validateDto(UpdateDealDto, v), user);
  else await deps.cards.update(user, await loadKanbanAccessContext(deps.prisma, deps.scope, user), id, await validateDto(UpdateKanbanCardDto, v));
  return { object: key, record_id: id };
}
