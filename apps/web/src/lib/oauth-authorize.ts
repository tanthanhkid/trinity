/**
 * Màn đồng ý OAuth — hàm thuần, KHÔNG tin bất kỳ giá trị nào từ URL: chỉ lấy đúng 8 tham số chuẩn, cắt độ dài,
 * và chỉ cho điều hướng ra ngoài tới `https:` (hoặc `http:` loopback). Điểm quyết định vẫn là BE (kiểm lại mọi tham số).
 */
export const AUTHORIZE_PARAM_KEYS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const

export type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_PARAM_KEYS)[number], string>>

const MAX_PARAM_LEN = 4096

export function readAuthorizeParams(search: { get(name: string): string | null }): AuthorizeParams {
  const out: AuthorizeParams = {}
  for (const key of AUTHORIZE_PARAM_KEYS) {
    const v = search.get(key)
    if (typeof v === "string" && v !== "" && v.length <= MAX_PARAM_LEN) out[key] = v
  }
  return out
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/** URL để trình duyệt chuyển về client: chỉ https, hoặc http tới loopback (Claude Code). Khác ⇒ null (không điều hướng). */
export function safeExternalRedirect(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.username || u.password) return null
  if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))) return u.toString()
  return null
}

/**
 * Đường dẫn `next` sau đăng nhập: CHỈ `/oauth/authorize` (+ query). Mọi thứ khác (URL tuyệt đối, `//host`, `\`, đường dẫn
 * khác) ⇒ null ⇒ về `/dashboard` — không dùng `next` làm open redirect.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (typeof next !== "string" || next.length === 0 || next.length > 8192) return null
  if (next.includes("\\") || next.includes("\n") || next.includes("\r")) return null
  if (!/^\/oauth\/authorize(\?|$)/.test(next)) return null
  return next
}

export function loginPathWithNext(pathAndSearch: string): string {
  const safe = safeNextPath(pathAndSearch)
  return safe ? `/login?next=${encodeURIComponent(safe)}` : "/login"
}
