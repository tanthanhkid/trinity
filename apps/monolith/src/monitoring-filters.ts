import { redactUrl } from '@trinity/logger'

/**
 * Hàm lọc dữ liệu thuần cho Sentry (không phụ thuộc SDK) — xoá mọi thứ có thể chứa dữ liệu khách hàng
 * trước khi sự kiện rời khỏi máy chủ.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
// Số điện thoại: dãy ≥ 8 chữ số, cho phép dấu +, khoảng trắng, chấm, gạch, ngoặc xen giữa.
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g

export function scrubText(text: string): string {
  return text.replace(EMAIL_RE, '[email]').replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? '[phone]' : m))
}

/** Che token trong đường dẫn/query rồi bỏ hẳn query string. */
export function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return url
  const redacted = redactUrl(url) ?? url
  return redacted.split(/[?#]/)[0]
}

interface SentryLikeEvent {
  request?: { url?: string; data?: unknown; cookies?: unknown; headers?: unknown; query_string?: unknown; [k: string]: unknown }
  user?: { id?: unknown; [k: string]: unknown }
  message?: string
  exception?: { values?: Array<{ value?: string; [k: string]: unknown }> }
  breadcrumbs?: Array<{ category?: string; type?: string; message?: string; data?: Record<string, unknown> }>
  transaction?: string
  spans?: Array<{ description?: string; data?: Record<string, unknown> }>
  [k: string]: unknown
}

export function scrubBreadcrumbs<T extends NonNullable<SentryLikeEvent['breadcrumbs']>>(crumbs: T): T {
  return crumbs
    .filter((b) => b.category !== 'console')
    .map((b) => {
      const data = b.data ? { ...b.data } : undefined
      if (data && typeof data.url === 'string') data.url = scrubUrl(data.url)
      const out = { ...b, ...(data ? { data } : {}) }
      if (typeof out.message === 'string') out.message = scrubText(out.message)
      return out
    }) as T
}

export function scrubEvent<T extends SentryLikeEvent>(event: T): T {
  if (event.request) {
    const r = event.request
    delete r.data
    delete r.cookies
    delete r.headers
    delete r.query_string
    if (typeof r.url === 'string') r.url = scrubUrl(r.url)
  }
  if (event.user) {
    const id = event.user.id
    event.user = id === undefined || id === null ? {} : { id: String(id) }
  }
  if (typeof event.message === 'string') event.message = scrubText(event.message)
  for (const v of event.exception?.values ?? []) {
    if (typeof v.value === 'string') v.value = scrubText(v.value)
  }
  if (event.breadcrumbs) event.breadcrumbs = scrubBreadcrumbs(event.breadcrumbs)
  if (typeof event.transaction === 'string' && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(event.transaction)) {
    const [method, ...rest] = event.transaction.split(' ')
    event.transaction = `${method} ${scrubUrl(rest.join(' '))}`
  }
  for (const s of event.spans ?? []) {
    if (typeof s.description === 'string') s.description = scrubText(scrubUrl(s.description) ?? '')
    if (s.data) {
      for (const k of ['url', 'http.url', 'url.full', 'http.query', 'url.query', 'http.target']) {
        if (typeof s.data[k] === 'string') s.data[k] = k.includes('query') ? '' : scrubUrl(s.data[k] as string)
      }
    }
  }
  return event
}
