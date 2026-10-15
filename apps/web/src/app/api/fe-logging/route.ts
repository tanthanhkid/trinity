import { NextRequest, NextResponse } from 'next/server'

const ELK_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200'
const INDEX = `${process.env.FE_LOG_INDEX_PREFIX || 'app-logs-fe'}-${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}`

// Endpoint công khai (lỗi trình duyệt có thể xảy ra trước khi đăng nhập) ⇒ tự chặn lạm dụng:
// giới hạn kích thước body, số field, độ dài chuỗi và tần suất theo IP.
const MAX_BODY_BYTES = 16 * 1024
const MAX_FIELDS = 40
const MAX_STRING = 2000
const RATE_LIMIT = 60
const RATE_WINDOW_MS = 60_000
const MAX_TRACKED_IPS = 5000

// Tên field do client tự đặt, không xác thực → để tự do sẽ làm nổ mapping của index ES theo ngày.
// Chỉ nhận đúng các khoá `lib/fe-logger.ts` và nơi gọi nó thật sự gửi.
const ALLOWED_FIELDS = new Set([
  'level', 'stack', 'url', 'component', 'context', 'status', 'digest',
  'filename', 'lineno', 'colno', 'queryKey', 'reason', 'originalUrl',
])

const hits = new Map<string, { count: number; resetAt: number }>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  if (hits.size > MAX_TRACKED_IPS) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
    if (hits.size > MAX_TRACKED_IPS) hits.clear()
  }
  const entry = hits.get(ip)
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > RATE_LIMIT
}

/** Chỉ giữ field phẳng kiểu nguyên thủy, cắt chuỗi dài; bỏ object/mảng lồng và mọi tên field ngoài danh sách cho phép. */
function sanitizeFields(body: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(body).slice(0, MAX_FIELDS)) {
    if (!ALLOWED_FIELDS.has(k)) continue
    if (typeof v === 'string') out[k] = v.slice(0, MAX_STRING)
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v
  }
  return out
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (rateLimited(ip)) return NextResponse.json({ ok: false }, { status: 429 })

    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 })
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false }, { status: 400 })
    }
    const body = parsed as Record<string, unknown>
    const fields = sanitizeFields(body)

    const doc = {
      '@timestamp': new Date().toISOString(),
      service: 'web-frontend',
      severity: typeof body.level === 'string' ? body.level.slice(0, 20) : 'error',
      message: typeof body.message === 'string' && body.message ? body.message.slice(0, MAX_STRING) : 'Unknown frontend error',
      fields: {
        // Capture các field phẳng caller gửi (logFrontendEvent spread `extra` phẳng).
        ...fields,
        user_agent: req.headers.get('user-agent'),
      },
    }

    // Log to console (picked up by Filebeat if configured)
    console.error('[fe-error]', JSON.stringify(doc))

    // Direct push to Elasticsearch
    try {
      await fetch(`${ELK_URL}/${INDEX}/_doc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
        signal: AbortSignal.timeout(3000),
      })
    } catch {
      // ES not available — console log is enough
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
}
