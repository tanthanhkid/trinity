import { BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { ScopeService } from '@trinity/rbac-nest';
// ScopeService PHẢI import THẬT (không type-only) — constructor DI của NestJS
// cần class reference runtime cho `emitDecoratorMetadata`; import type ở đây
// làm Nest resolve param type ra `Object` và ném lỗi không inject được.
import type { AuthUser } from '@trinity/rbac-nest';
import {
  KanbanAccessContext,
  canAccessKanbanCard,
  isBoardVisibleToUser,
  loadScopedCardOrNotFound,
  loadVisibleBoardOrNotFound,
} from '../common/kanban-rbac.helper';
import { RESTORE_WINDOW_MS } from '../../common/helpers/restore-window';
import {
  assertContactFieldMutable,
  assertContactLinkable,
  resolveKanbanCardContactDisplays,
} from '../common/kanban-contact.helper';
import { mergeKanbanAttributes, validateKanbanAttributes } from '../common/kanban-field.validator';
import { computeAppendPosition } from '../common/kanban-position.helper';
import { KANBAN_CARD_SELECT, KanbanCardRow, toKanbanCardDto } from './kanban-card.mapper';
import { logKanbanCardActivity } from './kanban-card-activity.helper';
import { buildKanbanCardListWhere, resolveKanbanCardOrderBy } from './kanban-card-query.helper';
import { assertAssigneesAssignable, resolveAssigneeIds, syncKanbanCardAssignees } from './kanban-card-assignee.helper';
import { CreateKanbanCardDto } from './dto/create-card.dto';
import { UpdateKanbanCardDto } from './dto/update-card.dto';
import { QueryKanbanCardsDto } from './dto/query-cards.dto';
import { KANBAN_CARDS_DEFAULT_LIMIT } from '../common/kanban.constants';
import { RecordLinksService } from '../../custom-objects/refs/record-links.service';

@Injectable()
export class KanbanCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    /** Thẻ @ trong mô tả công việc → "Được nhắc tới ở" của bản ghi được nhắc. Tuỳ chọn để test không phải dựng. */
    @Optional() private readonly links?: RecordLinksService,
  ) {}

  async list(user: AuthUser, access: KanbanAccessContext, query: QueryKanbanCardsDto) {
    const limit = query.limit ?? KANBAN_CARDS_DEFAULT_LIMIT;
    const where = buildKanbanCardListWhere(user, access, query);
    const orderBy = resolveKanbanCardOrderBy(query);
    const rows = await this.prisma.kanbanCard.findMany({
      where,
      select: KANBAN_CARD_SELECT,
      orderBy,
      take: limit + 1,
      ...(query.cursor !== undefined ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const cards = await this.attachContacts(user, access, page);
    return {
      cards,
      next_cursor: hasMore ? page[page.length - 1]?.id ?? null : null,
      has_more: hasMore,
    };
  }

  async findOne(user: AuthUser, access: KanbanAccessContext, cardId: number) {
    await loadScopedCardOrNotFound(this.prisma, user, access, cardId);
    // `loadScopedCardOrNotFound` chỉ select đủ để KIỂM QUYỀN (board/column/
    // assignees) — đọc lại bằng `KANBAN_CARD_SELECT` để có đủ checklist/bình
    // luận/đính kèm cho `toKanbanCardDto`.
    const card = await this.prisma.kanbanCard.findUniqueOrThrow({
      where: { id: cardId },
      select: KANBAN_CARD_SELECT,
    });
    const [dto] = await this.attachContacts(user, access, [card]);
    return dto;
  }

  async create(user: AuthUser, access: KanbanAccessContext, dto: CreateKanbanCardDto) {
    const column = await this.prisma.kanbanColumn.findUnique({
      where: { id: dto.column_id },
      select: { id: true, board_id: true, is_done: true, is_archived: true },
    });
    if (!column) throw new BadRequestException('column_id không hợp lệ');
    await loadVisibleBoardOrNotFound(this.prisma, user, access, column.board_id);
    if (column.is_archived) {
      throw new BadRequestException('Cột đã ẩn — không thể tạo card mới vào đây');
    }
    if (dto.contact_id != null) {
      await assertContactLinkable(this.prisma, this.scope, user, dto.contact_id);
    }
    const defs = await this.prisma.kanbanFieldDef.findMany({
      where: { board_id: column.board_id },
      select: { key: true, label: true, type: true, options: true, required: true },
    });
    const attributes = validateKanbanAttributes(defs, dto.attributes ?? {});
    const assigneeIds = resolveAssigneeIds(dto) ?? [];
    await assertAssigneesAssignable(this.prisma, assigneeIds);
    const last = await this.prisma.kanbanCard.findFirst({
      where: { column_id: dto.column_id, deleted_at: null },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const draft = await tx.kanbanCard.create({
        data: {
          board_id: column.board_id,
          column_id: dto.column_id,
          position: computeAppendPosition(last?.position ?? null),
          title: dto.title,
          description: dto.description ?? null,
          contact_id: dto.contact_id ?? null,
          assignee_id: assigneeIds[0] ?? null,
          created_by: user.userId,
          due_at: dto.due_at ? new Date(dto.due_at) : null,
          priority: dto.priority ?? null,
          labels: dto.labels ?? [],
          attributes: attributes as object,
          completed_at: column.is_done ? new Date() : null,
        },
        select: { id: true, title: true, column_id: true },
      });
      await syncKanbanCardAssignees(tx, draft.id, assigneeIds);
      await logKanbanCardActivity(tx, draft.id, user.userId, 'created', {
        title: draft.title,
        column_id: draft.column_id,
      });
      if (dto.contact_id != null) {
        await logKanbanCardActivity(tx, draft.id, user.userId, 'contact_linked', {
          contact_id: dto.contact_id,
        });
      }
      // Đọc lại SAU khi đã ghi `kanban_card_assignees` — select ban đầu (lúc
      // create) sẽ luôn thấy relation `assignees` RỖNG vì bản ghi liên kết
      // chưa tồn tại tại thời điểm đó (thứ tự ghi TRONG cùng transaction).
      return tx.kanbanCard.findUniqueOrThrow({ where: { id: draft.id }, select: KANBAN_CARD_SELECT });
    });

    if (dto.description) await this.links?.syncMentions({ type: 'task', id: created.id }, 'description', dto.description, user);
    const [result] = await this.attachContacts(user, access, [created]);
    return result;
  }

  async update(
    user: AuthUser,
    access: KanbanAccessContext,
    cardId: number,
    dto: UpdateKanbanCardDto,
  ) {
    const existing = await loadScopedCardOrNotFound(this.prisma, user, access, cardId);
    if (dto.contact_id !== undefined) {
      if (dto.contact_id === null) {
        // Gỡ liên kết (unlink) — vẫn phải chặn người bị deny Danh bạ (
        // quyền này áp cho MỌI thao tác trên field
        // này, không chỉ đường gán mới — xem `assertContactFieldMutable`).
        assertContactFieldMutable(user);
      } else {
        await assertContactLinkable(this.prisma, this.scope, user, dto.contact_id);
      }
    }

    let attributesPatch: object | undefined;
    if (dto.attributes !== undefined) {
      const defs = await this.prisma.kanbanFieldDef.findMany({
        where: { board_id: existing.board_id },
        select: { key: true, label: true, type: true, options: true, required: true },
      });
      const validatedNew = validateKanbanAttributes(defs, dto.attributes ?? {}, { partial: true });
      attributesPatch = mergeKanbanAttributes(existing.attributes, validatedNew) as object;
    }
    // `undefined` = "không đụng người phụ trách"; `[]`/mảng cụ thể = ghi đè.
    const assigneeIds = resolveAssigneeIds(dto);
    const existingAssigneeIds = new Set((existing.assignees ?? []).map((a) => a.user_id));
    const assigneesChanged =
      assigneeIds !== undefined &&
      (assigneeIds.length !== existingAssigneeIds.size ||
        assigneeIds.some((id) => !existingAssigneeIds.has(id)));
    // Chỉ kiểm người MỚI được thêm — gửi lại người cũ (nay đã bị khoá) không làm hỏng việc sửa card.
    if (assigneeIds !== undefined) {
      await assertAssigneesAssignable(this.prisma, assigneeIds.filter((id) => !existingAssigneeIds.has(id)));
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.kanbanCard.update({
        where: { id: cardId },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.contact_id !== undefined ? { contact_id: dto.contact_id } : {}),
          ...(assigneeIds !== undefined ? { assignee_id: assigneeIds[0] ?? null } : {}),
          ...(dto.due_at !== undefined ? { due_at: dto.due_at ? new Date(dto.due_at) : null } : {}),
          ...(dto.due_completed_at !== undefined
            ? { due_completed_at: dto.due_completed_at ? new Date(dto.due_completed_at) : null }
            : {}),
          ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
          ...(dto.labels !== undefined ? { labels: dto.labels ?? [] } : {}),
          ...(attributesPatch !== undefined ? { attributes: attributesPatch } : {}),
        },
      });
      if (assigneeIds !== undefined) await syncKanbanCardAssignees(tx, cardId, assigneeIds);
      await this.logCardUpdateActivities(tx, user.userId, cardId, dto, existing, assigneesChanged);
      return tx.kanbanCard.findUniqueOrThrow({ where: { id: cardId }, select: KANBAN_CARD_SELECT });
    });

    if (dto.description !== undefined) await this.links?.syncMentions({ type: 'task', id: cardId }, 'description', dto.description, user);
    const [result] = await this.attachContacts(user, access, [updated]);
    return result;
  }

  /** Tách khỏi `update()` để giữ hàm chính ngắn — ghi CẢ activity chuyên biệt
   * (contact/assigned) LẪN activity `updated` tổng hợp các field đã đổi. */
  private async logCardUpdateActivities(
    tx: Prisma.TransactionClient,
    actorId: number,
    cardId: number,
    dto: UpdateKanbanCardDto,
    existing: { contact_id: number | null },
    assigneesChanged: boolean,
  ): Promise<void> {
    if (dto.contact_id !== undefined && dto.contact_id !== existing.contact_id) {
      await logKanbanCardActivity(
        tx,
        cardId,
        actorId,
        dto.contact_id == null ? 'contact_unlinked' : 'contact_linked',
        { contact_id: dto.contact_id },
      );
    }
    if (assigneesChanged) {
      await logKanbanCardActivity(tx, cardId, actorId, 'assigned', {
        assignee_ids: resolveAssigneeIds(dto) ?? [],
      });
    }
    const changedFields = Object.keys(dto).filter(
      (k) => (dto as Record<string, unknown>)[k] !== undefined,
    );
    if (changedFields.length > 0) {
      await logKanbanCardActivity(tx, cardId, actorId, 'updated', { fields: changedFields });
    }
  }

  /** Xoá mềm — người tạo, hoặc Quản trị. Quản lý KHÔNG được xoá card của cấp dưới,
   * chỉ người tạo mới được. */
  async remove(user: AuthUser, access: KanbanAccessContext, cardId: number) {
    const card = await loadScopedCardOrNotFound(this.prisma, user, access, cardId);
    if (card.created_by !== user.userId && !user.isAdmin) {
      throw new ForbiddenException('Chỉ người tạo card hoặc Quản trị mới được xoá');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.kanbanCard.update({ where: { id: cardId }, data: { deleted_at: new Date(), deleted_by: user.userId } });
      await logKanbanCardActivity(tx, cardId, user.userId, 'deleted');
    });
    return { deleted: true };
  }

  /**
   * Hoàn tác xoá (web): khôi phục card vừa xoá mềm — người đã xoá hoặc Quản trị, trong `RESTORE_WINDOW_MS`,
   * board vẫn trong phạm vi xem của người khôi phục. Không có tool MCP tương ứng.
   */
  async restore(user: AuthUser, access: KanbanAccessContext, cardId: number) {
    // Cùng cổng phạm vi như loadScopedCardOrNotFound (board hiển thị + card trong phạm vi ⇒ ngoài phạm vi = 404),
    // nhưng tìm card ĐÃ xoá mềm; board đã xoá thì không khôi phục.
    const card = await this.prisma.kanbanCard.findFirst({
      where: { id: cardId, deleted_at: { not: null } },
      include: { board: true, assignees: { select: { user_id: true } } },
    });
    const notFound = () => new NotFoundException(`Không có card ${cardId} đang chờ khôi phục`);
    if (!card || !card.deleted_at || card.board.deleted_at || !isBoardVisibleToUser(user, access, card.board)) throw notFound();
    if (!canAccessKanbanCard(access, card)) throw notFound();
    if (card.deleted_by !== user.userId && !user.isAdmin) {
      throw new ForbiddenException('Chỉ người đã xoá hoặc Quản trị mới khôi phục được card này');
    }
    if (Date.now() - card.deleted_at.getTime() > RESTORE_WINDOW_MS) {
      throw new GoneException('Đã quá thời gian hoàn tác — card này không khôi phục được nữa');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.kanbanCard.update({ where: { id: cardId }, data: { deleted_at: null, deleted_by: null } });
      await logKanbanCardActivity(tx, cardId, user.userId, 'restored');
    });
    return { restored: true };
  }

  /** Batch-resolve contact display cho 1 trang card — KHÔNG N+1. */
  private async attachContacts(
    user: AuthUser,
    access: KanbanAccessContext,
    rows: KanbanCardRow[],
  ) {
    const contactIds = rows.map((r) => r.contact_id).filter((id): id is number => id != null);
    const contactMap = await resolveKanbanCardContactDisplays(this.prisma, this.scope, user, contactIds);
    return rows.map((row) =>
      toKanbanCardDto(row, row.contact_id != null ? contactMap.get(row.contact_id) ?? null : null),
    );
  }
}
