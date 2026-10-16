const ENDPOINT = '/api/fe-logging'
const QUEUE: Record<string, unknown>[] = []
let flushing = false

function flush() {
  if (flushing || QUEUE.length === 0) return
  flushing = true
  const batch = QUEUE.splice(0, 10)
  Promise.all(
    batch.map((entry) =>
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
        keepalive: true,
      }).catch(() => {}),
    ),
  ).finally(() => {
    flushing = false
    if (QUEUE.length > 0) setTimeout(flush, 100)
  })
}

function send(entry: Record<string, unknown>) {
  QUEUE.push(entry)
  flush()
}

/**
 * Mask số điện thoại: chỉ giữ 2 số cuối, mọi nhóm còn
 * lại thay bằng `x` và phân cách bằng dash để khớp pattern `xxx-xxx-**67`.
 * - Phone VN 10 số (vd 0912345678 → "xxxx-xxxx-**78")
 * - Phone quốc tế 11 số (vd 84912345678 → "xxxxx-xxxx-**78")
 * - <4 số: trả `x` × length, không leak gì.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return ''
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length < 4) return 'x'.repeat(digits.length)
  const tail = digits.slice(-2)
  const head = digits.slice(0, -2)
  // Chia head thành 2 nhóm: left lớn hơn (Math.ceil) khi length lẻ.
  const split = Math.ceil(head.length / 2)
  const left = 'x'.repeat(split)
  const right = 'x'.repeat(head.length - split)
  return `${left}-${right}-**${tail}`
}

// Reserved keys do helper tự set — strip khỏi `extra` của caller để tránh
// silently override (vd `extra.message` đè err.message gốc).
const RESERVED_LOG_KEYS = new Set(['level', 'message', 'stack', 'url'])

function safeExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!extra) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(extra)) {
    if (!RESERVED_LOG_KEYS.has(k)) out[k] = v
  }
  return out
}

export function logFrontendError(error: unknown, extra?: Record<string, unknown>) {
  const err = error instanceof Error ? error : new Error(String(error))
  // Dynamic import: tránh vòng phụ thuộc với api-client và không kéo giám sát vào bundle chính.
  if (typeof window !== 'undefined') void import('./monitoring').then((m) => m.reportClientError(err)).catch(() => undefined)
  send({
    ...safeExtra(extra),
    level: 'error',
    message: err.message,
    stack: err.stack,
    url: typeof window !== 'undefined' ? window.location.href : '',
  })
}

/**
 * Gửi event không phải error (vd metric "connecting_slow"). `level` rõ ràng
 * (không qua spread override). `extra` được spread phẳng vào entry để Kibana
 * query top-level — caller KHÔNG nên bọc thêm `extra:` lồng.
 *
 * Reserved keys (`level`, `message`, `stack`, `url`) trong `extra` sẽ bị strip
 * để giữ payload schema nhất quán; caller dùng `level`/`component` ở root level.
 */
export function logFrontendEvent(
  message: string,
  options?: {
    level?: 'info' | 'warn'
    component?: string
    extra?: Record<string, unknown>
  },
) {
  send({
    ...safeExtra(options?.extra),
    level: options?.level ?? 'info',
    message,
    component: options?.component,
    url: typeof window !== 'undefined' ? window.location.href : '',
  })
}

interface PatchableConsole {
  __trinityLoggerPatched?: boolean
}

export function initGlobalErrorHandlers() {
  if (typeof window === 'undefined') return
  // Idempotent: HMR / StrictMode / gọi nhiều lần không chain wrap (mỗi log
  // có thể nhân N lần nếu wrap chồng).
  const con = console as Console & PatchableConsole
  if (con.__trinityLoggerPatched) return
  con.__trinityLoggerPatched = true

  window.addEventListener('error', (event) => {
    logFrontendError(event.error ?? event.message, {
      component: 'window.onerror',
      extra: { filename: event.filename, lineno: event.lineno, colno: event.colno },
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    logFrontendError(event.reason ?? 'Unhandled promise rejection', {
      component: 'unhandledrejection',
    })
  })

  // Intercept console.error to catch 3rd party lib errors
  const origConsoleError = console.error
  console.error = (...args: unknown[]) => {
    origConsoleError.apply(console, args)
    const msg = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')
    // Skip React hydration warnings and our own fe-error logs
    if (msg.includes('[fe-error]') || msg.includes('Hydration')) return
    send({ level: 'warn', message: msg, component: 'console.error', url: window.location.href })
  }
}
