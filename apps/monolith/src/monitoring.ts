import * as Sentry from '@sentry/node'
import {
  configureHashSecret,
  configureProductEvents,
  hashUserId,
  hashingEnabled,
  resolveRelease,
  setServerErrorReporter,
} from '@trinity/logger'
import { scrubEvent, scrubUrl } from './monitoring-filters'

/**
 * Giám sát lỗi (Sentry) + số liệu sản phẩm (PostHog). TẮT mặc định: không đặt biến môi trường thì
 * không nạp cấu hình, không gọi mạng. Trả `true` nếu có ít nhất một phần được bật. Idempotent.
 */
let result: boolean | undefined

export function initMonitoring(env: NodeJS.ProcessEnv = process.env): boolean {
  if (result !== undefined) return result

  const secret = env.MONITORING_HASH_SECRET || env.JWT_SECRET
  if (secret) configureHashSecret(secret)

  const release = resolveRelease(env)
  const environment = env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'production'
  const dsn = env.SENTRY_DSN?.trim()
  const posthogKey = env.POSTHOG_KEY?.trim()
  let enabled = false

  if (dsn) {
    const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1')
    Sentry.init({
      dsn,
      environment,
      release,
      sendDefaultPii: false,
      tracesSampleRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.1,
      beforeSend: (event) => scrubEvent(event as never) as typeof event,
      beforeSendTransaction: (event) => scrubEvent(event as never) as typeof event,
    })
    setServerErrorReporter((err, ctx) => {
      Sentry.withScope((scope) => {
        if (ctx.method) scope.setTag('http.method', ctx.method)
        if (ctx.status) scope.setTag('http.status_code', String(ctx.status))
        if (ctx.url) scope.setTag('url', scrubUrl(ctx.url) ?? '')
        if (ctx.userId !== null && ctx.userId !== undefined && hashingEnabled()) {
          scope.setUser({ id: hashUserId(ctx.userId) })
        }
        Sentry.captureException(err)
      })
      if (env.TRINITY_RUNTIME === 'serverless') void Sentry.flush(2000)
    })
    enabled = true
  }

  if (posthogKey && secret) {
    configureProductEvents({
      key: posthogKey,
      host: env.POSTHOG_HOST?.trim() || 'https://us.i.posthog.com',
      environment,
      release,
      hashSecret: secret,
    })
    enabled = true
  }

  result = enabled
  return enabled
}

/** Chỉ dùng trong test. */
export function resetMonitoringForTest(): void {
  result = undefined
}
