import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { CreateKanbanBoardDto } from './dto/create-board.dto';
import { UpdateKanbanBoardDto } from './dto/update-board.dto';
import { CreateKanbanBoardFromTemplateDto } from './dto/create-board-from-template.dto';
import { CreateKanbanLabelDto } from './dto/create-label.dto';
import { UpdateKanbanLabelDto } from './dto/update-label.dto';
import {
  buildKanbanBoardVisibilityWhere,
  KanbanAccessContext,
  loadVisibleBoardOrNotFound,
} from '../common/kanban-rbac.helper';
import { findKanbanTemplate, KANBAN_TEMPLATES } from '../common/kanban-templates';
import { renormalizedPositions } from '../common/kanban-position.helper';
import {
  createKanbanLabel,
  parseKanbanLabelDefs,
  removeKanbanLabel,
  updateKanbanLabel,
} from '../common/kanban-label.helper';

const BOARD_LIST_SELECT = {
  id: true,
  name: true,
  description: true,
  icon: true,
  color: true,
  is_active: true,
  visibility_role_ids: true,
  card_prefix: true,
  created_by: true,
  created_at: true,
  updated_at: true,
  _count: { select: { columns: true, cards: { where: { deleted_at: null } } } },
} as const;

@Injectable()
export class KanbanBoardsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllVisible(user: AuthUser, access: KanbanAccessContext) {
    const boards = await this.prisma.kanbanBoard.findMany({
      where: buildKanbanBoardVisibilityWhere(user, access),
      select: BOARD_LIST_SELECT,
      orderBy: [{ name: 'asc' }],
    });
    return boards.map(({ _count, ...b }) => ({
      ...b,
      column_count: _count.columns,
      card_count: _count.cards,
    }));
  }

  /** Chi tiết board + cột (KHÔNG cột đã archive) + field defs, theo `position`. */
  async findOneDetail(user: AuthUser, access: KanbanAccessContext, boardId: number) {
    const board = await loadVisibleBoardOrNotFound(this.prisma, user, access, boardId);
    const [columns, fieldDefs] = await Promise.all([
      this.prisma.kanbanColumn.findMany({
        where: { board_id: boardId, is_archived: false },
        orderBy: { position: 'asc' },
      }),
      this.prisma.kanbanFieldDef.findMany({
        where: { board_id: boardId },
        orderBy: { position: 'asc' },
      }),
    ]);
    return { ...board, label_defs: parseKanbanLabelDefs(board.label_defs), columns, field_defs: fieldDefs };
  }

  /** Yêu cầu quyền `kanban.boards` — enforce ở controller (`@Can`). */
  async create(dto: CreateKanbanBoardDto, userId: number) {
    return this.prisma.kanbanBoard.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        color: dto.color ?? null,
        visibility_role_ids: dto.visibility_role_ids ?? [],
        card_prefix: dto.card_prefix ?? null,
        settings: (dto.settings ?? {}) as object,
        created_by: userId,
      },
    });
  }

  async update(boardId: number, dto: UpdateKanbanBoardDto) {
    await this.assertExists(boardId);
    return this.prisma.kanbanBoard.update({
      where: { id: boardId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.visibility_role_ids !== undefined
          ? { visibility_role_ids: dto.visibility_role_ids }
          : {}),
        ...(dto.card_prefix !== undefined ? { card_prefix: dto.card_prefix } : {}),
        ...(dto.settings !== undefined ? { settings: dto.settings as object } : {}),
        ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
      },
    });
  }

  /** Soft-delete — giữ cột/card/lịch sử để audit, chỉ ẩn khỏi danh sách. */
  async remove(boardId: number) {
    await this.assertExists(boardId);
    return this.prisma.kanbanBoard.update({
      where: { id: boardId },
      data: { deleted_at: new Date() },
    });
  }

  listTemplates() {
    return KANBAN_TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      columns: t.columns.map((c) => c.name),
    }));
  }

  async createFromTemplate(dto: CreateKanbanBoardFromTemplateDto, userId: number) {
    const template = findKanbanTemplate(dto.template_key);
    if (!template) throw new BadRequestException('template_key không hợp lệ');
    const positions = renormalizedPositions(template.columns.length);
    return this.prisma.$transaction(async (tx) => {
      const board = await tx.kanbanBoard.create({
        data: {
          name: dto.name?.trim() || template.name,
          description: template.description,
          created_by: userId,
        },
      });
      const columns = await Promise.all(
        template.columns.map((col, i) =>
          tx.kanbanColumn.create({
            data: {
              board_id: board.id,
              name: col.name,
              position: positions[i],
              is_done: col.is_done ?? false,
            },
          }),
        ),
      );
      return { ...board, columns };
    });
  }

  /** Gate DUY NHẤT của 3 method nhãn dưới đây: board phải HIỂN THỊ với actor
   * (404 nếu không — mirror gate card, KHÔNG phải quyền `kanban.boards` như
   * cấu hình cột/field-def). */
  private async assertBoardVisible(
    user: AuthUser,
    access: KanbanAccessContext,
    boardId: number,
  ): Promise<void> {
    await loadVisibleBoardOrNotFound(this.prisma, user, access, boardId);
  }

  async createLabel(
    user: AuthUser,
    access: KanbanAccessContext,
    boardId: number,
    dto: CreateKanbanLabelDto,
  ) {
    await this.assertBoardVisible(user, access, boardId);
    const labels = await createKanbanLabel(this.prisma, boardId, dto);
    return { labels };
  }

  async updateLabel(
    user: AuthUser,
    access: KanbanAccessContext,
    boardId: number,
    labelId: string,
    dto: UpdateKanbanLabelDto,
  ) {
    await this.assertBoardVisible(user, access, boardId);
    const labels = await updateKanbanLabel(this.prisma, boardId, labelId, dto);
    return { labels };
  }

  async removeLabel(user: AuthUser, access: KanbanAccessContext, boardId: number, labelId: string) {
    await this.assertBoardVisible(user, access, boardId);
    const labels = await removeKanbanLabel(this.prisma, boardId, labelId);
    return { labels };
  }

  private async assertExists(boardId: number): Promise<void> {
    const board = await this.prisma.kanbanBoard.findFirst({
      where: { id: boardId, deleted_at: null },
      select: { id: true },
    });
    if (!board) throw new NotFoundException(`Không tìm thấy board ID ${boardId}`);
  }
}
