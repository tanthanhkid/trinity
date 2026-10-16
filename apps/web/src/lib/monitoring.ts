import apiClient from './api-client'
import { getAccessToken } from './token-storage'
import { scrubBreadcrumb, scrubPostHogEvent, scrubSentryEvent } from './monitoring-filters'

/**
 * Giám sát phía trình duyệt (Sentry + PostHog). TẮT mặc định: máy chủ trả `null` thì không làm gì và
 * không nạp SDK nào (đều là dynamic import). Chỉ chạy trên client, một lần.
 */
interface TelemetryConfig {
  sentry: { dsn: string; environment: string; release: string | null; traces_sample_rate: number } | null
  posthog: { key: string; host: string; replay: boolean } | null
}

type SentryModule = typeof import('@sentry/browser')
type PostHogClient = import('posthog-js').PostHog

let booting: Promise<void> | null = null
let sentry: SentryModule | null = null
let posthog: PostHogClient | null = null

async function fetchIdentity(): Promise<string | null> {
  if (!getAccessToken()) return null
  try {
    const { data } = await apiClient.get<{ user: string | null }>('/telemetry/identity')
    return data?.user ?? null
  } catch {
    return null
  }
}

async function startSentry(cfg: NonNullable<TelemetryConfig['sentry']>): Promise<void> {
  const S = await import('@sentry/browser')
  S.init({
    dsn: cfg.dsn,
    environment: cfg.environment,
    release: cfg.release ?? undefined,
    sendDefaultPii: false,
    tracesSampleRate: cfg.traces_sample_rate,
    integrations: [S.browserTracingIntegration()],
    tracePropagationTargets: [/^\/api\/v1/],
    beforeSend: (event) => scrubSentryEvent(event as never) as typeof event,
    beforeSendTransaction: (event) => scrubSentryEvent(event as never) as typeof event,
    beforeBreadcrumb: (b) => scrubBreadcrumb(b as never) as typeof b | null,
  })
  sentry = S
}

async function startPostHog(cfg: NonNullable<TelemetryConfig['posthog']>): Promise<void> {
  const mod = await import('posthog-js')
  const ph = mod.default
  ph.init(cfg.key, {
    api_host: cfg.host,
    autocapture: false,
    capture_pageview: 'history_change',
    person_profiles: 'identified_only',
    disable_session_recording: !cfg.replay,
    session_recording: { maskAllInputs: true, maskTextSelector: '*', blockSelector: 'img,video,canvas' },
    mask_all_text: true,
    mask_all_element_attributes: true,
    before_send: (e) => scrubPostHogEvent(e as never) as typeof e,
  })
  posthog = ph
}

async function run(): Promise<void> {
  let cfg: TelemetryConfig | null = null
  try {
    const { data } = await apiClient.get<TelemetryConfig>('/telemetry/config')
    cfg = data
  } catch {
    return
  }
  if (!cfg || (!cfg.sentry && !cfg.posthog)) return
  try {
    await Promise.all([cfg.sentry ? startSentry(cfg.sentry) : null, cfg.posthog ? startPostHog(cfg.posthog) : null])
  } catch {
    return
  }
  const id = await fetchIdentity()
  if (id) {
    sentry?.setUser({ id })
    posthog?.identify(id)
  }
}

export function bootMonitoring(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  booting ??= run().catch(() => undefined)
  return booting
}

/** Gọi sau khi đăng nhập để gắn mã người dùng đã băm. Không làm gì nếu giám sát tắt. */
export async function identifyMonitoringUser(): Promise<void> {
  if (!booting) return
  await booting
  if (!sentry && !posthog) return
  const id = await fetchIdentity()
  if (id) {
    sentry?.setUser({ id })
    posthog?.identify(id)
  }
}

/** Báo lỗi lên Sentry nếu đang bật; không bao giờ throw. */
const reported = new WeakSet<object>()

export function reportClientError(err: unknown): void {
  if (typeof window === 'undefined' || !booting) return
  if (typeof err === 'object' && err !== null) {
    if (reported.has(err)) return // cùng một lỗi đi qua nhiều nhánh (fe-logger + error.tsx) chỉ báo một lần
    reported.add(err)
  }
  void booting.then(() => {
    try {
      sentry?.captureException(err instanceof Error ? err : new Error(String(err)))
    } catch {
      /* ignore */
    }
  })
}
