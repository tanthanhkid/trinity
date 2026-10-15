/** Gắn UTM vào liên kết — bản xem trước phía web, cùng luật với `services/crm/src/social/social-utm.ts` (máy chủ mới là nơi gắn thật). */
export interface UtmChoice {
  on: boolean
  /** Rỗng = dùng tên mặc định (`defaultCampaign`). */
  campaign: string
  content: string
}

export const EMPTY_UTM_CHOICE: UtmChoice = { on: false, campaign: "", content: "" }

const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "”", "’", "…", ">", "*", "~", "`", "|", "。", "，", "、", "；", "：", "！", "？", "）", "】", "」"])
const MAX_URL = 2048
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" }
const LINK = /https?:\/\/[^\s<>"]+/gi

/** Chữ → slug không dấu, tối đa `words` từ đầu. */
export function slugOf(text: string, words = 4): string {
  const s = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    // Bỏ liên kết trước, không thì slug thành "https-shop".
    .replace(LINK, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, words)
    .join("-")
  return s.slice(0, 60)
}

const pad = (n: number) => String(n).padStart(2, "0")

/** Tên chiến dịch mặc định: vài từ đầu của nội dung, không có chữ thì `bai-yyyy-mm-dd`. */
export function defaultCampaign(content: string, now = new Date()): string {
  return slugOf(content) || `bai-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Cấu hình gửi lên máy chủ (campaign đã chuẩn hoá: trim, khoảng trắng → "-"); tắt ⇒ null. */
export function utmPayload(u: UtmChoice, content: string, now = new Date()): { campaign: string; content?: string } | null {
  if (!u.on) return null
  const campaign = (u.campaign.trim() || defaultCampaign(content, now)).replace(/\s+/g, "-").slice(0, 100)
  const c = u.content.trim().replace(/\s+/g, "-").slice(0, 100)
  return c ? { campaign, content: c } : { campaign }
}

function trimTail(url: string): string {
  const count: Record<string, number> = {}
  for (const ch of url) if (ch in CLOSERS || Object.values(CLOSERS).includes(ch)) count[ch] = (count[ch] ?? 0) + 1
  let end = url.length
  while (end > 0) {
    const last = url[end - 1]
    if (TRAILING.has(last)) end--
    else if (CLOSERS[last] && (count[last] ?? 0) > (count[CLOSERS[last]] ?? 0)) {
      count[last]--
      end--
    } else break
  }
  return url.slice(0, end)
}

function tag(url: string, params: URLSearchParams): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  for (const k of parsed.searchParams.keys()) if (k.toLowerCase().startsWith("utm_")) return url
  const h = url.indexOf("#")
  const base = h >= 0 ? url.slice(0, h) : url
  const sep = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&"
  return `${base}${sep}${params.toString()}${h >= 0 ? url.slice(h) : ""}`
}

export function utmParams(network: string, u: { campaign: string; content?: string }): URLSearchParams {
  const p = new URLSearchParams({ utm_source: network, utm_medium: "social", utm_campaign: u.campaign })
  if (u.content) p.set("utm_content", u.content)
  return p
}

/** Văn bản sau khi gắn UTM cho một mạng (null ⇒ nguyên văn). */
export function withUtm(text: string, network: string, u: { campaign: string; content?: string } | null): string {
  if (!u) return text
  const p = utmParams(network, u)
  return text.replace(LINK, (m) => {
    if (m.length > MAX_URL) return m
    const url = trimTail(m)
    return tag(url, p) + m.slice(url.length)
  })
}

/** Liên kết đầu tiên của văn bản sau UTM; không có liên kết ⇒ null. */
export function firstLinkWithUtm(text: string, network: string, u: { campaign: string; content?: string } | null): string | null {
  const m = new RegExp(LINK.source, "i").exec(text)
  return m ? withUtm(trimTail(m[0]), network, u) : null
}

/** Nháp / bài đã lưu: lấy UTM từ `options.utm` của kênh đầu có cấu hình. */
export function utmChoiceFromTargets(targets: Array<{ options?: Record<string, unknown> | null }>): UtmChoice | null {
  for (const t of targets) {
    const u = t.options?.utm
    if (u && typeof u === "object" && typeof (u as { campaign?: unknown }).campaign === "string") {
      const c = u as { campaign: string; content?: unknown }
      return { on: true, campaign: c.campaign, content: typeof c.content === "string" ? c.content : "" }
    }
  }
  return null
}
