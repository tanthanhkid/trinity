import type { PrismaService } from '@trinity/prisma';
import { findUserIdsWithPermission } from '../permission-roster.helper';

function makePrisma() {
  return {
    role: { findMany: jest.fn() },
    userRole: { findMany: jest.fn() },
  };
}

describe('findUserIdsWithPermission', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('trả rỗng khi không có vai trò nào giữ quyền (kể cả Quản trị)', async () => {
    prisma.role.findMany.mockResolvedValue([]);

    const ids = await findUserIdsWithPermission(
      prisma as unknown as PrismaService,
      'attendance.manage',
    );

    expect(ids).toEqual([]);
    expect(prisma.userRole.findMany).not.toHaveBeenCalled();
  });

  it('gom is_system=true VÀ vai trò có role_permissions khớp quyền — where OR đúng dạng', async () => {
    prisma.role.findMany.mockResolvedValue([{ id: 1 }, { id: 5 }]);
    prisma.userRole.findMany.mockResolvedValue([{ user_id: 10 }, { user_id: 11 }]);

    const ids = await findUserIdsWithPermission(
      prisma as unknown as PrismaService,
      'recruitment.manage',
    );

    expect(ids.sort()).toEqual([10, 11]);
    expect(prisma.role.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { is_system: true },
          { grants: { some: { permission: 'recruitment.manage' } } },
        ],
      },
      select: { id: true },
    });
    expect(prisma.userRole.findMany).toHaveBeenCalledWith({
      where: {
        role_id: { in: [1, 5] },
        user: { status: 'active', deleted_at: null },
      },
      select: { user_id: true },
    });
  });

  it('loại trùng user giữ nhiều vai trò cùng thoả điều kiện', async () => {
    prisma.role.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    prisma.userRole.findMany.mockResolvedValue([
      { user_id: 10 },
      { user_id: 10 },
      { user_id: 20 },
    ]);

    const ids = await findUserIdsWithPermission(
      prisma as unknown as PrismaService,
      'attendance.manage',
    );

    expect(ids.sort()).toEqual([10, 20]);
  });
});
