import { PrismaService } from '@trinity/prisma';
import { type AuthUser, type ScopeService } from '@trinity/rbac-nest';
import { buildScopedContactListWhere } from './build-contact-list-where.helper';

/**
 * where-clause dùng chung giữa `GET /contacts` (list) và
 * `GET /contacts/export`. Trọng tâm test: (1) compose qua AND thay vì spread,
 * (2) mọi filter UI trở thành 1 phần tử AND riêng biệt.
 *
 * RBAC quyền + phạm vi: `AuthUser{grants}` + `ScopeService.ownerIds` fake (kiểm soát trực tiếp
 * scope trả về). Owner Contact CỐ ĐỊNH `['assigned_to','created_by_id']` cho MỌI người giữ
 * quyền `contacts.view`.
 */

function makePrisma(userFindManyResult: Array<{ id: number }> = []) {
  return {
    user: {
      findMany: jest.fn().mockResolvedValue(userFindManyResult),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 42 }]),
  } as unknown as PrismaService;
}

function makeScope(ownerIds: number[] | 'all' | null): ScopeService {
  return { ownerIds: jest.fn().mockResolvedValue(ownerIds) } as unknown as ScopeService;
}

function makeUser(userId: number): AuthUser {
  return { userId, email: `u${userId}@t`, isAdmin: false, grants: {} };
}

describe('buildScopedContactListWhere', () => {
  it("scope 'all' không filter: AND = [rbacFilter rỗng, deleted_at:null]", async () => {
    const prisma = makePrisma();
    const scope = makeScope('all');
    const where = await buildScopedContactListWhere(prisma, scope, makeUser(1), {});
    expect(where).toEqual({ AND: [{}, { deleted_at: null }] });
  });

  it('scope [own id]: rbacFilter (OR assigned_to/created_by_id) là phần tử ĐẦU của AND, không bị filter khác ghi đè', async () => {
    const prisma = makePrisma();
    const scope = makeScope([10]);
    const where = await buildScopedContactListWhere(prisma, scope, makeUser(10), { source_id: 3 });
    const and = (where as { AND: Array<Record<string, unknown>> }).AND;
    expect(and[0]).toEqual({
      OR: [
        { assigned_to: { in: [10] } },
        { created_by_id: { in: [10] } },
      ],
    });
    expect(and).toEqual(expect.arrayContaining([{ source_id: 3 }]));
  });

  it('scope null (không có quyền contacts.view) → coi như [] — filter luôn 0 dòng, KHÔNG throw', async () => {
    const prisma = makePrisma();
    const scope = makeScope(null);
    const where = await buildScopedContactListWhere(prisma, scope, makeUser(20), {});
    const and = (where as { AND: Array<Record<string, unknown>> }).AND;
    expect(and[0]).toEqual({
      OR: [
        { assigned_to: { in: [] } },
        { created_by_id: { in: [] } },
      ],
    });
  });

  it('team_lead_id: resolve subtree qua prisma.user.findMany rồi AND-merge assigned_to IN [...]', async () => {
    const prisma = makePrisma([{ id: 101 }, { id: 102 }]);
    const scope = makeScope('all');
    const where = await buildScopedContactListWhere(prisma, scope, makeUser(1), { team_lead_id: 50 });
    const and = (where as { AND: Array<Record<string, unknown>> }).AND;
    expect(and).toEqual(
      expect.arrayContaining([
        { assigned_to: { in: expect.arrayContaining([50, 101, 102]) } },
      ]),
    );
  });

  it('search theo SĐT (chuỗi số ≥6 ký tự) tạo OR clause riêng', async () => {
    const prisma = makePrisma();
    const scope = makeScope('all');
    const where = await buildScopedContactListWhere(prisma, scope, makeUser(1), { search: '0912345' });
    const and = (where as { AND: Array<Record<string, unknown>> }).AND;
    expect(and).toEqual(
      expect.arrayContaining([
        { phone: { contains: '0912345' } },
      ]),
    );
  });

  it('search theo tên: contains gốc HOẶC id khớp bản bỏ dấu (#30)', async () => {
    const where = await buildScopedContactListWhere(makePrisma(), makeScope('all'), makeUser(1), { search: 'minh' });
    expect(JSON.stringify((where as { AND: unknown[] }).AND)).toContain('{"id":{"in":[42]}}');
  });

  it('search SĐT ngắn (<9 số) không khớp cột phone khi người xem chưa có phone_full scope all', async () => {
    const scope = makeScope([1]);
    const short = await buildScopedContactListWhere(makePrisma(), scope, makeUser(1), { search: '0912345' });
    const andShort = (short as { AND: Array<Record<string, unknown>> }).AND;
    expect(JSON.stringify(andShort)).not.toContain('"phone"');
    const full = await buildScopedContactListWhere(makePrisma(), scope, makeUser(1), { search: '0912345678' });
    expect((full as { AND: Array<Record<string, unknown>> }).AND).toEqual(
      expect.arrayContaining([{ phone: { contains: '0912345678' } }]),
    );
  });

  it('created_from/created_to tạo clause created_at riêng, không đụng field khác', async () => {
    const prisma = makePrisma();
    const scope = makeScope('all');
    const where = await buildScopedContactListWhere(prisma, scope, makeUser(1), {
      created_from: '2026-07-01',
      created_to: '2026-08-19',
    });
    const and = (where as { AND: Array<Record<string, unknown>> }).AND;
    const createdAtClause = and.find((c) => 'created_at' in c) as {
      created_at: { gte: Date; lte: Date };
    };
    expect(createdAtClause.created_at.gte).toEqual(new Date('2026-07-01T00:00:00+07:00'));
    expect(createdAtClause.created_at.lte).toEqual(
      new Date('2026-08-19T23:59:59.999+07:00'),
    );
  });

  it('created_to dạng ISO có giờ dùng nguyên văn (không nối thêm hậu tố → không Invalid Date)', async () => {
    const where = await buildScopedContactListWhere(makePrisma(), makeScope('all'), makeUser(1), {
      created_to: '2026-08-19T10:30:00.000Z',
    });
    const and = (where as { AND: Array<Record<string, unknown>> }).AND;
    const clause = and.find((c) => 'created_at' in c) as { created_at: { lte: Date } };
    expect(clause.created_at.lte).toEqual(new Date('2026-08-19T10:30:00.000Z'));
  });

  it(' lead_label lọc theo nhãn; unscored lọc khách chưa chấm; phạm vi vẫn đứng đầu AND', async () => {
    const scope = makeScope([10]);
    const hot = await buildScopedContactListWhere(makePrisma(), scope, makeUser(10), { lead_label: 'hot' });
    const hotAnd = (hot as { AND: Array<Record<string, unknown>> }).AND;
    expect(hotAnd).toContainEqual({ lead_label: 'hot' });
    expect(hotAnd[0]).toHaveProperty('OR');
    const none = await buildScopedContactListWhere(makePrisma(), scope, makeUser(10), { lead_label: 'unscored' });
    expect((none as { AND: Array<Record<string, unknown>> }).AND).toContainEqual({ lead_label: null });
  });
});
