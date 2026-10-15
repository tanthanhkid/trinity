import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@trinity/prisma';
import { ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { ReportCustomersUncontactedService } from '../report-customers-uncontacted.service';

const mockPrisma = {
  contact: { findMany: jest.fn() },
};

function mkUser(userId = 1): AuthUser {
  return { userId, email: `u${userId}@test.com`, isAdmin: false, grants: {} };
}

function mkScope(owners: Record<string, number[] | 'all' | null>): ScopeService {
  return {
    ownerIds: jest.fn(async (_user: AuthUser, perm: string) =>
      Object.prototype.hasOwnProperty.call(owners, perm) ? owners[perm] : null,
    ),
  } as unknown as ScopeService;
}

describe('ReportCustomersUncontactedService', () => {
  async function buildService(
    owners: Record<string, number[] | 'all' | null>,
  ): Promise<ReportCustomersUncontactedService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportCustomersUncontactedService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ScopeService, useValue: mkScope(owners) },
      ],
    }).compile();
    return module.get(ReportCustomersUncontactedService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contact.findMany.mockResolvedValue([]);
  });

  it('mặc định days=7, limit=20, cursor id desc', async () => {
    const service = await buildService({ 'reports.customers': 'all', 'contacts.phone_full': 'all' });
    await service.getUncontacted(mkUser(1), {});
    const call = mockPrisma.contact.findMany.mock.calls[0][0];
    expect(call.take).toBe(20);
    expect(call.orderBy).toEqual({ id: 'desc' });
    expect(call.cursor).toBeUndefined();
    expect(call.where.AND[1]).toEqual({
      activities: { none: { created_at: { gte: expect.any(Date) } } },
    });
  });

  it('owner mảng: where.AND[0] = OR(assigned_to, created_by_id)', async () => {
    const service = await buildService({ 'reports.customers': [55], 'contacts.phone_full': [] });
    await service.getUncontacted(mkUser(55), {});
    const call = mockPrisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND[0].OR).toEqual([
      { assigned_to: { in: [55] } },
      { created_by_id: { in: [55] } },
    ]);
  });

  it('KHÔNG có contacts.phone_full trên owner của contact => SĐT bị che', async () => {
    const service = await buildService({ 'reports.customers': 'all', 'contacts.phone_full': [] });
    mockPrisma.contact.findMany.mockResolvedValueOnce([
      {
        id: 5,
        full_name: 'Y',
        phone: '0911111111',
        assigned_to: 55,
        created_by_id: null,
        created_at: new Date(),
        assigned_user: { full_name: 'Sale A' },
      },
    ]);
    const result = await service.getUncontacted(mkUser(1), {});
    expect(result.rows[0].phone).toBe('***111');
  });

  it('CÓ contacts.phone_full phủ owner của contact => SĐT đầy đủ', async () => {
    const service = await buildService({ 'reports.customers': 'all', 'contacts.phone_full': [55] });
    mockPrisma.contact.findMany.mockResolvedValueOnce([
      {
        id: 5,
        full_name: 'Y',
        phone: '0911111111',
        assigned_to: 55,
        created_by_id: null,
        created_at: new Date(),
        assigned_user: { full_name: 'Sale A' },
      },
    ]);
    const result = await service.getUncontacted(mkUser(1), {});
    expect(result.rows[0].phone).toBe('0911111111');
    expect(result.rows[0].assigned_to).toBe(55);
    expect(result.rows[0].assignee_name).toBe('Sale A');
  });

  it('limit vượt trần MAX_LIMIT=100 bị kẹp lại', async () => {
    const service = await buildService({ 'reports.customers': 'all', 'contacts.phone_full': 'all' });
    await service.getUncontacted(mkUser(1), { limit: 500 });
    const call = mockPrisma.contact.findMany.mock.calls[0][0];
    expect(call.take).toBe(100);
  });

  it('cursor truyền vào → skip:1 + cursor:{id}', async () => {
    const service = await buildService({ 'reports.customers': 'all', 'contacts.phone_full': 'all' });
    await service.getUncontacted(mkUser(1), { cursor: 999 });
    const call = mockPrisma.contact.findMany.mock.calls[0][0];
    expect(call.skip).toBe(1);
    expect(call.cursor).toEqual({ id: 999 });
  });

  it('next_cursor = id dòng cuối khi đủ 1 trang, null khi thiếu trang (còn ít hơn limit)', async () => {
    const service = await buildService({ 'reports.customers': 'all', 'contacts.phone_full': 'all' });
    mockPrisma.contact.findMany.mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, i) => ({
        id: 100 - i,
        full_name: 'X',
        phone: '0900000000',
        assigned_to: null,
        created_by_id: null,
        created_at: new Date(),
        assigned_user: null,
      })),
    );
    const full = await service.getUncontacted(mkUser(1), {});
    expect(full.next_cursor).toBe(81);

    mockPrisma.contact.findMany.mockResolvedValueOnce([
      {
        id: 5,
        full_name: 'Y',
        phone: '0911111111',
        assigned_to: null,
        created_by_id: null,
        created_at: new Date(),
        assigned_user: null,
      },
    ]);
    const partial = await service.getUncontacted(mkUser(1), {});
    expect(partial.next_cursor).toBeNull();
  });

  it('owner=[] (subtree rỗng) => KHÔNG throw, where lọc theo mảng rỗng', async () => {
    const service = await buildService({ 'reports.customers': [], 'contacts.phone_full': [] });
    const result = await service.getUncontacted(mkUser(8), {});
    const call = mockPrisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND[0].OR).toEqual([
      { assigned_to: { in: [] } },
      { created_by_id: { in: [] } },
    ]);
    expect(result.rows).toEqual([]);
  });
});
