import { Prisma, PrismaService } from '@trinity/prisma';
import { KanbanFieldDefsService } from '../field-defs/kanban-field-defs.service';

function build() {
  const prisma = {
    kanbanBoard: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
    kanbanFieldDef: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ id: 5, type: 'text' }),
      create: jest.fn().mockResolvedValue({ id: 5 }),
      update: jest.fn().mockResolvedValue({ id: 5 }),
    },
  };
  return { prisma, service: new KanbanFieldDefsService(prisma as unknown as PrismaService) };
}

describe('KanbanFieldDefsService — cột Json options', () => {
  it('create: field không có options ghi Prisma.DbNull, không phải null JS', async () => {
    const { prisma, service } = build();
    await service.create(1, { key: 'ghi_chu', label: 'Ghi chú', type: 'text' } as never);
    expect(prisma.kanbanFieldDef.create.mock.calls[0][0].data.options).toBe(Prisma.DbNull);
  });

  it('create: select có options ghi mảng', async () => {
    const { prisma, service } = build();
    const options = [{ value: 'a', label: 'A' }];
    await service.create(1, { key: 'k', label: 'K', type: 'select', options } as never);
    expect(prisma.kanbanFieldDef.create.mock.calls[0][0].data.options).toEqual(options);
  });

  it('update: options null → Prisma.DbNull; không gửi options thì không đụng cột', async () => {
    const { prisma, service } = build();
    await service.update(5, { options: null } as never);
    expect(prisma.kanbanFieldDef.update.mock.calls[0][0].data.options).toBe(Prisma.DbNull);
    await service.update(5, { label: 'X' } as never);
    expect('options' in prisma.kanbanFieldDef.update.mock.calls[1][0].data).toBe(false);
  });
});
