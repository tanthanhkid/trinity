/**
 * Quy tắc chấm điểm lead — HÀM THUẦN, không đụng DB. Tổng tối đa 100 điểm:
 *   độ mới 25 + tương tác 20 + giai đoạn 20 + phản hồi gần nhất 15 + nguồn 10 + hồ sơ (SĐT/nhu cầu) 10 = 100,
 *   cộng thêm điểm "ý định mua" do AGENT AI của khách chấm qua MCP (`set_lead_intent`; Trinity không tự gọi AI) rồi chặn trần 100.
 * Quy tắc cấu hình được: lưu ở Setting `lead_scoring_rules` (JSON một phần); thiếu/rác → dùng mặc định.
 */

export type LeadLabel = 'hot' | 'warm' | 'cold';
export const LEAD_LABEL_VI: Record<LeadLabel, string> = { hot: 'Nóng', warm: 'Ấm', cold: 'Lạnh' };

export interface DayTier {
  max_days: number;
  points: number;
}

export interface LeadScoringRules {
  recency: { tiers: DayTier[] };
  interactions: { window_days: number; per_interaction: number; max_points: number };
  stage: { points: Record<string, number>; default_points: number };
  response: { actions: string[]; tiers: DayTier[] };
  source: { points: Record<string, number>; default_points: number };
  profile: { phone_points: number; demand_points: number };
  ai_intent: { enabled: boolean; max_points: number };
  thresholds: { hot: number; warm: number };
}

export const DEFAULT_LEAD_RULES: LeadScoringRules = {
  recency: {
    tiers: [
      { max_days: 1, points: 25 },
      { max_days: 3, points: 20 },
      { max_days: 7, points: 15 },
      { max_days: 14, points: 8 },
      { max_days: 30, points: 3 },
    ],
  },
  interactions: { window_days: 30, per_interaction: 4, max_points: 20 },
  stage: {
    points: { new: 5, follow_up_1: 10, follow_up_2: 15, follow_up_3: 20 },
    default_points: 5,
  },
  response: {
    actions: ['receive'],
    tiers: [
      { max_days: 3, points: 15 },
      { max_days: 7, points: 10 },
      { max_days: 14, points: 5 },
    ],
  },
  source: {
    points: { referral: 10, partner_referral: 8, zalo: 8, ads: 6 },
    default_points: 4,
  },
  profile: { phone_points: 5, demand_points: 5 },
  ai_intent: { enabled: true, max_points: 10 },
  thresholds: { hot: 70, warm: 40 },
};

/** Dữ kiện đã gom cho 1 khách — đầu vào của `scoreLead`. */
export interface LeadSignals {
  phone: string | null;
  has_demand: boolean;
  stage_value: string | null;
  source_value: string | null;
  last_activity_at: Date | null;
  last_response_at: Date | null;
  interactions_in_window: number;
  /** 0–1 do agent AI của khách chấm qua MCP (null = chưa chấm). */
  ai_intent: number | null;
  created_at: Date;
}

export interface LeadReason {
  key: string;
  label: string;
  points: number;
  max: number;
}

export interface LeadScoreResult {
  score: number;
  label: LeadLabel;
  reasons: LeadReason[];
}

const DAY_MS = 86_400_000;

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;

function tiers(raw: unknown, fallback: DayTier[]): DayTier[] {
  if (!Array.isArray(raw)) return fallback;
  const out = raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({ max_days: num(t.max_days, -1), points: num(t.points, -1) }))
    .filter((t) => t.max_days >= 0 && t.points >= 0)
    .sort((a, b) => a.max_days - b.max_days);
  return out.length > 0 ? out : fallback;
}

function pointMap(raw: unknown, fallback: Record<string, number>): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && v >= 0) out[k] = v;
  return Object.keys(out).length > 0 ? out : fallback;
}

/** Cấu hình thô (một phần/rác) → đủ trường, giá trị sai rơi về mặc định. */
export function normalizeRules(raw: unknown): LeadScoringRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const d = DEFAULT_LEAD_RULES;
  const acts = r.response?.actions;
  const hot = num(r.thresholds?.hot, d.thresholds.hot);
  const warm = num(r.thresholds?.warm, d.thresholds.warm);
  return {
    recency: { tiers: tiers(r.recency?.tiers, d.recency.tiers) },
    interactions: {
      window_days: num(r.interactions?.window_days, d.interactions.window_days) || d.interactions.window_days,
      per_interaction: num(r.interactions?.per_interaction, d.interactions.per_interaction),
      max_points: num(r.interactions?.max_points, d.interactions.max_points),
    },
    stage: {
      points: pointMap(r.stage?.points, d.stage.points),
      default_points: num(r.stage?.default_points, d.stage.default_points),
    },
    response: {
      actions: Array.isArray(acts) && acts.every((a) => typeof a === 'string') && acts.length > 0 ? (acts as string[]) : d.response.actions,
      tiers: tiers(r.response?.tiers, d.response.tiers),
    },
    source: {
      points: pointMap(r.source?.points, d.source.points),
      default_points: num(r.source?.default_points, d.source.default_points),
    },
    profile: {
      phone_points: num(r.profile?.phone_points, d.profile.phone_points),
      demand_points: num(r.profile?.demand_points, d.profile.demand_points),
    },
    ai_intent: aiIntentRules(r.ai_intent, d.ai_intent),
    // Ngưỡng sai thứ tự (warm > hot) → về mặc định để nhãn vẫn đơn điệu.
    thresholds: warm <= hot ? { hot, warm } : { ...d.thresholds },
  };
}

/** Điểm ý định mua do agent AI của khách chấm qua MCP. */
function aiIntentRules(raw: Record<string, unknown> | undefined, d: LeadScoringRules['ai_intent']): LeadScoringRules['ai_intent'] {
  return { enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : d.enabled, max_points: num(raw?.max_points, d.max_points) };
}

function tierPoints(at: Date | null, now: Date, list: DayTier[]): number {
  if (!at) return 0;
  const days = Math.max(0, (now.getTime() - at.getTime()) / DAY_MS);
  return list.find((t) => days <= t.max_days)?.points ?? 0;
}

const maxTier = (list: DayTier[]): number => Math.max(0, ...list.map((t) => t.points));
const maxOf = (m: Record<string, number>, def: number): number => Math.max(def, ...Object.values(m));

const lookup = (m: Record<string, number>, key: string | null, def: number): number =>
  key !== null && Object.prototype.hasOwnProperty.call(m, key) ? m[key] : def;

export function labelFor(score: number, th: LeadScoringRules['thresholds']): LeadLabel {
  return score >= th.hot ? 'hot' : score >= th.warm ? 'warm' : 'cold';
}

/** Chấm điểm 1 khách. Không có hoạt động nào → độ mới tính từ ngày tạo khách. */
export function scoreLead(s: LeadSignals, rules: LeadScoringRules, now: Date = new Date()): LeadScoreResult {
  const lastTouch = s.last_activity_at ?? s.created_at;
  const reasons: LeadReason[] = [
    { key: 'recency', label: 'Độ mới liên hệ', points: tierPoints(lastTouch, now, rules.recency.tiers), max: maxTier(rules.recency.tiers) },
    {
      key: 'interactions',
      label: 'Số lần tương tác',
      points: Math.min(rules.interactions.max_points, s.interactions_in_window * rules.interactions.per_interaction),
      max: rules.interactions.max_points,
    },
    {
      key: 'stage',
      label: 'Giai đoạn',
      points: lookup(rules.stage.points, s.stage_value, rules.stage.default_points),
      max: maxOf(rules.stage.points, rules.stage.default_points),
    },
    { key: 'response', label: 'Phản hồi gần nhất', points: tierPoints(s.last_response_at, now, rules.response.tiers), max: maxTier(rules.response.tiers) },
    {
      key: 'source',
      label: 'Nguồn khách',
      points: lookup(rules.source.points, s.source_value, rules.source.default_points),
      max: maxOf(rules.source.points, rules.source.default_points),
    },
    {
      key: 'profile',
      label: 'Có SĐT / nhu cầu',
      points: (s.phone?.trim() ? rules.profile.phone_points : 0) + (s.has_demand ? rules.profile.demand_points : 0),
      max: rules.profile.phone_points + rules.profile.demand_points,
    },
  ];
  if (rules.ai_intent.enabled && s.ai_intent !== null) {
    const pts = Math.round(Math.min(1, Math.max(0, s.ai_intent)) * rules.ai_intent.max_points);
    reasons.push({ key: 'ai_intent', label: 'Agent AI đánh giá nhu cầu', points: pts, max: rules.ai_intent.max_points });
  }
  const score = Math.min(100, Math.round(reasons.reduce((a, r) => a + r.points, 0)));
  return { score, label: labelFor(score, rules.thresholds), reasons };
}
