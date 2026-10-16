import { createHmac } from 'node:crypto'

/**
 * Sự kiện sản phẩm gửi từ server (PostHog capture API). Mặc định TẮT: chưa gọi `configureProductEvents`
 * thì mọi hàm là no-op, không gọi mạng. Props chỉ nhận khoá/số đếm/boolean — không tên, không nội dung.
 */
export interface ProductEventsConfig {
  key: string
  host: string
  environment?: string
  release?: string
  hashSecret: string
}

export type ProductEventProps = Record<string, string | number | boolean | null | undefined>

let config: ProductEventsConfig | null = null
let hashSecretValue = ''

export function configureProductEvents(cfg: ProductEventsConfig | null): void {
  config = cfg && cfg.key && cfg.host && cfg.hashSecret ? cfg : null
  if (config) hashSecretValue = config.hashSecret
}

/** Đặt riêng khoá băm (dùng cho Sentry/identity khi PostHog tắt). Không gọi mạng. */
export function configureHashSecret(secret: string | undefined): void {
  hashSecretValue = secret ?? ''
}

export function hashingEnabled(): boolean {
  return hashSecretValue.length > 0
}

export function productEventsEnabled(): boolean {
  return config !== null && process.env.NODE_ENV !== 'test'
}

/** HMAC-SHA256 (user id là Int tự tăng nên không dùng sha thường), hex 24 ký tự. */
export function hashUserId(id: number | string): string {
  return createHmac('sha256', hashSecretValue).update(String(id)).digest('hex').slice(0, 24)
}

const MAX_STRING = 60

export function sanitizeProps(props: ProductEventProps | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(props ?? {})) {
    if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = v
    } else if (typeof v === 'string') {
      if (v.includes('@') || /\d{8,}/.test(v)) continue
      out[k] = v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v
    }
  }
  return out
}

export function trackProductEvent(event: string, userId: number | string | null | undefined, props?: ProductEventProps): void {
  try {
    if (!config || process.env.NODE_ENV === 'test') return
    const distinctId = userId === null || userId === undefined ? 'anonymous-server' : hashUserId(userId)
    const body = {
      api_key: config.key,
      event,
      distinct_id: distinctId,
      properties: {
        ...sanitizeProps(props),
        environment: config.environment,
        release: config.release,
        $lib: 'trinity-server',
        ...(userId === null || userId === undefined ? { $process_person_profile: false } : {}),
      },
    }
    const url = `${config.host.replace(/\/+$/, '')}/i/v0/e/`
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined)
  } catch {
    /* never throw */
  }
}
