import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import {
  createKanbanLabel,
  parseKanbanLabelDefs,
  removeKanbanLabel,
  updateKanbanLabel,
} from '../common/kanban-label.helper';
import { KANBAN_BOARD_LABEL_MAX_DEFS } from '../common/kanban.constants';

describe('parseKanbanLabelDefs — chống JSON hỏng/tự sửa tay', () => {
  it('không phải mảng => []', () => {
    expect(parseKanbanLabelDefs(null)).toEqual([]);
    expect(parseKanbanLabelDefs({})).toEqual([]);
  });

  it('phần tử thiếu field hoặc sai kiểu => bị loại, KHÔNG crash cả mảng', () => {
    expect(
      parseKanbanLabelDefs([
        { id: 'a', name: 'Gấp', color: '#eb5a46' },
        { id: 'b', name: 123, color: '#fff' },
        'trash',
        null,
      ]),
    ).toEqual([{ id: 'a', name: 'Gấp', color: '#eb5a46' }]);
  });
});

function mockPrisma(labelDefs: unknown, boardExists = true) {
  return {
    kanbanBoard: {
      findFirst: jest.fn().mockResolvedValue(boardExists ? { label_defs: labelDefs } : null),
      update: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
}

describe('createKanbanLabel', () => {
  it('board không tồn tại => 404', async () => {
    const prisma = mockPrisma([], false);
    await expect(createKanbanLabel(prisma, 1, { name: 'x', color: '#fff' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('đạt trần KANBAN_BOARD_LABEL_MAX_DEFS => 400', async () => {
    const full = Array.from({ length: KANBAN_BOARD_LABEL_MAX_DEFS }, (_, i) => ({
      id: String(i),
      name: `L${i}`,
      color: '#fff',
    }));
    const prisma = mockPrisma(full);
    await expect(createKanbanLabel(prisma, 1, { name: 'x', color: '#fff' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('tạo thành công => append vào cuối, sinh id mới', async () => {
    const prisma = mockPrisma([{ id: 'a', name: 'Cũ', color: '#000' }]);
    const result = await createKanbanLabel(prisma, 1, { name: 'Mới', color: '#eb5a46' });
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual(expect.objectContaining({ name: 'Mới', color: '#eb5a46' }));
    expect(result[1].id).not.toBe('a');
  });
});

describe('updateKanbanLabel', () => {
  it('labelId không tồn tại trong board => 404', async () => {
    const prisma = mockPrisma([{ id: 'a', name: 'Cũ', color: '#000' }]);
    await expect(updateKanbanLabel(prisma, 1, 'ngoai-lai', { name: 'x' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('sửa đúng phần tử theo id, giữ nguyên field không gửi', async () => {
    const prisma = mockPrisma([{ id: 'a', name: 'Cũ', color: '#000' }]);
    const result = await updateKanbanLabel(prisma, 1, 'a', { color: '#fff' });
    expect(result).toEqual([{ id: 'a', name: 'Cũ', color: '#fff' }]);
  });
});

describe('removeKanbanLabel — dọn tham chiếu khỏi mọi card', () => {
  it('labelId không tồn tại => 404, KHÔNG đụng DB', async () => {
    const prisma = mockPrisma([{ id: 'a', name: 'Cũ', color: '#000' }]);
    await expect(removeKanbanLabel(prisma, 1, 'ngoai-lai')).rejects.toThrow(NotFoundException);
    expect((prisma as unknown as { $transaction: jest.Mock }).$transaction).not.toHaveBeenCalled();
  });

  it('xoá đúng nhãn + chạy array_remove trên kanban_cards.labels', async () => {
    const prisma = mockPrisma([
      { id: 'a', name: 'Giữ', color: '#000' },
      { id: 'b', name: 'Xoá', color: '#fff' },
    ]);
    const result = await removeKanbanLabel(prisma, 1, 'b');
    expect(result).toEqual([{ id: 'a', name: 'Giữ', color: '#000' }]);
    expect((prisma as unknown as { $executeRaw: jest.Mock }).$executeRaw).toHaveBeenCalled();
  });
});
