/**
 * Hợp đồng đóng băng C04 (docs/rust/PLAN.md mục 6.1): `server/contracts/rbac.json` và `server/contracts/events.json`.
 *  - rbac.json: catalog quyền (nhóm, nhãn, phạm vi, nhạy cảm, quyền đã gỡ), thứ tự phạm vi, cờ tính năng + nhóm, gói + hạn mức,
 *    mẫu ngành — từ `packages/rbac`. Rust (`trinity-rbac`) đọc cùng tệp làm nguồn chung.
 *  - events.json: `INTEGRATION_EVENT_META` từ `packages/prisma/src/integrations/event-catalog.ts`.
 * Spec sinh lại từ gói TS rồi so TỪNG BYTE với tệp đã commit: đổi gói TS mà chưa cập nhật JSON thì đỏ.
 * Sinh lại: `UPDATE_RBAC_EVENTS_CONTRACT=1 npx jest rbac-events-contract` (trong services/crm).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ALL_PERMISSIONS, BASIC_FEATURES, BLANK_SYSTEM_FEATURES, CHANNEL_LIMIT_KEYS, DEFAULT_OFF_FEATURES, DEFAULT_PLAN, DEFAULT_SIGNUP_PLAN,
  INDUSTRY_KEYS, INDUSTRY_PRESETS, LOCKED_FEATURES, MAX_BUILD_FEATURES, ORG_FEATURES, ORG_FEATURE_GROUPS, ORG_FEATURE_KEYS, PERMISSIONS,
  PERMISSION_GROUPS, PLANS, PLAN_GATED_FEATURES, PLAN_KEYS, RETIRED_ORG_FEATURE_KEYS, RETIRED_PERMISSIONS, SCOPE_ORDER, SERVERLESS_LOCKED_FEATURES,
  SETUP_STATUSES, SETUP_STATUS_SETTING_KEY,
} from '@trinity/rbac';
import { INTEGRATION_EVENT_META, INTEGRATION_EVENT_TYPES } from '@trinity/prisma';

const DIR = path.resolve(__dirname, '../../../../../server/contracts');
const UPDATE = process.env.UPDATE_RBAC_EVENTS_CONTRACT === '1';
const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

function check(file: string, content: string): void {
  const p = path.join(DIR, file);
  if (UPDATE) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(p, content);
    return;
  }
  expect(fs.existsSync(p)).toBe(true);
  expect(content).toBe(fs.readFileSync(p, 'utf8'));
}

const rbac = {
  scope_order: SCOPE_ORDER,
  permission_groups: PERMISSION_GROUPS,
  retired_permissions: RETIRED_PERMISSIONS,
  permissions: ALL_PERMISSIONS.map((key) => ({ key, ...PERMISSIONS[key] })),
  org_feature_groups: ORG_FEATURE_GROUPS,
  org_features: ORG_FEATURE_KEYS.map((key) => ({ key, ...ORG_FEATURES[key] })),
  basic_features: BASIC_FEATURES,
  default_off_features: [...DEFAULT_OFF_FEATURES],
  blank_system_features: BLANK_SYSTEM_FEATURES,
  serverless_locked_features: SERVERLESS_LOCKED_FEATURES,
  retired_org_feature_keys: RETIRED_ORG_FEATURE_KEYS,
  setup_statuses: SETUP_STATUSES,
  setup_status_setting_key: SETUP_STATUS_SETTING_KEY,
  plan_keys: PLAN_KEYS,
  default_plan: DEFAULT_PLAN,
  default_signup_plan: DEFAULT_SIGNUP_PLAN,
  plan_gated_features: PLAN_GATED_FEATURES,
  channel_limit_keys: CHANNEL_LIMIT_KEYS,
  plans: PLANS,
  industry_keys: INDUSTRY_KEYS,
  locked_features: LOCKED_FEATURES,
  max_build_features: MAX_BUILD_FEATURES,
  industry_presets: INDUSTRY_PRESETS,
};

const events = {
  event_types: INTEGRATION_EVENT_TYPES,
  events: INTEGRATION_EVENT_TYPES.map((type) => ({ type, ...INTEGRATION_EVENT_META[type] })),
};

describe('hợp đồng rbac.json / events.json', () => {
  it('rbac.json khớp gói @trinity/rbac từng byte', () => {
    expect(rbac.permissions.length).toBeGreaterThan(0);
    check('rbac.json', json(rbac));
  });
  it('events.json khớp event-catalog.ts từng byte', () => {
    expect(events.events.length).toBe(Object.keys(INTEGRATION_EVENT_META).length);
    check('events.json', json(events));
  });
});
