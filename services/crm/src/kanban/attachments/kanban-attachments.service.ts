import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { KanbanAccessContext, loadScopedCardOrNotFound } from '../common/kanban-rbac.helper';
import { logKanbanCardActivity } from '../cards/kanban-card-activity.helper';
import { KANBAN_ATTACHMENTS_MAX_PER_CARD } from '../common/kanban.constants';
import { CreateKanbanAttachmentDto } from './dto/create-attachment.dto';

/**
 * Đính kèm DẠNG LINK. mọi thao tác gọi lại
 * `loadScopedCardOrNotFound` — ngoài phạm vi card → 404.
 */
@Injectable()
export class KanbanAttachmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser, access: KanbanAccessContext, cardId: number) {
    await loadScopedCardOrNotFound(this.prisma, user, access, cardId);
    return this.prisma.kanbanCardAttachment.findMany({
      where: { card_id: cardId },
      orderBy: { created_at: 'desc' },
    });
  }

  async create(
    user: AuthUser,
    access: KanbanAccessContext,
    cardId: number,
    dto: CreateKanbanAttachmentDto,
  ) {
    await loadScopedCardOrNotFound(this.prisma, user, access, cardId);
    const count = await this.prisma.kanbanCardAttachment.count({ where: { card_id: cardId } });
    if (count >= KANBAN_ATTACHMENTS_MAX_PER_CARD) {
      throw new BadRequestException(`Card đã đạt trần ${KANBAN_ATTACHMENTS_MAX_PER_CARD} đính kèm`);
    }
    return this.prisma.$transaction(async (tx) => {
      const attachment = await tx.kanbanCardAttachment.create({
        data: {
          card_id: cardId,
          url: dto.url,
          title: dto.title?.trim() || null,
          created_by: user.userId,
        },
      });
      await logKanbanCardActivity(tx, cardId, user.userId, 'attachment_added', {
        attachment_id: attachment.id,
        title: attachment.title,
        url: attachment.url,
      });
      return attachment;
    });
  }

  /** Người tạo đính kèm, chủ card, hoặc Quản trị — mirror
   * `KanbanCardsService.remove`. */
  async remove(user: AuthUser, access: KanbanAccessContext, attachmentId: number) {
    const attachment = await this.prisma.kanbanCardAttachment.findUnique({
      where: { id: attachmentId },
    });
    if (!attachment) throw new NotFoundException(`Không tìm thấy đính kèm ID ${attachmentId}`);
    const card = await loadScopedCardOrNotFound(this.prisma, user, access, attachment.card_id);
    const canRemove =
      attachment.created_by === user.userId || card.created_by === user.userId || user.isAdmin;
    if (!canRemove) {
      throw new ForbiddenException('Chỉ người đính kèm, chủ card hoặc Quản trị mới được xoá');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.kanbanCardAttachment.delete({ where: { id: attachmentId } });
      await logKanbanCardActivity(tx, attachment.card_id, user.userId, 'attachment_removed', {
        attachment_id: attachmentId,
        title: attachment.title,
      });
    });
    return { deleted: true };
  }
}
