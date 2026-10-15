import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@trinity/prisma';
import type { Grants } from '@trinity/rbac';
import { ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { ReportOverviewService } from '../report-overview.service';
import { ReportPeriod } from '../helpers/report-date-range.helper';

const mockPrisma = {
  contact: { count: jest.fn() },
  activity: { count: jest.fn() },
};

function mkUser(grants: Grants, userId = 1): AuthUser {
  return { userId, email: `u${userId}@test.com`, isAdmin: false, grants };
}

function mkScope(owner: number[] | 'all'): ScopeService {
  return { ownerIds: jest.fn(async () => owner) } as unknown as ScopeService;
}

const period: ReportPeriod = {
  dateFrom: new Date('2026-09-01T00:00:00+07:00'),
  dateTo: new Date('2026-09-07T23:59:59.999+07:00'),
};

describe('ReportOverviewService', () => {
  async function buildService(owner: number[] | 'all'): Promise<ReportOverviewService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportOverviewService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ScopeService, useValue: mkScope(owner) },
      ],
    }).compile();
    return module.get(ReportOverviewService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contact.count.mockResolvedValue(0);
    mockPrisma.activity.count.mockResolvedValue(0);
  });

  it('scope own [42]: where.OR = OR(assigned_to, created_by_id) — ĐỒNG NHẤT mọi vai trò', async () => {
    const service = await buildService([42]);
    await service.getOverview(mkUser({ 'reports.overview': 'own' }, 42), period);
    const contactCall = mockPrisma.contact.count.mock.calls[0][0];
    expect(contactCall.where.OR).toEqual([
      { assigned_to: { in: [42] } },
      { created_by_id: { in: [42] } },
    ]);
  });

  it('scope team/subtree: where.assigned_to/created_by_id chứa owner từ ScopeService', async () => {
    const service = await buildService([5, 10, 11]);
    await service.getOverview(mkUser({ 'reports.overview': 'team' }, 5), period);
    const contactCall = mockPrisma.contact.count.mock.calls[0][0];
    expect(contactCall.where.OR).toEqual([
      { assigned_to: { in: [5, 10, 11] } },
      { created_by_id: { in: [5, 10, 11] } },
    ]);
  });

  it('scope all: KHÔNG filter theo assigned_to (unbounded)', async () => {
    const service = await buildService('all');
    await service.getOverview(mkUser({ 'reports.overview': 'all' }, 1), period);
    const contactCall = mockPrisma.contact.count.mock.calls[0][0];
    expect(contactCall.where.assigned_to).toBeUndefined();
    expect(contactCall.where.OR).toBeUndefined();
  });

  it('owner rỗng ([]) => trả kết quả rỗng, KHÔNG query DB thêm', async () => {
    const service = await buildService([]);
    const result = await service.getOverview(mkUser({ 'reports.overview': 'team' }, 5), period);
    expect(result.new_customers.current).toBe(0);
    expect(mockPrisma.contact.count).not.toHaveBeenCalled();
  });

  it('scope_label suy từ scope quyền reports.overview (KHÔNG theo tên vai trò)', async () => {
    const service = await buildService([1, 2]);
    const result = await service.getOverview(mkUser({ 'reports.overview': 'subtree' }, 1), period);
    expect(result.scope_label).toBe('Toàn bộ cấp dưới');
  });

  it('tính delta_pct = null khi kỳ trước = 0', async () => {
    const service = await buildService('all');
    mockPrisma.contact.count.mockResolvedValueOnce(5).mockResolvedValueOnce(0);
    const result = await service.getOverview(mkUser({ 'reports.overview': 'all' }, 1), period);
    expect(result.new_customers).toEqual({ current: 5, previous: 0, delta_abs: 5, delta_pct: null });
  });
});
