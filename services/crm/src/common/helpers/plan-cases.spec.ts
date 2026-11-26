/**
 * Bảng ca dùng chung TS ↔ Rust (K25, docs/rust/PLAN.md mục 6.3): `server/contracts/cases/plan.json`.
 * Phía TS là chuẩn: spec này tính lại mọi ca bằng `@trinity/rbac` (khoá/nhãn/gói/giải gói), `@trinity/rbac-nest`
 * (câu hết chỗ) và `FixedWindowLimiter` thật, rồi so với cột kết quả trong bảng. Rust chạy cùng bảng ở
 * `server/crates/trinity-rbac/tests/plan_cases.rs` (khoá, nhãn, gói, cổng, hạn mức người) và
 * `server/crates/trinity-http/tests/rate_limit_cases.rs` (cửa sổ cố định).
 * Sinh lại cột kết quả sau khi thêm ca: `UPDATE_PLAN_CASES=1 npx jest plan-cases` (trong services/crm).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  BLANK_SYSTEM_FEATURES,
  DEFAULT_OFF_FEATURES,
  ORG_FEATURES,
  ORG_FEATURE_KEYS,
  PLANS,
  PLAN_GATED_FEATURES,
  PLAN_KEYS,
  RETIRED_ORG_FEATURE_KEYS,
  applyPlanToFeatures,
  resolveOrgFeatures,
  resolvePlanForCompany,
} from '@trinity/rbac';
import { userLimitMessage } from '@trinity/rbac-nest';
import { FixedWindowLimiter } from './fixed-window-limiter';

const FILE = path.resolve(__dirname, '../../../../../server/contracts/cases/plan.json');

type Table = Record<string, unknown>;

/** Câu của `OrgFeatureGuard` (org-feature.guard.ts): 403 khi tính năng tắt. */
const gateMessage = (key: keyof typeof ORG_FEATURES) => `Tính năng "${ORG_FEATURES[key].label}" chưa bật hoặc không có trong gói hiện tại.`;

const RAW_FEATURES: unknown[] = [
  undefined,
  null,
  'text',
  42,
  [],
  {},
  { contacts: false },
  { contacts: 'false', pos: 1, kanban: null },
  { online_store: true },
  { online_store: false, dashboard: false, ai_briefing: true, zalo_oa: true, lead_scoring: true, stale_reminders: true, facebook_page: true },
  { google_sheets: true, commerce_connectors: true, payments: true, integrations: false },
  Object.fromEntries(ORG_FEATURE_KEYS.map((k) => [k, true])),
  Object.fromEntries(ORG_FEATURE_KEYS.map((k) => [k, false])),
];

const RAW_PLANS: (string | undefined)[] = [undefined, '', 'junk', 'MAC_DINH', ...PLAN_KEYS];
const COMPANY_IDS: (number | null)[] = [null, 1, 2, 7];

function limiterRun(max: number, windowMs: number, steps: Array<[string, number]>) {
  const l = new FixedWindowLimiter(max, windowMs);
  return steps.map(([key, now]) => ({ key, now, out: l.hit(key, now) }));
}

function compute(): Table {
  const features = {
    keys: ORG_FEATURE_KEYS.map((k) => ({ key: k, label: ORG_FEATURES[k].label, group: ORG_FEATURES[k].group })),
    default_off: [...DEFAULT_OFF_FEATURES],
    plan_gated: [...PLAN_GATED_FEATURES],
    retired: [...RETIRED_ORG_FEATURE_KEYS],
    blank: BLANK_SYSTEM_FEATURES,
  };
  const plans = PLAN_KEYS.map((k) => ({
    key: k,
    label: PLANS[k].label,
    features: [...PLANS[k].features],
    max_users: PLANS[k].maxUsers,
    channel_limits: PLANS[k].channelLimits,
  }));
  const resolve = RAW_FEATURES.flatMap((raw) =>
    [false, true].map((blank) => ({ raw: raw === undefined ? null : raw, blank, out: resolveOrgFeatures(raw, blank ? BLANK_SYSTEM_FEATURES : undefined) })),
  );
  const apply = PLAN_KEYS.flatMap((plan) =>
    RAW_FEATURES.map((raw) => {
      const f = resolveOrgFeatures(raw);
      return { plan, features: f, out: applyPlanToFeatures(f, plan) };
    }),
  );
  const planFor = RAW_PLANS.flatMap((raw) => COMPANY_IDS.map((companyId) => ({ raw: raw ?? null, company_id: companyId, out: resolvePlanForCompany(raw, companyId) })));
  const gate = PLAN_KEYS.flatMap((plan) =>
    RAW_FEATURES.flatMap((raw) => {
      const eff = applyPlanToFeatures(resolveOrgFeatures(raw), plan);
      return ORG_FEATURE_KEYS.map((key) => ({ plan, raw: raw === undefined ? null : raw, key, out: eff[key] !== false ? null : gateMessage(key) }));
    }),
  );
  const slot = PLAN_KEYS.flatMap((plan) =>
    [0, 1, 5, 9, 10, 11, 29, 30, 31, 59, 60, 61, 1000].flatMap((active) =>
      [0, 1, 3].map((pending) => {
        const max = PLANS[plan].maxUsers;
        const full = max !== null && active + pending >= max;
        return { plan, active, pending, out: full ? userLimitMessage(max) : null };
      }),
    ),
  );
  const limiter = [
    { max: 2, window_ms: 60_000, steps: [['a', 1000], ['a', 2000], ['a', 3000], ['a', 61_000], ['a', 61_001], ['b', 3000], ['a', 61_002], ['a', 61_003]] },
    { max: 1, window_ms: 1000, steps: [['c1:hook', 0], ['c1:hook', 1], ['c2:hook', 1], ['c1:hook', 1000], ['c1:hook', 1001], ['c1:hook', 1002]] },
    { max: 3, window_ms: 1500, steps: [['k', 0], ['k', 100], ['k', 200], ['k', 300], ['k', 1500], ['k', 1501], ['k', 2999], ['k', 3001]] },
    { max: 5, window_ms: 70_000, steps: [['x', 0], ['x', 10], ['x', 20], ['x', 30], ['x', 40], ['x', 50], ['x', 69_999]] },
  ].map((c) => ({ ...c, out: limiterRun(c.max, c.window_ms, c.steps as Array<[string, number]>).map((r) => r.out) }));
  return { features, plans, resolve, apply, plan_for_company: planFor, gate, slot, limiter };
}

describe('bảng ca dùng chung TS ↔ Rust (server/contracts/cases/plan.json)', () => {
  const fresh = compute();
  if (process.env.UPDATE_PLAN_CASES === '1') fs.writeFileSync(FILE, `${JSON.stringify(fresh, null, 1)}\n`);
  const table = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Table;

  it('có ít nhất 300 ca', () => {
    const n = ['resolve', 'apply', 'plan_for_company', 'gate', 'slot', 'limiter'].reduce((s, k) => s + (fresh[k] as unknown[]).length, 0);
    expect(n).toBeGreaterThanOrEqual(300);
  });
  for (const key of Object.keys(fresh)) {
    it(`${key} khớp bản TS`, () => {
      expect(table[key]).toEqual(JSON.parse(JSON.stringify(fresh[key])));
    });
  }
});
