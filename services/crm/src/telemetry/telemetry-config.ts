import { resolveRelease } from '@trinity/logger';

export interface TelemetryConfig {
  sentry: { dsn: string; environment: string; release: string | null; traces_sample_rate: number } | null;
  posthog: { key: string; host: string; replay: boolean } | null;
}

/** Cấu hình giám sát cho trình duyệt. Chưa đặt biến môi trường ⇒ cả hai là null (web không nạp SDK nào). */
export function buildTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const dsn = env.SENTRY_DSN_WEB?.trim();
  const key = env.POSTHOG_KEY?.trim();
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1');
  return {
    sentry: dsn
      ? {
          dsn,
          environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'production',
          release: resolveRelease(env) ?? null,
          traces_sample_rate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.1,
        }
      : null,
    posthog: key ? { key, host: env.POSTHOG_HOST?.trim() || 'https://us.i.posthog.com', replay: env.POSTHOG_REPLAY === 'true' } : null,
  };
}
