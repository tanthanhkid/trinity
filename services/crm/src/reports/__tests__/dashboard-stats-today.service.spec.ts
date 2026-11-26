import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@trinity/prisma';
import type { Grants } from '@trinity/rbac';
import { ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { DashboardStatsTodayService, CACHE_TTL_SEC } from '../dashboard-stats-today.service';
import { ReadCache } from '../../common/read-cache';

/**
 * RBAC quyền + phạm vi — mỗi khối kiểm quyền NGUỒN riêng
 * (`contacts.view`), độc lập với quyền vào route
 * (`reports.overview`). Khối thiếu quyền trả `null` (KHÔNG `0`).
 */
const mockPrisma = {
  contact: { count: jest.fn() },
};

const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
};

function mkUser(grants: Grants, userId = 1): AuthUser {
  return { userId, email: `u${userId}@test.com`, isAdmin: false, grants };
}

/** owners: map permission → ownerIds kết quả (mirror `ScopeService.ownerIds` thật). */
function mkScope(owners: Record<string, number[] | 'all' | null>): ScopeService {
  return {
    ownerIds: jest.fn(async (_user: AuthUser, perm: string) =>
      Object.prototype.hasOwnProperty.call(owners, perm) ? owners[perm] : null,
    ),
  } as unknown as ScopeService;
}

describe('DashboardStatsTodayService', () => {
  async function buildService(scope: ScopeService): Promise<DashboardStatsTodayService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardStatsTodayService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ScopeService, useValue: scope },
        { provide: ReadCache, useValue: mockCache },
      ],
    }).compile();
    return module.get<DashboardStatsTodayService>(DashboardStatsTodayService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockCache.get.mockReturnValue(undefined);
    mockCache.set.mockReturnValue(undefined);
    mockPrisma.contact.count.mockResolvedValue(0);
  });

  describe('scope own', () => {
    it('scope_label="Của mình", team_size=null', async () => {
      const scope = mkScope({ 'contacts.view': [42], 'reports.overview': [42] });
      const service = await buildService(scope);
      const user = mkUser({ 'reports.overview': 'own', 'contacts.view': 'own' }, 42);
      const result = await service.getStats(user);
      expect(result.scope_label).toBe('Của mình');
      expect(result.team_size).toBeNull();
    });

    it('QUAN TÂM hôm nay — owner=OR(assigned_to, created_by_id), ĐỒNG NHẤT mọi vai trò', async () => {
      const scope = mkScope({ 'contacts.view': [42], 'reports.overview': [42] });
      const service = await buildService(scope);
      const user = mkUser({ 'contacts.view': 'own', 'reports.overview': 'own' }, 42);
      mockPrisma.contact.count.mockResolvedValue(5);

      const result = await service.getStats(user);

      expect(result.interest_total).toBe(5);
      const contactCall = mockPrisma.contact.count.mock.calls[0];
      expect(contactCall[0].where.created_at.gte).toBeInstanceOf(Date);
      expect(contactCall[0].where.OR).toEqual([
        { assigned_to: { in: [42] } },
        { created_by_id: { in: [42] } },
      ]);
    });

  });

  describe('scope team/subtree', () => {
    it('scope_label="Nhóm", team_size = độ dài owner', async () => {
      const scope = mkScope({ 'reports.overview': [10, 20, 30], 'contacts.view': null });
      const service = await buildService(scope);
      const user = mkUser({ 'reports.overview': 'team' }, 10);

      const result = await service.getStats(user);

      expect(result.scope_label).toBe('Nhóm');
      expect(result.team_size).toBe(3);
      expect(result.interest_total).toBeNull();
    });

    it('scope_label="Toàn bộ cấp dưới" cho subtree', async () => {
      const scope = mkScope({ 'reports.overview': [5, 6, 7, 8] });
      const service = await buildService(scope);
      const user = mkUser({ 'reports.overview': 'subtree' }, 5);

      const result = await service.getStats(user);

      expect(result.scope_label).toBe('Toàn bộ cấp dưới');
      expect(result.team_size).toBe(4);
    });
  });

  describe('scope all', () => {
    it('QUAN TÂM hôm nay dùng contact.count KHÔNG lọc owner', async () => {
      const scope = mkScope({ 'contacts.view': 'all', 'reports.overview': 'all' });
      const service = await buildService(scope);
      const user = mkUser({ 'contacts.view': 'all', 'reports.overview': 'all' }, 1);
      mockPrisma.contact.count.mockResolvedValue(250);

      const result = await service.getStats(user);

      expect(result.scope_label).toBe('Toàn công ty');
      expect(result.team_size).toBeNull();
      expect(result.interest_total).toBe(250);
      const where = mockPrisma.contact.count.mock.calls[0][0].where;
      expect(where.OR).toBeUndefined();
    });

  });

  describe('thiếu quyền nguồn — khối trả null, KHÔNG phải 0', () => {
    it('không có contacts.view => interest_* = null, KHÔNG query contact', async () => {
      const scope = mkScope({ 'contacts.view': null, 'reports.overview': [1] });
      const service = await buildService(scope);
      const user = mkUser({ 'reports.overview': 'own' }, 1);

      const result = await service.getStats(user);

      expect(result.interest_total).toBeNull();
      expect(result.interest_yesterday).toBeNull();
      expect(mockPrisma.contact.count).not.toHaveBeenCalled();
    });
  });

  describe('ReadCache thật + TRINITY_DISABLE_READ_CACHE', () => {
    async function build(scope: ScopeService) {
      const module: TestingModule = await Test.createTestingModule({
        providers: [DashboardStatsTodayService, ReadCache, { provide: PrismaService, useValue: mockPrisma }, { provide: ScopeService, useValue: scope }],
      }).compile();
      return module.get(DashboardStatsTodayService);
    }
    const OLD = process.env.TRINITY_DISABLE_READ_CACHE;
    afterEach(() => {
      if (OLD === undefined) delete process.env.TRINITY_DISABLE_READ_CACHE;
      else process.env.TRINITY_DISABLE_READ_CACHE = OLD;
    });

    it('mặc định: lần gọi thứ hai lấy từ cache, không đọc DB', async () => {
      delete process.env.TRINITY_DISABLE_READ_CACHE;
      const service = await build(mkScope({ 'contacts.view': [1], 'reports.overview': [1] }));
      const user = mkUser({ 'contacts.view': 'own', 'reports.overview': 'own' }, 1);
      await service.getStats(user);
      const first = mockPrisma.contact.count.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      await service.getStats(user);
      expect(mockPrisma.contact.count.mock.calls.length).toBe(first);
    });

    it('bật cờ: hai lần gọi liên tiếp đều đọc DB', async () => {
      process.env.TRINITY_DISABLE_READ_CACHE = '1';
      const service = await build(mkScope({ 'contacts.view': [1], 'reports.overview': [1] }));
      const user = mkUser({ 'contacts.view': 'own', 'reports.overview': 'own' }, 1);
      await service.getStats(user);
      const first = mockPrisma.contact.count.mock.calls.length;
      await service.getStats(user);
      expect(mockPrisma.contact.count.mock.calls.length).toBe(2 * first);
    });
  });

  describe('edge cases', () => {
    it('cache hit: không gọi prisma', async () => {
      const scope = mkScope({ 'contacts.view': [1], 'reports.overview': [1] });
      const service = await buildService(scope);
      const user = mkUser({ 'contacts.view': 'own', 'reports.overview': 'own' }, 1);
      const cachedData = {
        interest_total: 8,
        team_size: null,
        scope_label: 'Của mình',
      };
      mockCache.get.mockReturnValue(JSON.stringify(cachedData));

      const result = await service.getStats(user);

      expect(result.interest_total).toBe(8);
      expect(mockPrisma.contact.count).not.toHaveBeenCalled();
    });

    it('CACHE_VERSION v22 + CACHE_TTL_SEC=15', async () => {
      const scope = mkScope({ 'contacts.view': [1], 'reports.overview': [1] });
      const service = await buildService(scope);
      const user = mkUser({ 'contacts.view': 'own', 'reports.overview': 'own' }, 1);
      await service.getStats(user);

      expect(mockCache.set).toHaveBeenCalledWith(
        expect.stringContaining('v22'),
        expect.any(String),
        CACHE_TTL_SEC,
      );
      expect(CACHE_TTL_SEC).toBe(15);
    });
  });
});
