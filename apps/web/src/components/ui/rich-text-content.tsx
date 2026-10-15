"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

interface RichTextContentProps {
  html: string
  className?: string
}

export function RichTextContent({ html, className }: RichTextContentProps) {
  const source = React.useMemo(() => normalizeLegacyEntities(html ?? ""), [html])
  const safe = React.useMemo(() => sanitizeHtml(source), [source])
  const finalHtml = isHtmlContent(source) ? safe : plainTextToHtml(source)
  return (
    <div
      suppressHydrationWarning
      className={cn(
        "leading-7 text-[15px] text-gray-800 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
        className,
      )}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: finalHtml }}
    />
  )
}

const ALLOWED_TAGS = new Set([
  "B", "STRONG", "I", "EM", "U", "SPAN", "BR", "P", "DIV",
  "UL", "OL", "LI",
  "FONT", // execCommand may emit <font color="...">
  "A", // liên kết đính kèm — href sanitize riêng, xem sanitizeHref()
])

const ALLOWED_STYLE_PROPS = new Set([
  "color", "background-color", "font-weight", "font-style",
  "text-decoration", "text-decoration-line",
])

// Allow hex, rgb(), rgba(), or named CSS colors
const SAFE_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|[a-z]+)/

// Chỉ chấp nhận href http/https tuyệt đối — chặn `javascript:`/`data:`/
// `vbscript:`... (stored XSS qua link chèn vào bài đăng).
function sanitizeHref(value: string): string | null {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.href
  } catch {
    return null
  }
}

export function sanitizeHtml(input: string): string {
  if (typeof window === "undefined") return ""
  const tpl = document.createElement("template")
  tpl.innerHTML = input
  walk(tpl.content)
  return tpl.innerHTML
}

function walk(node: Node) {
  // Duyệt theo con trỏ sống: khi unwrap một thẻ, các con được chuyển ra cha
  // phải được walk lại (nếu không, `<a><img onerror>` lọt qua → stored XSS).
  let cursor: ChildNode | null = node.firstChild
  while (cursor) {
    const child: ChildNode = cursor
    cursor = child.nextSibling
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element
      const tag = el.tagName
      if (!ALLOWED_TAGS.has(tag)) {
        cursor = unwrap(el) ?? cursor
        continue
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        if (name === "style") {
          el.setAttribute("style", sanitizeStyle(attr.value))
        } else if (tag === "FONT" && name === "color") {
          if (!SAFE_COLOR_RE.test(attr.value.trim())) el.removeAttribute(attr.name)
        } else if (tag === "A" && name === "href") {
          const safe = sanitizeHref(attr.value)
          if (safe) el.setAttribute("href", safe)
          else el.removeAttribute(attr.name)
        } else {
          // target/rel (nếu có) bị bỏ ở đây rồi ép lại giá trị an toàn cố
          // định ngay dưới — KHÔNG tin giá trị client gửi lên cho 2 attr này.
          el.removeAttribute(attr.name)
        }
      }
      if (tag === "A") {
        if (el.hasAttribute("href")) {
          el.setAttribute("target", "_blank")
          el.setAttribute("rel", "noopener noreferrer")
        } else {
          // Link không có href hợp lệ (bị lọc ở trên) — bỏ thẻ, giữ text con.
          cursor = unwrap(el) ?? cursor
          continue
        }
      }
      walk(el)
    } else if (child.nodeType === Node.COMMENT_NODE) {
      child.parentNode?.removeChild(child)
    }
  }
}

// Chuyển các con của `el` ra trước `el` rồi xoá `el`. Trả về con đầu tiên đã
// chuyển (để caller walk lại từ đó), hoặc null nếu `el` không có con.
function unwrap(el: Element): ChildNode | null {
  const first = el.firstChild
  while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el)
  el.remove()
  return first
}

function sanitizeStyle(style: string): string {
  return style
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":")
      if (idx < 0) return ""
      const prop = part.slice(0, idx).trim().toLowerCase()
      const val = part.slice(idx + 1).trim()
      if (!ALLOWED_STYLE_PROPS.has(prop)) return ""
      if (/url\s*\(|expression\s*\(|javascript:/i.test(val)) return ""
      return `${prop}: ${val}`
    })
    .filter(Boolean)
    .join("; ")
}

// Closing tags are the strongest signal of intentional HTML from the editor.
// Single orphan opening tag (e.g. user typed "<br>") is treated as plain text.
// Dữ liệu cũ có thể bị escape 2 lần (`&amp;nbsp;`) → hiện nguyên chữ "&nbsp;".
// Đưa về khoảng trắng thường trước khi render.
export function normalizeLegacyEntities(s: string): string {
  return s.replace(/&amp;nbsp;/gi, " ")
}

export function isHtmlContent(s: string | null | undefined): boolean {
  if (!s) return false
  if (/<\/(?:b|strong|i|em|u|span|p|div|ul|ol|li|font|a)>/i.test(s)) return true
  if (/<(?:span|div|p|font|a)\s[^>]*>/i.test(s)) return true
  // Editor (contenteditable) nhả "text&nbsp;" không kèm thẻ nào → vẫn là HTML,
  // nếu coi là plain text thì `&` bị escape và lộ chữ "&nbsp;".
  if (/&nbsp;/i.test(s)) return true
  const brMatches = s.match(/<br\s*\/?>/gi)
  return brMatches !== null && brMatches.length >= 2
}

export function plainTextToHtml(s: string): string {
  return escapeHtml(s).replace(/\n/g, "<br>")
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
