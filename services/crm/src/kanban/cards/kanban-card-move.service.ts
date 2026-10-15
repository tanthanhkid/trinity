import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { ScopeService } from '@trinity/rbac-nest';
// ScopeService PHẢI import THẬT (không type-only) — constructor DI của NestJS
// cần class reference runtime cho `emitDecoratorMetadata`; import type ở đây
// làm Nest resolve param type ra `Object` và ném lỗi không inject được.
import type { AuthUser } from '@trinity/rbac-nest';
import { KanbanAccessContext, loadScopedCardOrNotFound } from '../common/kanban-rbac.helper';
import { resolveKanbanCardContactDisplays } from '../common/kanban-contact.helper';
import {
  computeBetweenPosition,
  renormalizedPositions,
} from '../common/kanban-position.helper';
import { KANBAN_CARD_SELECT, toKanbanCardDto } from './kanban-card.mapper';
import { logKanbanCardActivity } from './kanban-card-activity.helper';
import { MoveKanbanCardDto } from './dto/move-card.dto';

/**
 * Chuyển card sang cột khác/đổi vị trí trong cột — chạy trong 1 transaction riêng. Tách khỏi
 * `KanbanCardsService` để giữ file <200 dòng.
 */
@Injectable()
export class KanbanCardMoveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  async move(user: AuthUser, access: KanbanAccessContext, cardId: number, dto: MoveKanbanCardDto) {
    // Gate RBAC TRƯỚC, ngoài transaction — mọi thao tác sau chỉ đọc/ghi bằng `tx`.
    const card = await loadScopedCardOrNotFound(this.prisma, user, access, cardId);

    const result = await this.prisma.$transaction(async (tx) => {
      const targetColumn = await tx.kanbanColumn.findFirst({
        where: { id: dto.column_id, board_id: card.board_id },
      });
      if (!targetColumn) throw new BadRequestException('Cột đích không hợp lệ');
      if (targetColumn.is_archived) {
        throw new BadRequestException('Không thể chuyển card vào cột đã ẩn');
      }

      const [beforeCard, afterCard] = await Promise.all([
        dto.before_card_id
          ? tx.kanbanCard.findFirst({
              where: { id: dto.before_card_id, column_id: dto.column_id, deleted_at: null },
              select: { position: true },
            })
          : Promise.resolve(null),
        dto.after_card_id
          ? tx.kanbanCard.findFirst({
              where: { id: dto.after_card_id, column_id: dto.column_id, deleted_at: null },
              select: { position: true },
            })
          : Promise.resolve(null),
      ]);
      if (dto.before_card_id && !beforeCard) {
        throw new BadRequestException('before_card_id không hợp lệ');
      }
      if (dto.after_card_id && !afterCard) {
        throw new BadRequestException('after_card_id không hợp lệ');
      }

      let position = computeBetweenPosition(beforeCard?.position ?? null, afterCard?.position ?? null);
      if (position === null) {
        position = await this.renormalizeAndRetry(tx, dto);
      }

      const wasDone = card.completed_at != null;
      const nowDone = targetColumn.is_done;
      const updated = await tx.kanbanCard.update({
        where: { id: cardId },
        data: {
          column_id: dto.column_id,
          position,
          ...(nowDone && !wasDone ? { completed_at: new Date() } : {}),
          ...(!nowDone && wasDone ? { completed_at: null } : {}),
        },
        select: KANBAN_CARD_SELECT,
      });
      await logKanbanCardActivity(tx, cardId, user.userId, 'moved', {
        from_column_id: card.column_id,
        to_column_id: dto.column_id,
      });

      let wipWarning: string | null = null;
      if (targetColumn.wip_limit != null) {
        const count = await tx.kanbanCard.count({
          where: { column_id: dto.column_id, deleted_at: null },
        });
        if (count > targetColumn.wip_limit) {
          wipWarning = `Cột "${targetColumn.name}" đang vượt giới hạn WIP (${count}/${targetColumn.wip_limit})`;
        }
      }
      return { card: updated, wipWarning };
    });

    const contactMap = await resolveKanbanCardContactDisplays(
      this.prisma,
      this.scope,
      user,
      result.card.contact_id != null ? [result.card.contact_id] : [],
    );
    return {
      card: toKanbanCardDto(
        result.card,
        result.card.contact_id != null ? contactMap.get(result.card.contact_id) ?? null : null,
      ),
      wip_warning: result.wipWarning,
    };
  }

  /** Gap giữa 2 vị trí láng giềng đã cạn — sắp lại TOÀN BỘ cột đích rồi tính lại. */
  private async renormalizeAndRetry(
    tx: Prisma.TransactionClient,
    dto: MoveKanbanCardDto,
  ): Promise<number> {
    const cardsInColumn = await tx.kanbanCard.findMany({
      where: { column_id: dto.column_id, deleted_at: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    const positions = renormalizedPositions(cardsInColumn.length);
    await Promise.all(
      cardsInColumn.map((c, i) =>
        tx.kanbanCard.update({ where: { id: c.id }, data: { position: positions[i] } }),
      ),
    );
    const [refreshedBefore, refreshedAfter] = await Promise.all([
      dto.before_card_id
        ? tx.kanbanCard.findUnique({ where: { id: dto.before_card_id }, select: { position: true } })
        : Promise.resolve(null),
      dto.after_card_id
        ? tx.kanbanCard.findUnique({ where: { id: dto.after_card_id }, select: { position: true } })
        : Promise.resolve(null),
    ]);
    return (
      computeBetweenPosition(refreshedBefore?.position ?? null, refreshedAfter?.position ?? null) ??
      (positions[positions.length - 1] ?? 0) + 1024
    );
  }
}
