import type { Prisma } from '@prisma/client'

/**
 * Lọc dữ liệu trước khi vào `integration_audit_logs`: nhật ký này đọc được bởi người có
 * `integrations.ai_admin` nên KHÔNG ĐƯỢC chứa SĐT đầy đủ hay secret/token, kể cả khi caller lỡ nhét vào.
 * Phòng thủ nhiều lớp: (1) khoá nhìn như secret → bỏ giá trị, (2) khoá nhìn như SĐT → che, (3) mọi chuỗi
 * được quét dãy số kiểu SĐT + Bearer token + chuỗi token dài, (4) cắt độ sâu/độ dài.
 */

const SECRET_KEY = /(secret|token|password|passwd|authorization|api[_-]?key|signature|cookie|credential|verifier|private)/i
const PHONE_KEY = /(phone|sdt|mobile|msisdn|tel$)/i
const REDACTED = '[redacted]'
const MAX_DEPTH = 4
const MAX_KEYS = 30
const MAX_ITEMS = 20
export const MAX_STRING = 300
export const MAX_ERROR = 500

/** `0912345678` → `***678` (cùng quy ước với `maskPhone`). */
function maskDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return `***${digits.slice(-3)}`
}

/** Dãy ≥ 9 chữ số (cho phép + khoảng trắng . -) coi là SĐT/định danh → che. */
const DIGIT_RUN = /\+?\d[\d\s.\-]{7,}\d/g
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g

export function sanitizeText(input: string, max = MAX_STRING): string {
  const cleaned = input
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(DIGIT_RUN, (m) => (m.replace(/\D/g, '').length >= 9 ? maskDigits(m) : m))
    .replace(LONG_TOKEN, REDACTED)
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}

function sanitizeValue(key: string, value: unknown, depth: number): unknown {
  if (SECRET_KEY.test(key)) return REDACTED
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return PHONE_KEY.test(key) ? maskDigits(value) : sanitizeText(value)
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => sanitizeValue(key, v, depth + 1))
  if (typeof value === 'object') return sanitizeObject(value as Record<string, unknown>, depth + 1)
  return undefined
}

function sanitizeObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj).slice(0, MAX_KEYS)) {
    const clean = sanitizeValue(k, v, depth)
    if (clean !== undefined) out[k] = clean
  }
  return out
}

/** `metadata` an toàn để lưu (luôn là object JSON thuần). */
export function sanitizeMetadata(meta: Record<string, unknown> | null | undefined): Prisma.InputJsonObject {
  if (!meta) return {}
  return sanitizeObject(meta, 0) as Prisma.InputJsonObject
}
