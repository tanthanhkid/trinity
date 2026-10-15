import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@trinity/prisma';
import { ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { ReportCustomersService } from '../report-customers.service';
import { ReportPeriod } from '../helpers/report-date-range.helper';

const mockPrisma = {
  contact: { count: jest.fn(), groupBy: jest.fn() },
  settingOption: { findMany: jest.fn() },
};

function mkUser(userId = 1): AuthUser {
  return { userId, email: `u${userId}@test.com`, isAdmin: false, grants: {} };
}

function mkScope(owner: number[] | 'all' | null): ScopeService {
  return { ownerIds: jest.fn(async () => owner) } as unknown as ScopeService;
}

// Kỳ 1 ngày để bucket trend chỉ có 1 phần tử (đơn giản hoá assertion số lượng call).
const period: ReportPeriod = {
  dateFrom: new Date('2026-09-20T00:00:00+07:00'),
  dateTo: new Date('2026-09-20T23:59:59.999+07:00'),
};

describe('ReportCustomersService', () => {
  async function buildService(owner: number[] | 'all' | null): Promise<ReportCustomersService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportCustomersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ScopeService, useValue: mkScope(owner) },
      ],
    }).compile();
    return module.get(ReportCustomersService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contact.count.mockResolvedValue(0);
    mockPrisma.contact.groupBy.mockResolvedValue([]);
    mockPrisma.settingOption.findMany.mockResolvedValue([]);
  });

  it('owner mảng: where compose qua AND — OR(assigned_to, created_by_id) + date filter', async () => {
    const service = await buildService([42]);
    await service.getOverview(mkUser(42), period);
    const groupByCall = mockPrisma.contact.groupBy.mock.calls[0][0];
    // where = { AND: [buildContactScopeWhere-result, {created_at}] }
    expect(groupByCall.where.AND[0].OR).toEqual([
      { assigned_to: { in: [42] } },
      { created_by_id: { in: [42] } },
    ]);
    expect(groupByCall.where.AND[0].deleted_at).toBeNull();
    expect(groupByCall.where.AND[1]).toEqual({
      created_at: { gte: period.dateFrom, lte: period.dateTo },
    });
  });

  it('owner "all": KHÔNG thu hẹp — chỉ deleted_at:null', async () => {
    const service = await buildService('all');
    await service.getOverview(mkUser(1), period);
    const groupByCall = mockPrisma.contact.groupBy.mock.calls[0][0];
    expect(groupByCall.where.AND[0]).toEqual({ deleted_at: null });
  });

  it('owner=[] (subtree rỗng) => KHÔNG throw, where lọc theo mảng rỗng (Prisma tự trả 0 dòng)', async () => {
    const service = await buildService([]);
    const result = await service.getOverview(mkUser(8), period);
    const groupByCall = mockPrisma.contact.groupBy.mock.calls[0][0];
    expect(groupByCall.where.AND[0].OR).toEqual([
      { assigned_to: { in: [] } },
      { created_by_id: { in: [] } },
    ]);
    expect(result.by_source).toEqual([]);
  });

  it('by_source resolve label qua settingOption.findMany theo đúng id groupBy trả về', async () => {
    const service = await buildService('all');
    mockPrisma.contact.groupBy.mockImplementation(({ by }: { by: string[] }) => {
      if (by[0] === 'source_id') {
        return Promise.resolve([{ source_id: 5, _count: { _all: 3 } }]);
      }
      return Promise.resolve([]);
    });
    mockPrisma.settingOption.findMany.mockResolvedValue([{ id: 5, label: 'Zalo Ads' }]);
    const result = await service.getOverview(mkUser(1), period);
    expect(result.by_source).toEqual([{ id: 5, label: 'Zalo Ads', count: 3 }]);
  });

  it('by_assignee "Chưa gán" khi assigned_to=null', async () => {
    const service = await buildService('all');
    mockPrisma.contact.groupBy.mockImplementation(({ by }: { by: string[] }) => {
      if (by[0] === 'assigned_to') {
        return Promise.resolve([{ assigned_to: null, _count: { _all: 2 } }]);
      }
      return Promise.resolve([]);
    });
    const result = await service.getOverview(mkUser(1), period);
    expect(result.by_assignee).toEqual([{ id: null, label: 'Chưa gán', count: 2 }]);
  });

  it('trend: 1 bucket cho kỳ 1 ngày → đúng 1 lệnh contact.count phụ trội cho trend', async () => {
    const service = await buildService('all');
    await service.getOverview(mkUser(1), period);
    expect(mockPrisma.contact.count).toHaveBeenCalledTimes(1);
  });
});
