import { BadRequestException } from '@nestjs/common';
import { resolveAssigneeIds, syncKanbanCardAssignees } from '../cards/kanban-card-assignee.helper';
import { KANBAN_CARD_ASSIGNEES_MAX } from '../common/kanban.constants';

describe('resolveAssigneeIds', () => {
  it('assignee_ids có mặt => THẮNG assignee_id, dedup', () => {
    expect(resolveAssigneeIds({ assignee_id: 1, assignee_ids: [2, 3, 2] })).toEqual([2, 3]);
  });

  it('assignee_ids rỗng [] => gỡ hết (KHÁC undefined)', () => {
    expect(resolveAssigneeIds({ assignee_ids: [] })).toEqual([]);
  });

  it('chỉ assignee_id (đơn, tương thích ngược) => bọc thành mảng 1 phần tử', () => {
    expect(resolveAssigneeIds({ assignee_id: 5 })).toEqual([5]);
  });

  it('assignee_id=null => gỡ (mảng rỗng)', () => {
    expect(resolveAssigneeIds({ assignee_id: null })).toEqual([]);
  });

  it('cả 2 field đều KHÔNG có mặt => undefined ("không đụng tới")', () => {
    expect(resolveAssigneeIds({})).toBeUndefined();
  });

  it('vượt trần KANBAN_CARD_ASSIGNEES_MAX => BadRequestException', () => {
    const ids = Array.from({ length: KANBAN_CARD_ASSIGNEES_MAX + 1 }, (_, i) => i + 1);
    expect(() => resolveAssigneeIds({ assignee_ids: ids })).toThrow(BadRequestException);
  });
});

describe('syncKanbanCardAssignees', () => {
  function mockTx() {
    return {
      kanbanCardAssignee: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
  }

  it('luôn xoá hết trước (replace-all)', async () => {
    const tx = mockTx();
    await syncKanbanCardAssignees(tx as never, 1, [7]);
    expect(tx.kanbanCardAssignee.deleteMany).toHaveBeenCalledWith({ where: { card_id: 1 } });
  });

  it('mảng rỗng => chỉ xoá, KHÔNG gọi createMany', async () => {
    const tx = mockTx();
    await syncKanbanCardAssignees(tx as never, 1, []);
    expect(tx.kanbanCardAssignee.createMany).not.toHaveBeenCalled();
  });

  it('mảng có phần tử => createMany đúng shape, skipDuplicates', async () => {
    const tx = mockTx();
    await syncKanbanCardAssignees(tx as never, 1, [7, 8]);
    expect(tx.kanbanCardAssignee.createMany).toHaveBeenCalledWith({
      data: [
        { card_id: 1, user_id: 7 },
        { card_id: 1, user_id: 8 },
      ],
      skipDuplicates: true,
    });
  });
});
