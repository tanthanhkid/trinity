import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { CreateKanbanFieldDefDto } from './dto/create-field-def.dto';
import { UpdateKanbanFieldDefDto } from './dto/update-field-def.dto';
import { ReorderKanbanFieldDefsDto } from './dto/reorder-field-defs.dto';
import { computeAppendPosition, renormalizedPositions } from '../common/kanban-position.helper';

const OPTION_REQUIRED_TYPES = new Set(['select', 'multi_select']);

/** CRUD trường tuỳ biến của board — quyền `kanban.boards` (enforce ở controller). */
@Injectable()
export class KanbanFieldDefsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(boardId: number, dto: CreateKanbanFieldDefDto) {
    await this.assertBoardExists(boardId);
    this.assertOptionsValidForType(dto.type, dto.options);
    const last = await this.prisma.kanbanFieldDef.findFirst({
      where: { board_id: boardId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    try {
      return await this.prisma.kanbanFieldDef.create({
        data: {
          board_id: boardId,
          key: dto.key,
          label: dto.label,
          type: dto.type,
          // Cột `options` là Json? — Prisma 6 từ chối `null` JS, phải dùng Prisma.DbNull.
          options: dto.options ? (dto.options as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          required: dto.required ?? false,
          show_on_card: dto.show_on_card ?? false,
          position: computeAppendPosition(last?.position ?? null),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Trường "${dto.key}" đã tồn tại trong board này`);
      }
      throw err;
    }
  }

  async update(fieldDefId: number, dto: UpdateKanbanFieldDefDto) {
    const existing = await this.loadOrNotFound(fieldDefId);
    const effectiveType = existing.type;
    if (dto.options !== undefined) {
      this.assertOptionsValidForType(effectiveType, dto.options);
    }
    return this.prisma.kanbanFieldDef.update({
      where: { id: fieldDefId },
      data: {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.options !== undefined
          ? { options: dto.options ? (dto.options as unknown as Prisma.InputJsonValue) : Prisma.DbNull }
          : {}),
        ...(dto.required != null ? { required: dto.required } : {}),
        ...(dto.show_on_card != null ? { show_on_card: dto.show_on_card } : {}),
      },
    });
  }

  async reorder(boardId: number, dto: ReorderKanbanFieldDefsDto) {
    const existing = await this.prisma.kanbanFieldDef.findMany({
      where: { board_id: boardId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((d) => d.id));
    const requestedIds = new Set(dto.field_def_ids);
    if (
      existingIds.size !== requestedIds.size ||
      !dto.field_def_ids.every((id) => existingIds.has(id))
    ) {
      throw new BadRequestException(
        'Danh sách trường không khớp — phải gồm ĐỦ và ĐÚNG các trường của board',
      );
    }
    const positions = renormalizedPositions(dto.field_def_ids.length);
    await this.prisma.$transaction(
      dto.field_def_ids.map((id, i) =>
        this.prisma.kanbanFieldDef.update({ where: { id }, data: { position: positions[i] } }),
      ),
    );
    return this.prisma.kanbanFieldDef.findMany({
      where: { board_id: boardId },
      orderBy: { position: 'asc' },
    });
  }

  /** Hard-delete — giá trị ĐÃ LƯU trên card giữ nguyên trong JSON (mồ côi), không
   * crash khi render (§Kỹ thuật). */
  async remove(fieldDefId: number) {
    await this.loadOrNotFound(fieldDefId);
    await this.prisma.kanbanFieldDef.delete({ where: { id: fieldDefId } });
    return { deleted: true };
  }

  private assertOptionsValidForType(type: string, options: unknown): void {
    if (OPTION_REQUIRED_TYPES.has(type) && (!Array.isArray(options) || options.length === 0)) {
      throw new BadRequestException(
        `Trường type="${type}" bắt buộc phải có "options" (ít nhất 1 lựa chọn)`,
      );
    }
  }

  private async loadOrNotFound(fieldDefId: number) {
    const def = await this.prisma.kanbanFieldDef.findUnique({ where: { id: fieldDefId } });
    if (!def) throw new NotFoundException(`Không tìm thấy trường tuỳ biến ID ${fieldDefId}`);
    return def;
  }

  private async assertBoardExists(boardId: number): Promise<void> {
    const board = await this.prisma.kanbanBoard.findFirst({
      where: { id: boardId, deleted_at: null },
      select: { id: true },
    });
    if (!board) throw new NotFoundException(`Không tìm thấy board ID ${boardId}`);
  }
}
