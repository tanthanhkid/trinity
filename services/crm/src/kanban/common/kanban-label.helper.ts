import { randomUUID } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { KANBAN_BOARD_LABEL_MAX_DEFS } from './kanban.constants';

/** 1 nhãn màu của board — lưu trong `KanbanBoard.label_defs` (JSON, KHÔNG
 * bảng riêng, mirror `KanbanFieldDef.options` — bảng nhỏ theo board, không
 * cần query riêng). */
export interface KanbanLabelDef {
  id: string;
  name: string;
  color: string;
}

/** Đọc + validate hình dạng `label_defs` hiện có trên board — JSON hỏng/tự sửa
 * tay coi như rỗng thay vì crash (mirror `mergeKanbanAttributes` triết lý
 * "field lỗi không được sập cả card"). */
export function parseKanbanLabelDefs(raw: unknown): KanbanLabelDef[] {
  if (!Array.isArray(raw)) return [];
  const result: KanbanLabelDef[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      typeof (item as Record<string, unknown>).name === 'string' &&
      typeof (item as Record<string, unknown>).color === 'string'
    ) {
      const it = item as { id: string; name: string; color: string };
      result.push({ id: it.id, name: it.name, color: it.color });
    }
  }
  return result;
}

export async function loadBoardLabelDefs(
  prisma: PrismaService,
  boardId: number,
): Promise<{ boardExists: boolean; labels: KanbanLabelDef[] }> {
  const board = await prisma.kanbanBoard.findFirst({
    where: { id: boardId, deleted_at: null },
    select: { label_defs: true },
  });
  if (!board) return { boardExists: false, labels: [] };
  return { boardExists: true, labels: parseKanbanLabelDefs(board.label_defs) };
}

export async function createKanbanLabel(
  prisma: PrismaService,
  boardId: number,
  dto: { name: string; color: string },
): Promise<KanbanLabelDef[]> {
  const { boardExists, labels } = await loadBoardLabelDefs(prisma, boardId);
  if (!boardExists) throw new NotFoundException(`Không tìm thấy board ID ${boardId}`);
  if (labels.length >= KANBAN_BOARD_LABEL_MAX_DEFS) {
    throw new BadRequestException(`Board đã đạt trần ${KANBAN_BOARD_LABEL_MAX_DEFS} nhãn`);
  }
  const next: KanbanLabelDef[] = [
    ...labels,
    { id: randomUUID(), name: dto.name.trim(), color: dto.color },
  ];
  await prisma.kanbanBoard.update({
    where: { id: boardId },
    data: { label_defs: next as unknown as object },
  });
  return next;
}

export async function updateKanbanLabel(
  prisma: PrismaService,
  boardId: number,
  labelId: string,
  dto: { name?: string; color?: string },
): Promise<KanbanLabelDef[]> {
  const { boardExists, labels } = await loadBoardLabelDefs(prisma, boardId);
  if (!boardExists) throw new NotFoundException(`Không tìm thấy board ID ${boardId}`);
  const idx = labels.findIndex((l) => l.id === labelId);
  if (idx === -1) throw new NotFoundException(`Không tìm thấy nhãn ID ${labelId}`);
  const next = [...labels];
  next[idx] = {
    ...next[idx],
    ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
    ...(dto.color !== undefined ? { color: dto.color } : {}),
  };
  await prisma.kanbanBoard.update({
    where: { id: boardId },
    data: { label_defs: next as unknown as object },
  });
  return next;
}

/**
 * Xoá 1 nhãn khỏi registry của board VÀ dọn tham chiếu khỏi MỌI card đang gắn
 * nó (`kanban_cards.labels` là mảng id) — tránh card giữ id "mồ côi" hiển thị
 * lỗi ở FE. Raw SQL `array_remove` — xoá tại nguồn 1 câu, KHÔNG load từng
 * card ra JS rồi ghi lại (bảng có thể có hàng nghìn card).
 */
export async function removeKanbanLabel(
  prisma: PrismaService,
  boardId: number,
  labelId: string,
): Promise<KanbanLabelDef[]> {
  const { boardExists, labels } = await loadBoardLabelDefs(prisma, boardId);
  if (!boardExists) throw new NotFoundException(`Không tìm thấy board ID ${boardId}`);
  if (!labels.some((l) => l.id === labelId)) {
    throw new NotFoundException(`Không tìm thấy nhãn ID ${labelId}`);
  }
  const next = labels.filter((l) => l.id !== labelId);
  await prisma.$transaction([
    prisma.kanbanBoard.update({
      where: { id: boardId },
      data: { label_defs: next as unknown as object },
    }),
    prisma.$executeRaw(
      Prisma.sql`UPDATE "kanban_cards" SET "labels" = array_remove("labels", ${labelId}) WHERE "board_id" = ${boardId}`,
    ),
  ]);
  return next;
}
