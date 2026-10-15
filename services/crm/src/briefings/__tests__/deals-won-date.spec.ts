import { BriefingAggregatorService } from '../briefing-aggregator.service';
import { dealStatusInRange } from '../../reports/dashboard-overview.scope';

const NOW = new Date('2026-10-07T01:00:00Z'); // 08:00 VN sáng → kỳ = hôm qua 06/10 VN
const START = new Date('2026-10-05T17:00:00.000Z');
const END = new Date('2026-10-06T17:00:00.000Z');

describe('dealStatusInRange — deal thắng tính theo NGÀY THẮNG', () => {
  it('won: won_at trong kỳ, hoặc (won_at NULL và updated_at trong kỳ) cho dữ liệu cũ', () => {
    const range = { gte: START, lt: END };
    expect(dealStatusInRange('won', { start: START, end: END })).toEqual({
      status: 'won',
      OR: [{ won_at: range }, { won_at: null, updated_at: range }],
    });
  });

  it('lost vẫn theo updated_at (chưa có cột riêng)', () => {
    expect(dealStatusInRange('lost', { start: START, end: END })).toEqual({
      status: 'lost',
      updated_at: { gte: START, lt: END },
    });
  });

  it('end bỏ trống → chỉ chặn dưới', () => {
    expect(dealStatusInRange('won', { start: START })).toEqual({
      status: 'won',
      OR: [{ won_at: { gte: START } }, { won_at: null, updated_at: { gte: START } }],
    });
  });
});

describe('BriefingAggregatorService — deal thắng', () => {
  it('đếm/tổng giá trị deal thắng theo won_at (KHÔNG chỉ updated_at), có fallback updated_at', async () => {
    const aggregate = jest.fn(async () => ({ _count: { _all: 0 }, _sum: { value: null } }));
    const prisma = {
      contact: { count: jest.fn(async () => 0) },
      activity: { count: jest.fn(async () => 0) },
      deal: { count: jest.fn(async () => 0), aggregate, groupBy: jest.fn(async () => []) },
      kanbanCard: { count: jest.fn(async () => 0) },
      user: { count: jest.fn(async () => 1), findMany: jest.fn(async () => []) },
    };
    await new BriefingAggregatorService(prisma as never).collect('all', 'morning', NOW);

    const wheres = aggregate.mock.calls.map((c) => JSON.stringify((c as unknown as [{ where: unknown }])[0].where));
    const won = wheres.filter((w) => w.includes('"status":"won"'));
    expect(won.length).toBeGreaterThan(0);
    for (const w of won) {
      expect(w).toContain('"won_at":{"gte"');
      expect(w).toContain('"won_at":null,"updated_at"'); // fallback dữ liệu cũ
    }
    // Deal thua không đụng tới won_at.
    for (const w of wheres.filter((x) => x.includes('"status":"lost"'))) expect(w).not.toContain('won_at');
  });
});
