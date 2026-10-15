import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { KanbanColumnsService } from '../columns/kanban-columns.service';

function buildPrismaMock() {
  const prisma = {
    kanbanBoard: { findFirst: jest.fn() },
    kanbanColumn: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    kanbanCard: {
      count: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    kanbanCardActivity: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(prisma);
    return Promise.all(arg as Promise<unknown>[]);
  });
  return prisma;
}

describe('KanbanColumnsService.remove — xoá cột (§Chức năng)', () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let service: KanbanColumnsService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new KanbanColumnsService(prisma as unknown as PrismaService);
    prisma.kanbanColumn.findUnique.mockResolvedValue({
      id: 1,
      board_id: 10,
      is_done: false,
      is_archived: false,
    });
  });

  it('cột không tồn tại => 404', async () => {
    prisma.kanbanColumn.findUnique.mockResolvedValue(null);
    await expect(service.remove(1, undefined, 1)).rejects.toThrow(NotFoundException);
  });

  it('cột RỖNG (0 card) => xoá thẳng, KHÔNG cần move_to_column_id', async () => {
    prisma.kanbanCard.count.mockResolvedValue(0);
    const result = await service.remove(1, undefined, 1);
    expect(result).toEqual({ deleted: true, moved_cards: 0 });
    expect(prisma.kanbanCard.deleteMany).toHaveBeenCalledWith({ where: { column_id: 1, deleted_at: { not: null } } });
    expect(prisma.kanbanColumn.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('cột CÒN CARD + KHÔNG truyền move_to_column_id => 400, KHÔNG xoá im lặng', async () => {
    prisma.kanbanCard.count.mockResolvedValue(3);
    await expect(service.remove(1, undefined, 1)).rejects.toThrow(BadRequestException);
    expect(prisma.kanbanColumn.delete).not.toHaveBeenCalled();
  });

  it('move_to_column_id trỏ cột KHÔNG cùng board => 400', async () => {
    prisma.kanbanCard.count.mockResolvedValue(2);
    prisma.kanbanColumn.findFirst.mockResolvedValue(null); // khác board_id -> không tìm thấy
    await expect(service.remove(1, 999, 1)).rejects.toThrow(BadRequestException);
  });

  it('move_to_column_id = chính cột đang xoá => 400', async () => {
    prisma.kanbanCard.count.mockResolvedValue(2);
    prisma.kanbanColumn.findFirst.mockResolvedValue({ id: 1, board_id: 10, is_done: false });
    await expect(service.remove(1, 1, 1)).rejects.toThrow(BadRequestException);
  });

  it('dồn card sang cột đích hợp lệ rồi mới xoá cột nguồn — KHÔNG mất card', async () => {
    prisma.kanbanCard.count.mockResolvedValue(2);
    prisma.kanbanColumn.findFirst.mockResolvedValue({ id: 2, board_id: 10, is_done: true });
    prisma.kanbanCard.findMany.mockResolvedValue([{ id: 501 }, { id: 502 }]);
    prisma.kanbanColumn.findUnique
      .mockResolvedValueOnce({ id: 1, board_id: 10, is_done: false, is_archived: false }) // loadOrNotFound
      .mockResolvedValueOnce({ id: 2 }); // targetStillExists check trong tx
    prisma.kanbanCard.findFirst.mockResolvedValue(null); // cột đích đang rỗng

    const result = await service.remove(1, 2, 42);

    expect(result).toEqual({ deleted: true, moved_cards: 2 });
    expect(prisma.kanbanCard.update).toHaveBeenCalledTimes(2);
    for (const call of prisma.kanbanCard.update.mock.calls) {
      expect(call[0].data.column_id).toBe(2);
      // cột đích is_done=true => set completed_at
      expect(call[0].data.completed_at).toBeInstanceOf(Date);
    }
    // ghi activity 'moved' cho MỖI card, actor = người xoá cột (42), KHÔNG null
    expect(prisma.kanbanCardActivity.create).toHaveBeenCalledTimes(2);
    for (const call of prisma.kanbanCardActivity.create.mock.calls) {
      expect(call[0].data.actor_id).toBe(42);
      expect(call[0].data.action).toBe('moved');
      expect(call[0].data.payload.reason).toBe('column_deleted');
    }
    expect(prisma.kanbanColumn.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });
});

describe('KanbanColumnsService.reorder', () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let service: KanbanColumnsService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new KanbanColumnsService(prisma as unknown as PrismaService);
    prisma.kanbanBoard.findFirst.mockResolvedValue({ id: 10 });
  });

  it('danh sách column_ids thiếu/thừa so với cột thật của board => 400', async () => {
    prisma.kanbanColumn.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    await expect(
      service.reorder(10, { column_ids: [1, 2] } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('danh sách khớp đủ => cập nhật position cách đều, tăng dần', async () => {
    prisma.kanbanColumn.findMany
      .mockResolvedValueOnce([{ id: 3 }, { id: 1 }, { id: 2 }]) // existing (thứ tự bất kỳ)
      .mockResolvedValueOnce([{ id: 3 }, { id: 1 }, { id: 2 }]); // trả về sau reorder
    await service.reorder(10, { column_ids: [3, 1, 2] } as never);
    const updateCalls = prisma.kanbanColumn.update.mock.calls;
    expect(updateCalls[0][0]).toEqual({ where: { id: 3 }, data: { position: 1024 } });
    expect(updateCalls[1][0]).toEqual({ where: { id: 1 }, data: { position: 2048 } });
    expect(updateCalls[2][0]).toEqual({ where: { id: 2 }, data: { position: 3072 } });
  });
});

describe('KanbanColumnsService.update — đổi is_done đồng bộ completed_at của card', () => {
  function setup(isDone: boolean) {
    const prisma = buildPrismaMock();
    prisma.kanbanColumn.findUnique.mockResolvedValue({ id: 1, board_id: 10, is_done: isDone, is_archived: false });
    prisma.kanbanColumn.update.mockResolvedValue({ id: 1 });
    return { prisma, service: new KanbanColumnsService(prisma as unknown as PrismaService) };
  }

  it('false → true: card chưa có completed_at được đặt completed_at', async () => {
    const { prisma, service } = setup(false);
    await service.update(1, { is_done: true } as never);
    expect(prisma.kanbanCard.updateMany).toHaveBeenCalledWith({
      where: { column_id: 1, deleted_at: null, completed_at: null },
      data: { completed_at: expect.any(Date) },
    });
  });

  it('true → false: xoá completed_at của card trong cột', async () => {
    const { prisma, service } = setup(true);
    await service.update(1, { is_done: false } as never);
    expect(prisma.kanbanCard.updateMany).toHaveBeenCalledWith({
      where: { column_id: 1, deleted_at: null, completed_at: { not: null } },
      data: { completed_at: null },
    });
  });

  it('không đổi is_done: không đụng card', async () => {
    const { prisma, service } = setup(true);
    await service.update(1, { is_done: true, name: 'x' } as never);
    expect(prisma.kanbanCard.updateMany).not.toHaveBeenCalled();
  });
});
