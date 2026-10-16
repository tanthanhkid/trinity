/**
 * Hàm lọc thuần cho Sentry/PostHog phía trình duyệt: không phụ thuộc SDK, không chạm DOM.
 * Mục tiêu: không có email, số điện thoại, query string hay mã số bản ghi nào rời khỏi trình duyệt.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function scrubText(text: string): string {
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? '[phone]' : m))
}

/** Bỏ query/hash của URL (tuyệt đối hay tương đối). */
export function stripQuery(url: string): string {
  return url.split(/[?#]/)[0]
}

/** Đường dẫn không query, đoạn toàn số hoặc UUID → `:id`. */
export function pathOnly(url: string | null | undefined): string {
  if (!url) return ''
  let path = stripQuery(url)
  try {
    path = new URL(url, 'http://local.invalid').pathname
  } catch {
    /* giữ nguyên */
  }
  return path
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || UUID_RE.test(seg) ? ':id' : seg))
    .join('/')
}

/** Referrer chỉ giữ origin. */
export function originOnly(url: string | null | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

type Json = Record<string, unknown>

/** Dùng cho `before_send` của PostHog. */
export function scrubPostHogEvent<T extends { properties?: Json } | null>(event: T): T {
  if (!event?.properties) return event
  const p = event.properties
  for (const k of ['$current_url', '$pathname', '$initial_current_url', '$initial_pathname']) {
    if (typeof p[k] === 'string') p[k] = pathOnly(p[k] as string)
  }
  for (const k of ['$referrer', '$initial_referrer']) {
    if (typeof p[k] === 'string') p[k] = originOnly(p[k] as string)
  }
  for (const k of ['$referring_domain', '$initial_referring_domain']) {
    if (typeof p[k] === 'string' && (p[k] as string).includes('/')) p[k] = originOnly(p[k] as string)
  }
  for (const k of Object.keys(p)) {
    if (k.startsWith('$initial_') && !k.includes('referr') && typeof p[k] === 'string' && /^https?:\/\//.test(p[k] as string)) p[k] = pathOnly(p[k] as string)
  }
  return event
}

interface SentryLikeEvent {
  request?: { url?: string; headers?: unknown; query_string?: unknown; cookies?: unknown; data?: unknown; [k: string]: unknown }
  message?: string
  exception?: { values?: Array<{ value?: string; [k: string]: unknown }> }
  breadcrumbs?: Array<{ category?: string; message?: string; data?: Json }>
  transaction?: string
  user?: { id?: unknown; [k: string]: unknown }
  [k: string]: unknown
}

export function isDroppedBreadcrumb(b: { category?: string }): boolean {
  return b.category === 'console' || b.category === 'ui.input'
}

export function scrubBreadcrumb<T extends { category?: string; message?: string; data?: Json }>(b: T): T | null {
  if (isDroppedBreadcrumb(b)) return null
  const out = { ...b }
  if (typeof out.message === 'string') out.message = scrubText(out.message)
  if (out.data) {
    const data = { ...out.data }
    for (const k of ['url', 'from', 'to']) if (typeof data[k] === 'string') data[k] = stripQuery(data[k] as string)
    out.data = data
  }
  return out
}

/** Dùng cho `beforeSend` / `beforeSendTransaction` của Sentry. */
export function scrubSentryEvent<T extends SentryLikeEvent>(event: T): T {
  if (event.request) {
    delete event.request.headers
    delete event.request.cookies
    delete event.request.data
    delete event.request.query_string
    if (typeof event.request.url === 'string') event.request.url = stripQuery(event.request.url)
  }
  if (typeof event.message === 'string') event.message = scrubText(event.message)
  for (const v of event.exception?.values ?? []) {
    if (typeof v.value === 'string') v.value = scrubText(v.value)
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter((b): b is NonNullable<typeof b> => b !== null)
  }
  if (typeof event.transaction === 'string') event.transaction = stripQuery(event.transaction)
  if (event.user) {
    const id = event.user.id
    event.user = id === undefined || id === null ? {} : { id: String(id) }
  }
  return event
}
