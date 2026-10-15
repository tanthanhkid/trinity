import { DEFAULT_LEAD_RULES, normalizeRules, scoreLead, labelFor, type LeadSignals } from './lead-scoring.rules';

const NOW = new Date('2026-10-07T03:00:00Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

const base: LeadSignals = {
  phone: '0912345678',
  has_demand: true,
  stage_value: 'follow_up_3',
  source_value: 'referral',
  last_activity_at: daysAgo(0.5),
  last_response_at: daysAgo(1),
  interactions_in_window: 6,
  ai_intent: null,
  created_at: daysAgo(40),
};

describe('scoreLead — quy tắc mặc định', () => {
  const rules = DEFAULT_LEAD_RULES;

  it('khách đủ mọi tín hiệu tốt = 100, nhãn Nóng', () => {
    const r = scoreLead(base, rules, NOW);
    expect(r.score).toBe(100);
    expect(r.label).toBe('hot');
    expect(r.reasons.map((x) => x.key)).toEqual(['recency', 'interactions', 'stage', 'response', 'source', 'profile']);
  });

  it('tổng điểm tối đa của các tiêu chí mặc định đúng 100', () => {
    const r = scoreLead(base, rules, NOW);
    expect(r.reasons.reduce((a, x) => a + x.max, 0)).toBe(100);
  });

  it('khách mới nhập, chưa tương tác, không SĐT/nhu cầu, nguồn lạ = Lạnh', () => {
    const r = scoreLead(
      { ...base, phone: null, has_demand: false, stage_value: 'new', source_value: 'other', last_activity_at: null, last_response_at: null, interactions_in_window: 0, created_at: daysAgo(60) },
      rules,
      NOW,
    );
    // recency 0 (60 ngày) + 0 + stage 5 + 0 + source mặc định 4 + 0
    expect(r.score).toBe(9);
    expect(r.label).toBe('cold');
  });

  it('độ mới giảm theo bậc ngày', () => {
    const at = (d: number) => scoreLead({ ...base, last_activity_at: daysAgo(d) }, rules, NOW).reasons[0].points;
    expect([at(0.5), at(2), at(5), at(10), at(20), at(45)]).toEqual([25, 20, 15, 8, 3, 0]);
  });

  it('không có hoạt động nào → độ mới tính từ ngày tạo', () => {
    const r = scoreLead({ ...base, last_activity_at: null, created_at: daysAgo(2) }, rules, NOW);
    expect(r.reasons[0].points).toBe(20);
  });

  it('tương tác bị chặn trần 20', () => {
    const r = scoreLead({ ...base, interactions_in_window: 50 }, rules, NOW);
    expect(r.reasons[1].points).toBe(20);
  });

  it('phản hồi: 3 ngày=15, 10 ngày=5, quá 14 ngày=0, chưa có=0', () => {
    const at = (d: number | null) => scoreLead({ ...base, last_response_at: d === null ? null : daysAgo(d) }, rules, NOW).reasons[3].points;
    expect([at(3), at(10), at(20), at(null)]).toEqual([15, 5, 0, 0]);
  });

  it('SĐT trống/khoảng trắng không được điểm hồ sơ phần SĐT', () => {
    const r = scoreLead({ ...base, phone: '  ', has_demand: false }, rules, NOW);
    expect(r.reasons[5].points).toBe(0);
  });

  it('ý định do agent chấm: mặc định bật, cộng thưởng, chặn trần 100; admin tắt thì bỏ; khoá cũ `llm` không còn tác dụng', () => {
    const off = scoreLead({ ...base, ai_intent: 1 }, normalizeRules({ ai_intent: { enabled: false } }), NOW);
    expect(off.reasons.some((x) => x.key === 'ai_intent')).toBe(false);
    expect(normalizeRules({ llm: { enabled: false } }).ai_intent.enabled).toBe(true);
    const on = scoreLead({ ...base, ai_intent: 1 }, rules, NOW);
    expect(on.reasons.at(-1)).toMatchObject({ key: 'ai_intent', points: 10 });
    expect(on.score).toBe(100);
    const mid = scoreLead(
      { ...base, last_activity_at: daysAgo(20), last_response_at: null, ai_intent: 0.5 },
      rules,
      NOW,
    );
    expect(mid.reasons.at(-1)?.points).toBe(5);
  });
});

describe('nhãn + ngưỡng', () => {
  it('70+ Nóng, 40–69 Ấm, dưới 40 Lạnh', () => {
    const th = DEFAULT_LEAD_RULES.thresholds;
    expect([labelFor(100, th), labelFor(70, th), labelFor(69, th), labelFor(40, th), labelFor(39, th), labelFor(0, th)]).toEqual(['hot', 'hot', 'warm', 'warm', 'cold', 'cold']);
  });
});

describe('normalizeRules', () => {
  it('rác/null → mặc định', () => {
    expect(normalizeRules(null)).toEqual(DEFAULT_LEAD_RULES);
    expect(normalizeRules('x')).toEqual(DEFAULT_LEAD_RULES);
    expect(normalizeRules({ recency: { tiers: 'bad' }, thresholds: { hot: -5 } })).toEqual(DEFAULT_LEAD_RULES);
  });

  it('ghi đè một phần, phần còn lại giữ mặc định', () => {
    const r = normalizeRules({ thresholds: { hot: 80, warm: 50 }, source: { points: { zalo: 10 }, default_points: 0 } });
    expect(r.thresholds).toEqual({ hot: 80, warm: 50 });
    expect(r.source).toEqual({ points: { zalo: 10 }, default_points: 0 });
    expect(r.stage).toEqual(DEFAULT_LEAD_RULES.stage);
  });

  it('ngưỡng warm >= hot bị loại về mặc định', () => {
    expect(normalizeRules({ thresholds: { hot: 30, warm: 60 } }).thresholds).toEqual({ hot: 70, warm: 40 });
  });

  it('bậc ngày được sắp tăng dần và bỏ dòng hỏng', () => {
    const r = normalizeRules({ recency: { tiers: [{ max_days: 10, points: 5 }, { max_days: 2, points: 20 }, { max_days: 'x', points: 1 }] } });
    expect(r.recency.tiers).toEqual([{ max_days: 2, points: 20 }, { max_days: 10, points: 5 }]);
  });
});
