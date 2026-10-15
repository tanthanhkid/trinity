import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { CreateKanbanColumnDto } from './dto/create-column.dto';
import { UpdateKanbanColumnDto } from './dto/update-column.dto';
import { ReorderKanbanColumnsDto } from './dto/reorder-columns.dto';
import { computeAppendPosition, renormalizedPositions } from '../common/kanban-position.helper';

/**
 * CRUD cột — quyền `kanban.boards` (enforce ở controller `@Can`). Xoá cột còn
 * card BẮT BUỘC `move_to_column_id` ("không xoá im lặng") — dồn
 * card sang cột đích + ghi activity từng card, KHÔNG xoá card.
 */
@Injectable()
export class KanbanColumnsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(boardId: number, dto: CreateKanbanColumnDto) {
    await this.assertBoardExists(boardId);
    const last = await this.prisma.kanbanColumn.findFirst({
      where: { board_id: boardId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return this.prisma.kanbanColumn.create({
      data: {
        board_id: boardId,
        name: dto.name,
        color: dto.color ?? null,
        position: computeAppendPosition(last?.position ?? null),
        wip_limit: dto.wip_limit ?? null,
        is_done: dto.is_done ?? false,
      },
    });
  }

  async update(columnId: number, dto: UpdateKanbanColumnDto) {
    const column = await this.loadOrNotFound(columnId);
    const doneChanged = dto.is_done !== undefined && dto.is_done !== column.is_done;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.kanbanColumn.update({
        where: { id: columnId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          ...(dto.wip_limit !== undefined ? { wip_limit: dto.wip_limit } : {}),
          ...(dto.is_done !== undefined ? { is_done: dto.is_done } : {}),
          ...(dto.is_archived !== undefined ? { is_archived: dto.is_archived } : {}),
        },
      });
      // Giữ cùng bất biến với move(): card nằm trong cột "hoàn thành" thì có completed_at, ngược lại thì không.
      // Đổi cờ is_done của cột phải đồng bộ cho các card đang nằm sẵn trong cột (kẻo card không hoàn thành / báo quá hạn).
      if (doneChanged) {
        if (dto.is_done) {
          await tx.kanbanCard.updateMany({
            where: { column_id: columnId, deleted_at: null, completed_at: null },
            data: { completed_at: new Date() },
          });
        } else {
          await tx.kanbanCard.updateMany({
            where: { column_id: columnId, deleted_at: null, completed_at: { not: null } },
            data: { completed_at: null },
          });
        }
      }
      return updated;
    });
  }

  async reorder(boardId: number, dto: ReorderKanbanColumnsDto) {
    await this.assertBoardExists(boardId);
    const existing = await this.prisma.kanbanColumn.findMany({
      where: { board_id: boardId, is_archived: false },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((c) => c.id));
    const requestedIds = new Set(dto.column_ids);
    if (
      existingIds.size !== requestedIds.size ||
      !dto.column_ids.every((id) => existingIds.has(id))
    ) {
      throw new BadRequestException(
        'Danh sách cột không khớp — phải gồm ĐỦ và ĐÚNG các cột chưa ẩn của board',
      );
    }
    const positions = renormalizedPositions(dto.column_ids.length);
    await this.prisma.$transaction(
      dto.column_ids.map((id, i) =>
        this.prisma.kanbanColumn.update({ where: { id }, data: { position: positions[i] } }),
      ),
    );
    return this.prisma.kanbanColumn.findMany({
      where: { board_id: boardId, is_archived: false },
      orderBy: { position: 'asc' },
    });
  }

  /** `moveToColumnId` bắt buộc nếu cột còn card CHƯA xoá mềm. */
  async remove(columnId: number, moveToColumnId: number | undefined, actorUserId: number) {
    const column = await this.loadOrNotFound(columnId);
    const cardCount = await this.prisma.kanbanCard.count({
      where: { column_id: columnId, deleted_at: null },
    });

    if (cardCount === 0) {
      // FK card→column là Restrict: card đã xoá mềm còn nằm trong cột sẽ làm lệnh xoá cột lỗi 500.
      // Dọn hẳn chúng (comment/checklist/đính kèm/lịch sử của card tự xoá theo qua cascade).
      await this.prisma.kanbanCard.deleteMany({ where: { column_id: columnId, deleted_at: { not: null } } });
      await this.prisma.kanbanColumn.delete({ where: { id: columnId } });
      return { deleted: true, moved_cards: 0 };
    }

    if (!moveToColumnId) {
      throw new BadRequestException(
        `Cột còn ${cardCount} card — phải chọn cột đích (move_to_column_id) để dồn card sang trước khi xoá`,
      );
    }
    const target = await this.prisma.kanbanColumn.findFirst({
      where: { id: moveToColumnId, board_id: column.board_id },
    });
    if (!target) {
      throw new BadRequestException('Cột đích không thuộc cùng board hoặc không tồn tại');
    }
    if (target.id === column.id) {
      throw new BadRequestException('Cột đích phải khác cột đang xoá');
    }

    const moved = await this.prisma.$transaction(async (tx) => {
      const cards = await tx.kanbanCard.findMany({
        where: { column_id: columnId, deleted_at: null },
        orderBy: { position: 'asc' },
        select: { id: true },
      });
      const targetStillExists = await tx.kanbanColumn.findUnique({
        where: { id: target.id },
        select: { id: true },
      });
      if (!targetStillExists) throw new NotFoundException('Cột đích không tồn tại');
      let cursor = (
        await tx.kanbanCard.findFirst({
          where: { column_id: target.id, deleted_at: null },
          orderBy: { position: 'desc' },
          select: { position: true },
        })
      )?.position ?? null;

      for (const card of cards) {
        cursor = computeAppendPosition(cursor);
        await tx.kanbanCard.update({
          where: { id: card.id },
          data: {
            column_id: target.id,
            position: cursor,
            completed_at: target.is_done ? new Date() : null,
          },
        });
        await tx.kanbanCardActivity.create({
          data: {
            card_id: card.id,
            actor_id: actorUserId,
            action: 'moved',
            payload: {
              reason: 'column_deleted',
              from_column_id: columnId,
              to_column_id: target.id,
            },
          },
        });
      }
      await tx.kanbanCard.deleteMany({ where: { column_id: columnId, deleted_at: { not: null } } });
      await tx.kanbanColumn.delete({ where: { id: columnId } });
      return cards.length;
    });

    return { deleted: true, moved_cards: moved };
  }

  private async loadOrNotFound(columnId: number) {
    const column = await this.prisma.kanbanColumn.findUnique({ where: { id: columnId } });
    if (!column) throw new NotFoundException(`Không tìm thấy cột ID ${columnId}`);
    return column;
  }

  private async assertBoardExists(boardId: number): Promise<void> {
    const board = await this.prisma.kanbanBoard.findFirst({
      where: { id: boardId, deleted_at: null },
      select: { id: true },
    });
    if (!board) throw new NotFoundException(`Không tìm thấy board ID ${boardId}`);
  }
}
