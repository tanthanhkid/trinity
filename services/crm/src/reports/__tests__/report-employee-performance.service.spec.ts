import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@trinity/prisma';
import { ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { ReportEmployeePerformanceService } from '../report-employee-performance.service';
import { ReportPeriod } from '../helpers/report-date-range.helper';

const mockPrisma = {
  contact: { groupBy: jest.fn() },
  activity: { groupBy: jest.fn() },
  user: { findMany: jest.fn() },
};

function mkUser(userId = 1): AuthUser {
  return { userId, email: `u${userId}@test.com`, isAdmin: false, grants: {} };
}

function mkScope(owner: number[] | 'all'): ScopeService {
  return { ownerIds: jest.fn(async () => owner) } as unknown as ScopeService;
}

const period: ReportPeriod = {
  dateFrom: new Date('2026-09-01T00:00:00+07:00'),
  dateTo: new Date('2026-09-07T23:59:59.999+07:00'),
};

describe('ReportEmployeePerformanceService', () => {
  async function buildService(owner: number[] | 'all'): Promise<ReportEmployeePerformanceService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportEmployeePerformanceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ScopeService, useValue: mkScope(owner) },
      ],
    }).compile();
    return module.get(ReportEmployeePerformanceService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contact.groupBy.mockResolvedValue([]);
    mockPrisma.activity.groupBy.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
  });

  it('owner mảng (subtree): where.assigned_to/created_by giới hạn đúng owner', async () => {
    const service = await buildService([9, 20, 21]);
    await service.getPerformance(mkUser(9), period);
    const contactCall = mockPrisma.contact.groupBy.mock.calls[0][0];
    const activityCall = mockPrisma.activity.groupBy.mock.calls[0][0];
    const byNum = (a: number, b: number) => a - b;
    expect([...contactCall.where.OR[0].assigned_to.in].sort(byNum)).toEqual([9, 20, 21]);
    // Dòng bảng xếp hạng (nhóm theo assigned_to) không được lộ người ngoài phạm vi.
    expect([...contactCall.where.assigned_to.in].sort(byNum)).toEqual([9, 20, 21]);
    expect([...activityCall.where.created_by.in].sort(byNum)).toEqual([9, 20, 21]);
  });

  it('owner rỗng ([]) → trả mảng rỗng, KHÔNG query group-by nào', async () => {
    const service = await buildService([]);
    const result = await service.getPerformance(mkUser(1), period);
    expect(result).toEqual([]);
    expect(mockPrisma.contact.groupBy).not.toHaveBeenCalled();
  });

  it('owner "all": KHÔNG filter assigned_to', async () => {
    const service = await buildService('all');
    await service.getPerformance(mkUser(1), period);
    const contactCall = mockPrisma.contact.groupBy.mock.calls[0][0];
    expect(contactCall.where.OR).toBeUndefined();
  });

  it('merge đúng theo user id — nhân viên chỉ có hoạt động vẫn xuất hiện', async () => {
    const service = await buildService('all');
    mockPrisma.activity.groupBy.mockResolvedValueOnce([{ created_by: 77, _count: { _all: 4 } }]);
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 77, full_name: 'Nguyễn Văn A', email: 'a@test.com' },
    ]);
    const result = await service.getPerformance(mkUser(1), period);
    expect(result).toEqual([
      {
        user_id: 77,
        full_name: 'Nguyễn Văn A',
        email: 'a@test.com',
        new_customers: 0,
        activities_count: 4,
      },
    ]);
  });
});
