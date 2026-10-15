import { BadRequestException, ConflictException } from '@nestjs/common';
import { SocialRecurrenceService, nextOccurrence, nextWithin, normalizeRule, type RecurrenceRule } from '../social-recurrence.service';

const vn = (iso: string) => new Date(`${iso}+07:00`);
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const at = (s: string) => iso(vn(s));

describe('nextOccurrence (giờ Việt Nam)', () => {
  const daily: RecurrenceRule = { freq: 'daily', interval: 1, time: '09:00' };
  it('hằng ngày: hôm nay nếu chưa tới giờ, mai nếu đã qua', () => {
    expect(iso(nextOccurrence(daily, vn('2026-10-20T08:00:00'), '2026-10-01'))).toBe(at('2026-10-20T09:00:00'));
    expect(iso(nextOccurrence(daily, vn('2026-10-20T09:00:00'), '2026-10-01'))).toBe(at('2026-10-21T09:00:00'));
  });
  it('mỗi 3 ngày tính từ ngày bắt đầu', () => {
    const r = { ...daily, interval: 3 };
    expect(iso(nextOccurrence(r, vn('2026-10-02T10:00:00'), '2026-10-01'))).toBe(at('2026-10-04T09:00:00'));
  });
  it('không có lần nào trước ngày bắt đầu', () => {
    expect(iso(nextOccurrence(daily, vn('2026-09-01T00:00:00'), '2026-10-05'))).toBe(at('2026-10-05T09:00:00'));
  });
  it('00:30 giờ VN là 17:30 UTC hôm trước', () => {
    expect(iso(nextOccurrence({ ...daily, time: '00:30' }, vn('2026-10-20T00:00:00'), '2026-10-01'))).toBe('2026-10-19T17:30:00.000Z');
  });
  it('hằng tuần nhiều thứ: T2 + T5', () => {
    const r: RecurrenceRule = { freq: 'weekly', interval: 1, weekdays: [1, 4], time: '19:30' };
    // 2026-10-20 là Thứ Ba
    expect(iso(nextOccurrence(r, vn('2026-10-20T08:00:00'), '2026-10-01'))).toBe(at('2026-10-22T19:30:00'));
    expect(iso(nextOccurrence(r, vn('2026-10-22T20:00:00'), '2026-10-01'))).toBe(at('2026-10-26T19:30:00'));
  });
  it('mỗi 2 tuần: bỏ tuần xen kẽ (tuần tính từ Thứ Hai)', () => {
    const r: RecurrenceRule = { freq: 'weekly', interval: 2, weekdays: [2], time: '09:00' };
    // bắt đầu Thứ Ba 2026-10-20 → 11-03 → 11-17
    expect(iso(nextOccurrence(r, vn('2026-10-20T10:00:00'), '2026-10-20'))).toBe(at('2026-11-03T09:00:00'));
  });
  it('weekly không có weekdays = đúng thứ của ngày bắt đầu', () => {
    expect(iso(nextOccurrence({ freq: 'weekly', interval: 1, time: '09:00' }, vn('2026-10-21T00:00:00'), '2026-10-20'))).toBe(at('2026-10-27T09:00:00'));
  });
  it('hằng tháng: ngày 31 kẹp về ngày cuối tháng ngắn', () => {
    const r: RecurrenceRule = { freq: 'monthly', interval: 1, month_day: 31, time: '08:00' };
    expect(iso(nextOccurrence(r, vn('2026-01-31T09:00:00'), '2026-01-01'))).toBe(at('2026-02-28T08:00:00'));
    expect(iso(nextOccurrence(r, vn('2028-02-01T00:00:00'), '2026-01-01'))).toBe(at('2028-02-29T08:00:00'));
    expect(iso(nextOccurrence(r, vn('2026-04-30T09:00:00'), '2026-01-01'))).toBe(at('2026-05-31T08:00:00'));
  });
  it('mỗi 2 tháng, ngày 15', () => {
    const r: RecurrenceRule = { freq: 'monthly', interval: 2, month_day: 15, time: '08:00' };
    expect(iso(nextOccurrence(r, vn('2026-10-16T00:00:00'), '2026-10-01'))).toBe(at('2026-12-15T08:00:00'));
  });
  it('nextWithin dừng sau ends_on', () => {
    expect(iso(nextWithin(daily, vn('2026-10-20T10:00:00'), '2026-10-01', '2026-10-20'))).toBeNull();
    expect(iso(nextWithin(daily, vn('2026-10-20T08:00:00'), '2026-10-01', '2026-10-20'))).toBe(at('2026-10-20T09:00:00'));
  });
});

describe('normalizeRule', () => {
  it('chuẩn hoá thứ (bỏ trùng, sắp xếp)', () => {
    expect(normalizeRule({ freq: 'weekly', interval: 2, weekdays: [4, 1, 4], time: '09:00' })).toEqual({ freq: 'weekly', interval: 2, weekdays: [1, 4], time: '09:00' });
  });
  it.each([
    [{ freq: 'yearly', time: '09:00' }],
    [{ freq: 'daily', interval: 13, time: '09:00' }],
    [{ freq: 'daily', interval: 0, time: '09:00' }],
    [{ freq: 'daily', time: '9:00' }],
    [{ freq: 'daily', time: '24:00' }],
    [{ freq: 'weekly', weekdays: [7], time: '09:00' }],
    [{ freq: 'monthly', month_day: 32, time: '09:00' }],
  ])('từ chối %j', (r) => {
    expect(() => normalizeRule(r)).toThrow(BadRequestException);
  });
});

// ---- materialize với DB giả ----
const NOW = vn('2026-10-20T08:00:00').getTime();
const rule: RecurrenceRule = { freq: 'daily', interval: 1, time: '09:00' };
const tpl = { content: 'Xin chào', media_keys: [], targets: [{ account_id: 1 }] };

function setup(over: Record<string, unknown> = {}, pending: { id: number; source: string } | null = null) {
  const row: Record<string, any> = {
    id: 7, title: 't', template: tpl, rule, starts_on: new Date('2026-10-01T00:00:00Z'), ends_on: null, max_count: null, count: 0,
    next_run_at: vn('2026-10-20T09:00:00'), active: true, last_error: null, created_by: 5, ...over,
  };
  const match = (w: any) => (w.id === undefined || w.id === row.id) && (w.next_run_at === undefined || w.next_run_at?.getTime?.() === row.next_run_at?.getTime?.());
  const prisma = {
    socialRecurrence: {
      findMany: jest.fn(async () => (row.active && row.next_run_at ? [{ ...row }] : [])),
      findUnique: jest.fn(async () => ({ ...row })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!match(where)) return { count: 0 };
        for (const [k, v] of Object.entries<any>(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v;
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
    },
    socialPost: { findFirst: jest.fn(async () => pending) },
    $executeRaw: jest.fn(async () => 1),
  };
  // Giống create thật: chạy inTx trong "transaction"; tx.$queryRaw trả dòng lịch nếu còn bật + đúng giờ chạy.
  const tx = { $queryRaw: jest.fn(async (_s: unknown, ...vals: any[]) => (row.active && row.next_run_at?.getTime() === vals[1]?.getTime?.() ? [{ id: row.id }] : [])) };
  const posts = {
    create: jest.fn(async (_u: unknown, _i: unknown, opts: any = {}) => {
      if (opts.inTx) await opts.inTx(tx, 100);
      return { id: 100 };
    }),
    cancel: jest.fn(),
    validate: jest.fn(),
  };
  const svc = new SocialRecurrenceService(prisma as never, posts as never);
  return { svc, row, prisma, posts, tx };
}

describe('SocialRecurrenceService.materialize', () => {
  it('tạo bài đúng giờ + khoá chống lặp, tăng count, dời next_run_at', async () => {
    const { svc, row, posts } = setup();
    expect(await svc.materialize(NOW)).toEqual({ created: 1, skipped: 0, paused: 0 });
    const [user, input, opts] = posts.create.mock.calls[0] as any[];
    expect(user.userId).toBe(5);
    expect(input).toMatchObject({ content: 'Xin chào', scheduled_at: at('2026-10-20T09:00:00') });
    expect(opts.dedupeSource).toBe(`recur:7:${at('2026-10-20T09:00:00')}`);
    expect(row.count).toBe(1);
    expect(iso(row.next_run_at)).toBe(at('2026-10-21T09:00:00'));
  });

  it('đã có bài hẹn sắp tới ⇒ không tạo thêm', async () => {
    const { svc, row, posts } = setup({}, { id: 1, source: `recur:7:${at('2026-10-19T09:00:00')}` });
    expect(await svc.materialize(NOW)).toMatchObject({ created: 0, skipped: 1 });
    expect(posts.create).not.toHaveBeenCalled();
    expect(row.count).toBe(0);
  });

  it('bài chờ chính là bài của next_run_at (lần trước chưa kịp dời) ⇒ chỉ dời nốt', async () => {
    const { svc, row, posts } = setup({}, { id: 1, source: `recur:7:${at('2026-10-20T09:00:00')}` });
    await svc.materialize(NOW);
    expect(posts.create).not.toHaveBeenCalled();
    expect(row.count).toBe(1);
    expect(iso(row.next_run_at)).toBe(at('2026-10-21T09:00:00'));
  });

  it('idempotent: chạy hai lượt liền chỉ tạo một bài khi bài chờ đã có (mô phỏng)', async () => {
    const { svc, posts, prisma } = setup();
    await svc.materialize(NOW);
    (prisma.socialPost.findFirst as jest.Mock).mockResolvedValue({ id: 100, source: `recur:7:${at('2026-10-20T09:00:00')}` });
    await svc.materialize(NOW);
    expect(posts.create).toHaveBeenCalledTimes(1);
  });

  it('khoá chống lặp đã tồn tại (409) ⇒ không lỗi, vẫn dời và đếm một lần', async () => {
    const { svc, row, posts } = setup();
    posts.create.mockRejectedValueOnce(new ConflictException('đã có'));
    expect(await svc.materialize(NOW)).toMatchObject({ created: 0, skipped: 1, paused: 0 });
    expect(row.count).toBe(1);
    expect(iso(row.next_run_at)).toBe(at('2026-10-21T09:00:00'));
  });

  it('dời có điều kiện: tick khác đã dời trước ⇒ không đếm hai lần', async () => {
    const { svc, row, prisma } = setup();
    prisma.socialRecurrence.updateMany.mockImplementationOnce(async () => {
      row.next_run_at = vn('2026-10-21T09:00:00'); // tick khác dời trước
      row.count = 1;
      return { count: 0 };
    });
    await svc.materialize(NOW);
    expect(row.count).toBe(1);
  });

  it('trễ quá 1 giờ ⇒ nhảy tới lần kế tiếp ở tương lai, không đăng muộn', async () => {
    const { svc, row, posts } = setup({ next_run_at: vn('2026-10-15T09:00:00') });
    await svc.materialize(NOW);
    expect((posts.create.mock.calls[0] as any[])[2]).toMatchObject({ dedupeSource: `recur:7:${at('2026-10-20T09:00:00')}`, inTx: expect.any(Function) });
    expect(row.count).toBe(1);
    expect(iso(row.next_run_at)).toBe(at('2026-10-21T09:00:00'));
  });

  it('trễ dưới 1 giờ ⇒ vẫn đăng (hẹn vài phút tới)', async () => {
    const late = vn('2026-10-20T07:30:00');
    const { svc, posts } = setup({ next_run_at: late });
    await svc.materialize(NOW);
    const input = (posts.create.mock.calls[0] as any[])[1];
    expect(new Date(input.scheduled_at).getTime()).toBe(NOW + 2 * 60_000);
  });

  it('lỗi kiểm tra (kênh gỡ liên kết) ⇒ ghi last_error, tạm dừng, không lặp', async () => {
    const { svc, row, posts } = setup();
    posts.create.mockRejectedValueOnce(new BadRequestException('Kênh "A" cần liên kết lại trước khi đăng.'));
    expect(await svc.materialize(NOW)).toMatchObject({ paused: 1, created: 0 });
    expect(row.active).toBe(false);
    expect(row.last_error).toContain('liên kết lại');
    expect(row.count).toBe(0);
    expect(await svc.materialize(NOW)).toEqual({ created: 0, skipped: 0, paused: 0 });
    expect(posts.create).toHaveBeenCalledTimes(1);
  });

  it('lỗi hạ tầng (5xx/không rõ) ⇒ không tạm dừng, thử lại lượt sau', async () => {
    const { svc, row, posts } = setup();
    posts.create.mockRejectedValueOnce(new Error('db down'));
    await svc.materialize(NOW);
    expect(row.active).toBe(true);
    expect(row.count).toBe(0);
  });

  it('max_count: tạo bài cuối rồi next_run_at = null', async () => {
    const { svc, row } = setup({ max_count: 3, count: 2 });
    await svc.materialize(NOW);
    expect(row.count).toBe(3);
    expect(row.next_run_at).toBeNull();
  });

  it('ends_on: lần kế tiếp quá ngày kết thúc ⇒ null', async () => {
    const { svc, row } = setup({ ends_on: new Date('2026-10-20T00:00:00Z') });
    await svc.materialize(NOW);
    expect(row.count).toBe(1);
    expect(row.next_run_at).toBeNull();
  });

  it('lần đăng xa hơn 90 ngày ⇒ chờ, chưa tạo', async () => {
    const { svc, posts } = setup({ next_run_at: vn('2027-03-01T09:00:00') });
    expect(await svc.materialize(NOW)).toMatchObject({ created: 0, skipped: 1 });
    expect(posts.create).not.toHaveBeenCalled();
  });
});

describe('SocialRecurrenceService — tạm dừng / sửa chen ngang lượt chạy nền', () => {
  it('lịch bị tạm dừng đúng lúc đang tạo bài ⇒ transaction tạo bài bỏ, không đếm, không dời', async () => {
    const { svc, row, posts } = setup();
    posts.create.mockImplementationOnce(async (_u: unknown, _i: unknown, opts: any) => {
      row.active = false; // người dùng bấm Tạm dừng giữa lúc đọc và lúc tạo
      await opts.inTx({ $queryRaw: async () => [] }, 100);
      return { id: 100 };
    });
    await svc.materialize(NOW);
    expect(row.count).toBe(0);
    expect(iso(row.next_run_at)).toBe(at('2026-10-20T09:00:00'));
  });

  it('tạm dừng: tắt lịch TRƯỚC rồi mới huỷ bài chờ; bài huỷ trả lại khoá chống lặp (source)', async () => {
    const { svc, row, prisma, posts } = setup({}, { id: 55, source: `recur:7:${at('2026-10-20T09:00:00')}` });
    const order: string[] = [];
    prisma.socialRecurrence.update.mockImplementation(async ({ data }: any) => { order.push(`update:${JSON.stringify(data)}`); return Object.assign(row, data); });
    posts.cancel.mockImplementation(async () => { order.push('cancel'); });
    jest.spyOn(svc as any, 'get').mockResolvedValue({});
    await svc.pause(7);
    expect(order[0]).toBe('update:{"active":false}');
    expect(order[1]).toBe('cancel');
    const sql = prisma.$executeRaw.mock.calls.map((c: any[]) => (c[0] as string[]).join('?'));
    expect(sql.some((q: string) => /SET source = LEFT\('cancelled:'/.test(q))).toBe(true);
  });
});

describe('SocialRecurrenceService.upcoming', () => {
  it('3 lần tới, tôn trọng max_count và bài chờ đã tính', () => {
    const { svc } = setup();
    const base = { rule: rule as never, starts_on: new Date('2026-10-01T00:00:00Z'), ends_on: null, active: true };
    expect(svc.upcoming({ ...base, max_count: null, count: 0 }, false, 3, NOW).map(iso)).toEqual([at('2026-10-20T09:00:00'), at('2026-10-21T09:00:00'), at('2026-10-22T09:00:00')]);
    // max 2, đã tạo 1 (đang chờ) ⇒ còn 2 lần
    expect(svc.upcoming({ ...base, max_count: 2, count: 1 }, true, 3, NOW)).toHaveLength(2);
    expect(svc.upcoming({ ...base, max_count: 2, count: 2 }, false, 3, NOW)).toHaveLength(0);
    expect(svc.upcoming({ ...base, active: false, max_count: null, count: 0 }, false, 3, NOW)).toEqual([]);
  });
});
