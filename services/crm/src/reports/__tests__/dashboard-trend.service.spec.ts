/**
 * `dashboard-trend.service.ts` — báo cáo có scope RBAC cho đường xu hướng 14
 * ngày của thẻ Tổng quan.
 *
 * Hai bất biến, theo đúng thứ tự rủi ro:
 *
 *  1. **Chuỗi kiểm quyền NGUỒN riêng** (`contacts.view` cho `interest`) —
 *     thiếu quyền thì chuỗi VẮNG MẶT khỏi `series` (key không tồn tại),
 *     KHÔNG phải mảng toàn 0.
 *  2. **Cửa sổ 14 ngày theo giờ VN**, không trôi theo TZ máy chạy.
 *
 * Cách soi SQL: `$queryRaw` là tagged template, mock nhận `(strings, ...values)`
 * và các mảnh `Prisma.sql`/`Prisma.join` lồng bên trong lại là object có
 * `.strings`/`.values` — nên phải DỰNG LẠI ĐỆ QUY mới đọc được câu SQL thật.
 */
import { ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { DashboardTrendService } from '../dashboard-trend.service';

interface SqlLike {
  strings: readonly string[];
  values: unknown[];
}
const isSqlLike = (v: unknown): v is SqlLike =>
  !!v && typeof v === 'object' && 'strings' in v && 'values' in v;

/** Dựng lại câu SQL (kèm giá trị phẳng) từ tagged template + mảnh lồng nhau. */
function renderSql(
  strings: readonly string[],
  values: unknown[],
): { sql: string; values: unknown[] } {
  let sql = '';
  const flat: unknown[] = [];
  for (let i = 0; i < strings.length; i += 1) {
    sql += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (isSqlLike(v)) {
        const inner = renderSql(v.strings, v.values);
        sql += inner.sql;
        flat.push(...inner.values);
      } else {
        sql += ` ?${flat.length} `;
        flat.push(v);
      }
    }
  }
  return { sql, values: flat };
}

function makeService(owners: Record<string, number[] | 'all' | null>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const prisma = {
    $queryRaw: jest.fn((strings: readonly string[], ...values: unknown[]) => {
      calls.push(renderSql(strings, values));
      return Promise.resolve([]);
    }),
  };
  const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };
  const scope = {
    ownerIds: jest.fn(async (_user: AuthUser, perm: string) =>
      Object.prototype.hasOwnProperty.call(owners, perm) ? owners[perm] : null,
    ),
  } as unknown as ScopeService;
  const service = new DashboardTrendService(prisma as never, scope, redis as never);
  return { service, calls, prisma, redis, scope };
}

const mkUser = (userId = 7): AuthUser => ({
  userId,
  email: `u${userId}@x.vn`,
  isAdmin: false,
  grants: {},
});

/** Gộp mọi câu SQL đã chạy thành 1 khối để tìm vị từ. */
const allSql = (calls: Array<{ sql: string }>) => calls.map((c) => c.sql).join('\n---\n');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('chuỗi kiểm quyền nguồn riêng', () => {
  it('có contacts.view => chuỗi interest 14 số', async () => {
    const { service } = makeService({ 'contacts.view': [7] });
    const res = await service.getTrend(mkUser());
    expect(Array.isArray(res.series.interest)).toBe(true);
    expect(res.series.interest).toHaveLength(14);
  });

  it('KHÔNG có contacts.view => interest VẮNG MẶT, KHÔNG query contacts', async () => {
    const { service, calls } = makeService({ 'contacts.view': null });
    const res = await service.getTrend(mkUser());
    expect(res.series.interest).toBeUndefined();
    expect(calls.some((c) => /FROM contacts/.test(c.sql))).toBe(false);
  });
});

describe('vị từ scope theo owner', () => {
  it('owner mảng: interest lọc OR(assigned_to, created_by_id) — ĐỒNG NHẤT mọi vai trò', async () => {
    const { service, calls } = makeService({ 'contacts.view': [7, 8] });
    await service.getTrend(mkUser());
    const contactSql = calls.map((c) => c.sql).filter((q) => /FROM contacts ct/.test(q));
    expect(contactSql).toHaveLength(1);
    expect(contactSql[0]).toMatch(/ct\.assigned_to IN/);
    expect(contactSql[0]).toMatch(/ct\.created_by_id IN/);
  });

  it('owner "all" => KHÔNG có vị từ assigned_to nào', async () => {
    const { service, calls } = makeService({ 'contacts.view': 'all' });
    await service.getTrend(mkUser());
    expect(allSql(calls)).not.toMatch(/assigned_to IN/);
  });

  it('owner RỖNG (subtree không có ai) => KHÔNG query gì, chuỗi vẫn có mặt nhưng toàn 0', async () => {
    const { service, calls, prisma } = makeService({ 'contacts.view': [] });
    const res = await service.getTrend(mkUser());
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(res.series.interest).toEqual(new Array(14).fill(0));
  });
});

describe('cửa sổ 14 ngày theo giờ VN', () => {
  afterEach(() => jest.useRealTimers());

  it.each([
    ['23:30 giờ VN (16:30 UTC cùng ngày)', '2026-09-17T16:30:00Z'],
    ['00:30 giờ VN hôm sau (17:30 UTC hôm trước)', '2026-09-16T17:30:00Z'],
  ])('%s → vẫn ra đúng 14 ngày liên tiếp, kết ở 2026-09-17', async (_label, iso) => {
    jest.useFakeTimers().setSystemTime(new Date(iso));
    const { service } = makeService({ 'contacts.view': 'all' });
    const res = await service.getTrend(mkUser());

    expect(res.days).toHaveLength(14);
    expect(res.days[13]).toBe('2026-09-17');
    expect(res.days[0]).toBe('2026-09-04');
    for (let i = 1; i < res.days.length; i += 1) {
      const prev = new Date(`${res.days[i - 1]}T00:00:00Z`).getTime();
      const cur = new Date(`${res.days[i]}T00:00:00Z`).getTime();
      expect(cur - prev).toBe(24 * 60 * 60 * 1000);
    }
  });
});

describe('cache', () => {
  it('khoá cache SẮP XẾP id — cùng subtree khác thứ tự phải ra CÙNG khoá', async () => {
    const first = makeService({ 'contacts.view': [9, 3, 5] });
    await first.service.getTrend(mkUser(1));
    const k1 = (first.redis.get as jest.Mock).mock.calls[0][0];

    const second = makeService({ 'contacts.view': [3, 5, 9] });
    await second.service.getTrend(mkUser(1));
    const k2 = (second.redis.get as jest.Mock).mock.calls[0][0];

    expect(k1).toBe(k2);
  });

  it('khoá cache dùng chung ("shared") khi owner là all/none — độc lập danh tính người gọi', async () => {
    const a = makeService({ 'contacts.view': 'all' });
    await a.service.getTrend(mkUser(1));
    const kUser1 = (a.redis.get as jest.Mock).mock.calls[0][0];

    const b = makeService({ 'contacts.view': 'all' });
    await b.service.getTrend(mkUser(999));
    const kUser999 = (b.redis.get as jest.Mock).mock.calls[0][0];

    expect(kUser1).toBe(kUser999);
  });

  it('khoá cache mang userId khi có owner theo cây (khác người, khác phạm vi)', async () => {
    const a = makeService({ 'contacts.view': [1, 2] });
    await a.service.getTrend(mkUser(1));
    const k1 = (a.redis.get as jest.Mock).mock.calls[0][0];

    const b = makeService({ 'contacts.view': [1, 2] });
    await b.service.getTrend(mkUser(999));
    const k999 = (b.redis.get as jest.Mock).mock.calls[0][0];

    expect(k1).not.toBe(k999);
  });
});
