/**
 * Gắn thẻ @ giữa các màn — phần THUẦN (không DOM): định dạng mã, tách văn bản thành chữ + thẻ, dò chữ đang gõ sau "@".
 * Văn bản LƯU dạng chữ thường `… @SP001 …` (đọc được ở CSV/AI); giao diện vẽ thẻ thành chip. Khớp BE
 * `services/crm/src/custom-objects/refs/ref-types.ts` (MENTION_RE) — đổi một bên phải đổi bên kia.
 */

export type RefType = "record" | "contact" | "deal" | "task"

/** Một bản ghi người xem được thấy (BE đã lọc quyền). */
export interface RefView {
  type: RefType
  id: number
  /** `record:12` — giá trị lưu trong trường Liên kết. */
  ref: string
  code: string | null
  title: string
  table: string
  table_key?: string
  href: string | null
  /** Chỉ có ở /refs/resolve: mã người hỏi gửi lên (có thể là mã CŨ trước khi đổi tiền tố). */
  requested?: string
}

export type MentionSegment = { kind: "text"; text: string } | { kind: "code"; code: string }

/** Mã chuẩn: in hoa, đệm 3 chữ số (sp1 → SP001, SP1000 giữ nguyên). Sai dạng → null. */
export function normalizeCode(raw: string): string | null {
  const m = /^@?([A-Za-z]{2,4})(\d{1,9})$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[2])
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return `${m[1].toUpperCase()}${n < 1000 ? String(n).padStart(3, "0") : String(n)}`
}

const MENTION_RE = /(^|[^\p{L}\p{N}_@])@([A-Za-z]{2,4}\d{1,9})(?![\p{L}\p{N}_])/gu

/** "Xem @SP001 hôm nay" → [chữ "Xem ", thẻ SP001, chữ " hôm nay"]. Thẻ sai dạng giữ nguyên là chữ. */
export function splitMentions(text: string): MentionSegment[] {
  const out: MentionSegment[] = []
  let last = 0
  for (const m of text.matchAll(MENTION_RE)) {
    const code = normalizeCode(m[2])
    if (!code) continue
    const at = (m.index ?? 0) + m[1].length
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) })
    out.push({ kind: "code", code })
    last = at + 1 + m[2].length
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) })
  return out
}

/** Mọi mã được nhắc trong văn bản (chuẩn hoá, không trùng). */
export function mentionCodes(text: string): string[] {
  return [...new Set(splitMentions(text).flatMap((s) => (s.kind === "code" ? [s.code] : [])))]
}

/**
 * Chữ ngay TRƯỚC con trỏ có đang là một thẻ đang gõ không: "Xem @Nguy" → {query:"Nguy", start: vị trí "@"}.
 * "@" phải đứng đầu dòng hoặc sau khoảng trắng/ngoặc (email a@b không bật gợi ý); tối đa 3 từ, 40 ký tự.
 */
export function findMentionQuery(before: string): { query: string; start: number } | null {
  const m = /(^|[\s(])@((?:[\p{L}\p{N}_]+(?: [\p{L}\p{N}_]+){0,2} ?)?)$/u.exec(before)
  if (!m || m[2].length > 40) return null
  return { query: m[2], start: (m.index ?? 0) + m[1].length }
}

/** Mã trần trong chữ dán vào ("SP001, KH002" / "@SP001") — mã cần ≥ 3 chữ số để không nhầm chữ thường ("A1"). */
export function codesInPastedText(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_])@?([A-Za-z]{2,4}\d{3,9})(?![\p{L}\p{N}_])/gu)) {
    const c = normalizeCode(m[1])
    if (c && !out.includes(c)) out.push(c)
  }
  return out
}

/** Chữ dán vào: mã trần thành thẻ "@MÃ" (giữ chữ khác nguyên vẹn). */
export function tagPastedCodes(text: string): string {
  return text.replace(/(^|[^\p{L}\p{N}_@])([A-Z]{2,4}\d{3,9})(?![\p{L}\p{N}_])/gu, (_all, pre: string, code: string) => `${pre}@${code}`)
}

/** Đường mở bản ghi + nhãn ngắn của thẻ. */
export function chipLabel(v: Pick<RefView, "code" | "title">): string {
  return v.code ? `${v.code} ${v.title}` : v.title
}
