/**
 * Bảng ca dùng chung TS ↔ Rust (K27): `server/contracts/cases/telemetry.json`. Phía TS là chuẩn: spec này tính lại mọi ca bằng
 * `buildTelemetryConfig` rồi so với cột kết quả trong bảng; Rust chạy cùng đầu vào ở `server/crates/mod-system/tests/shared_cases.rs`.
 * Sinh lại sau khi thêm ca: `UPDATE_TELEMETRY_CASES=1 npx jest telemetry-cases` (trong services/crm).
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildTelemetryConfig } from './telemetry-config';

const FILE = path.resolve(__dirname, '../../../../server/contracts/cases/telemetry.json');

// `APP_ROOT` trỏ vào thư mục không có tệp `.release` để kết quả không phụ thuộc máy chạy.
const BASE = { APP_ROOT: '/nonexistent-trinity-root' };
const ENVS: Record<string, string>[] = [
  {},
  { SENTRY_DSN_WEB: 'https://k@s.example/1' },
  { SENTRY_DSN_WEB: '  https://k@s.example/1  ', NODE_ENV: 'staging' },
  { SENTRY_DSN_WEB: 'd', SENTRY_ENVIRONMENT: 'prod-eu', NODE_ENV: 'production' },
  { SENTRY_DSN_WEB: 'd', SENTRY_ENVIRONMENT: '', NODE_ENV: '' },
  { SENTRY_DSN_WEB: 'd', TRINITY_RELEASE: ' r-1 ' },
  { SENTRY_DSN_WEB: 'd', SENTRY_TRACES_SAMPLE_RATE: '1' },
  { SENTRY_DSN_WEB: 'd', SENTRY_TRACES_SAMPLE_RATE: '0' },
  { SENTRY_DSN_WEB: 'd', SENTRY_TRACES_SAMPLE_RATE: '0.25' },
  { SENTRY_DSN_WEB: 'd', SENTRY_TRACES_SAMPLE_RATE: '2' },
  { SENTRY_DSN_WEB: 'd', SENTRY_TRACES_SAMPLE_RATE: '-0.5' },
  { SENTRY_DSN_WEB: 'd', SENTRY_TRACES_SAMPLE_RATE: 'abc' },
  { SENTRY_DSN_WEB: 'd', SENTRY_TRACES_SAMPLE_RATE: '' },
  { SENTRY_DSN_WEB: '   ' },
  { POSTHOG_KEY: 'phc_x' },
  { POSTHOG_KEY: ' phc_x ', POSTHOG_HOST: ' https://eu.i.posthog.com ', POSTHOG_REPLAY: 'true' },
  { POSTHOG_KEY: 'phc_x', POSTHOG_HOST: '   ', POSTHOG_REPLAY: 'TRUE' },
  { POSTHOG_KEY: '   ' },
  { SENTRY_DSN_WEB: 'd', POSTHOG_KEY: 'k', POSTHOG_REPLAY: 'false' },
];

function compute() {
  return ENVS.map((env) => ({ env, out: buildTelemetryConfig({ ...BASE, ...env } as NodeJS.ProcessEnv) }));
}

describe('telemetry cases (shared with Rust)', () => {
  it('khớp bảng đã commit', () => {
    const cases = compute();
    const text = JSON.stringify({ base: BASE, cases }, null, 2) + '\n';
    if (process.env.UPDATE_TELEMETRY_CASES === '1') {
      fs.writeFileSync(FILE, text);
      return;
    }
    expect(fs.readFileSync(FILE, 'utf8')).toBe(text);
  });
});
