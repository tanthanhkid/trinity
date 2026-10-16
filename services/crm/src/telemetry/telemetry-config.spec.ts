import { buildTelemetryConfig } from './telemetry-config';

describe('buildTelemetryConfig', () => {
  it('chưa đặt biến nào → cả hai null', () => {
    expect(buildTelemetryConfig({})).toEqual({ sentry: null, posthog: null });
  });
  it('có DSN web + key PostHog', () => {
    const c = buildTelemetryConfig({
      SENTRY_DSN_WEB: 'https://k@o.example/2',
      SENTRY_ENVIRONMENT: 'staging',
      TRINITY_RELEASE: 'r1',
      SENTRY_TRACES_SAMPLE_RATE: '0.5',
      POSTHOG_KEY: 'phc_x',
      POSTHOG_REPLAY: 'true',
    });
    expect(c.sentry).toEqual({ dsn: 'https://k@o.example/2', environment: 'staging', release: 'r1', traces_sample_rate: 0.5 });
    expect(c.posthog).toEqual({ key: 'phc_x', host: 'https://us.i.posthog.com', replay: true });
  });
  it('SENTRY_DSN (API) không lộ ra web; replay mặc định tắt; tỉ lệ sai → 0.1', () => {
    const c = buildTelemetryConfig({ SENTRY_DSN: 'https://api@o.example/1', SENTRY_DSN_WEB: 'https://w@o.example/2', SENTRY_TRACES_SAMPLE_RATE: 'abc', POSTHOG_KEY: 'k', POSTHOG_HOST: 'https://ph.example.com' });
    expect(c.sentry?.dsn).toBe('https://w@o.example/2');
    expect(c.sentry?.traces_sample_rate).toBe(0.1);
    expect(c.posthog).toEqual({ key: 'k', host: 'https://ph.example.com', replay: false });
  });
});
