import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { KanbanAccessContext, loadScopedCardOrNotFound } from '../common/kanban-rbac.helper';
import { computeAppendPosition, renormalizedPositions } from '../common/kanban-position.helper';
import { logKanbanCardActivity } from '../cards/kanban-card-activity.helper';
import { KANBAN_CHECKLIST_ITEMS_MAX_PER_CARD } from '../common/kanban.constants';
import { CreateKanbanChecklistItemDto } from './dto/create-checklist-item.dto';
import { UpdateKanbanChecklistItemDto } from './dto/update-checklist-item.dto';
import { ReorderKanbanChecklistItemsDto } from './dto/reorder-checklist-items.dto';

/**
 * Checklist phẳng theo card — mọi endpoint gọi lại
 * `loadScopedCardOrNotFound` (endpoint con PHẢI mirror gate card cha,
 * ngoài phạm vi → 404 không phải 403).
 */
@Injectable()
export class KanbanChecklistService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser, access: KanbanAccessContext, cardId: number) {
    await loadScopedCardOrNotFound(this.prisma, user, access, cardId);
    return this.prisma.kanbanChecklistItem.findMany({
      where: { card_id: cardId },
      orderBy: { position: 'asc' },
    });
  }

  async create(
    user: AuthUser,
    access: KanbanAccessContext,
    cardId: number,
    dto: CreateKanbanChecklistItemDto,
  ) {
    await loadScopedCardOrNotFound(this.prisma, user, access, cardId);
    const count = await this.prisma.kanbanChecklistItem.count({ where: { card_id: cardId } });
    if (count >= KANBAN_CHECKLIST_ITEMS_MAX_PER_CARD) {
      throw new BadRequestException(`Card đã đạt trần ${KANBAN_CHECKLIST_ITEMS_MAX_PER_CARD} mục checklist`);
    }
    const last = await this.prisma.kanbanChecklistItem.findFirst({
      where: { card_id: cardId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const item = await this.prisma.$transaction(async (tx) => {
      const created = await tx.kanbanChecklistItem.create({
        data: {
          card_id: cardId,
          text: dto.text,
          position: computeAppendPosition(last?.position ?? null),
          created_by: user.userId,
        },
      });
      await logKanbanCardActivity(tx, cardId, user.userId, 'checklist_item_added', {
        item_id: created.id,
        text: created.text,
      });
      return created;
    });
    return item;
  }

  async update(
    user: AuthUser,
    access: KanbanAccessContext,
    itemId: number,
    dto: UpdateKanbanChecklistItemDto,
  ) {
    const item = await this.loadItemOrNotFound(itemId);
    await loadScopedCardOrNotFound(this.prisma, user, access, item.card_id);
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.kanbanChecklistItem.update({
        where: { id: itemId },
        data: {
          ...(dto.text !== undefined ? { text: dto.text } : {}),
          ...(dto.is_done !== undefined ? { is_done: dto.is_done } : {}),
        },
      });
      if (dto.is_done !== undefined && dto.is_done !== item.is_done) {
        await logKanbanCardActivity(tx, item.card_id, user.userId, 'checklist_item_toggled', {
          item_id: itemId,
          is_done: dto.is_done,
          text: next.text,
        });
      }
      return next;
    });
    return updated;
  }

  async reorder(
    user: AuthUser,
    access: KanbanAccessContext,
    cardId: number,
    dto: ReorderKanbanChecklistItemsDto,
  ) {
    await loadScopedCardOrNotFound(this.prisma, user, access, cardId);
    const existing = await this.prisma.kanbanChecklistItem.findMany({
      where: { card_id: cardId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((i) => i.id));
    const requestedIds = new Set(dto.item_ids);
    if (
      existingIds.size !== requestedIds.size ||
      !dto.item_ids.every((id) => existingIds.has(id))
    ) {
      throw new BadRequestException(
        'Danh sách mục không khớp — phải gồm ĐỦ và ĐÚNG các mục hiện có của card',
      );
    }
    const positions = renormalizedPositions(dto.item_ids.length);
    await this.prisma.$transaction(
      dto.item_ids.map((id, i) =>
        this.prisma.kanbanChecklistItem.update({ where: { id }, data: { position: positions[i] } }),
      ),
    );
    return this.prisma.kanbanChecklistItem.findMany({
      where: { card_id: cardId },
      orderBy: { position: 'asc' },
    });
  }

  async remove(user: AuthUser, access: KanbanAccessContext, itemId: number) {
    const item = await this.loadItemOrNotFound(itemId);
    const card = await loadScopedCardOrNotFound(this.prisma, user, access, item.card_id);
    if (item.created_by != null && item.created_by !== user.userId && !user.isAdmin) {
      // Người tạo item hoặc Quản trị mới được xoá — mirror `KanbanCardsService.remove`.
      // Card ĐƯỢC người khác thao tác/gán checklist thì người TẠO CARD vẫn xoá được
      // (dọn dẹp card của chính mình), khớp trực giác Trello "chủ thẻ dọn được mọi thứ".
      if (card.created_by !== user.userId) {
        throw new BadRequestException('Chỉ người tạo mục, chủ card hoặc Quản trị mới được xoá');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.kanbanChecklistItem.delete({ where: { id: itemId } });
      await logKanbanCardActivity(tx, item.card_id, user.userId, 'checklist_item_removed', {
        item_id: itemId,
        text: item.text,
      });
    });
    return { deleted: true };
  }

  private async loadItemOrNotFound(itemId: number) {
    const item = await this.prisma.kanbanChecklistItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException(`Không tìm thấy mục checklist ID ${itemId}`);
    return item;
  }
}
