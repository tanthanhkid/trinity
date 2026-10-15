"use client"

import * as React from "react"
import { Bold, Italic, Underline, RemoveFormatting, Link as LinkIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { isHtmlContent, normalizeLegacyEntities, plainTextToHtml, sanitizeHtml } from "./rich-text-content"

// Chấp nhận URL không nhập scheme (tự thêm https://); CHỈ cho http/https —
// chặn `javascript:`/`data:` chèn qua ô nhập link (đối xứng
// sanitizeHref() trong rich-text-content.tsx — nơi đó chặn nội dung HTML
// nhận từ NGƯỜI KHÁC, đây chặn ngay tại điểm NGƯỜI DÙNG NÀY nhập).
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.href
  } catch {
    return null
  }
}

const COLORS = [
  { value: "#111827", label: "Đen" },
  { value: "#dc2626", label: "Đỏ" },
  { value: "#2563eb", label: "Xanh dương" },
  { value: "#198754", label: "Xanh lá" },
  { value: "#d97706", label: "Cam" },
  { value: "#7c3aed", label: "Tím" },
]

const HIGHLIGHTS = [
  { value: "transparent", label: "Bỏ tô nền" },
  { value: "#fef08a", label: "Vàng" },
  { value: "#bbf7d0", label: "Xanh nhạt" },
  { value: "#fecaca", label: "Hồng" },
  { value: "#bfdbfe", label: "Xanh dương nhạt" },
]

interface RichTextEditorProps {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  className?: string
  contentClassName?: string
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = "Nhập nội dung...",
  className,
  contentClassName,
}: RichTextEditorProps) {
  const editorRef = React.useRef<HTMLDivElement | null>(null)
  const lastEmittedRef = React.useRef<string>("")
  const [isEmpty, setIsEmpty] = React.useState(!value || value.trim() === "")
  const savedRangeRef = React.useRef<Range | null>(null)
  const [linkPopoverOpen, setLinkPopoverOpen] = React.useState(false)
  const [linkUrlInput, setLinkUrlInput] = React.useState("")
  const [linkError, setLinkError] = React.useState<string | null>(null)

  // Sync value into DOM once on mount + when form resets (value → "")
  React.useEffect(() => {
    const el = editorRef.current
    if (!el) return
    // value came from our own emit — DOM already correct, skip to avoid re-encoding
    if (value === lastEmittedRef.current) return
    // Bảo mật: `value` có thể là nội dung do NGƯỜI KHÁC tạo (vd ghi chú hoặc mô tả do
    // người dùng khác tạo) — PHẢI sanitize giống hệt RichTextContent
    // trước khi ghi vào DOM, nếu không attribute như onerror/onload sẽ CHẠY
    // NGAY khi set qua innerHTML (stored XSS khi mở form sửa).
    const source = normalizeLegacyEntities(value)
    const incoming = isHtmlContent(source) ? sanitizeHtml(source) : plainTextToHtml(source)
    if (el.innerHTML !== incoming) {
      el.innerHTML = incoming
      lastEmittedRef.current = incoming
      setIsEmpty((el.textContent ?? "").trim() === "")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function exec(command: string, arg?: string) {
    editorRef.current?.focus()
    document.execCommand(command, false, arg)
    emit()
  }

  function emit() {
    const el = editorRef.current
    if (!el) return
    const html = el.innerHTML
    lastEmittedRef.current = html
    setIsEmpty((el.textContent ?? "").trim() === "")
    onChange(html)
  }

  // Prevent toolbar clicks from stealing editor focus
  function preventBlur(e: React.MouseEvent) {
    e.preventDefault()
  }

  // Mở popover "Chèn liên kết" — lưu Range hiện tại TRƯỚC khi focus chuyển
  // sang ô nhập URL (nếu không lưu, khi user gõ vào input thì selection
  // trong contentEditable đã mất, không biết chèn link vào đâu).
  function openLinkPopover() {
    const el = editorRef.current
    const sel = window.getSelection()
    if (el) {
      if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        savedRangeRef.current = sel.getRangeAt(0).cloneRange()
      } else {
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        savedRangeRef.current = range
      }
    }
    setLinkUrlInput("")
    setLinkError(null)
    setLinkPopoverOpen(true)
  }

  function closeLinkPopover() {
    setLinkPopoverOpen(false)
    setLinkUrlInput("")
    setLinkError(null)
  }

  // Chèn `<a>` an toàn (href chuẩn hoá http/https, target=_blank,
  // rel=noopener noreferrer) tại Range đã lưu — KHÔNG dùng
  // `execCommand('createLink')` (không kiểm soát được target/rel + quirk
  // link rỗng khi selection collapsed).
  function insertLink() {
    const safeUrl = normalizeUrl(linkUrlInput)
    if (!safeUrl) {
      setLinkError("Link không hợp lệ — chỉ hỗ trợ http/https")
      return
    }
    const el = editorRef.current
    const range = savedRangeRef.current
    if (!el || !range) {
      closeLinkPopover()
      return
    }
    el.focus()
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)

    const a = document.createElement("a")
    a.href = safeUrl
    a.target = "_blank"
    a.rel = "noopener noreferrer"
    if (range.collapsed) {
      a.textContent = safeUrl
      range.insertNode(a)
    } else {
      a.appendChild(range.extractContents())
      range.insertNode(a)
    }
    range.setStartAfter(a)
    range.setEndAfter(a)
    sel.removeAllRanges()
    sel.addRange(range)

    emit()
    closeLinkPopover()
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-input bg-background overflow-hidden flex flex-col",
        className,
      )}
    >
      <div
        className="flex flex-wrap items-center gap-1 border-b bg-muted/40 px-2 py-1.5 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden"
        onMouseDown={preventBlur}
      >
        <ToolbarButton onClick={() => exec("bold")} title="In đậm (Ctrl+B)">
          <Bold className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton onClick={() => exec("italic")} title="In nghiêng (Ctrl+I)">
          <Italic className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton onClick={() => exec("underline")} title="Gạch chân (Ctrl+U)">
          <Underline className="h-4 w-4" />
        </ToolbarButton>
        <Separator />
        {/* ≥640px: ô màu inline như cũ (`contents` = không thêm hộp). <640px:
            ẩn, gom vào popover "Màu" bên dưới. */}
        <div className="contents max-sm:hidden">
          <ColorSwatches exec={exec} />
        </div>
        <div className="shrink-0 sm:hidden">
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  title="Màu chữ"
                  aria-label="Màu chữ"
                  className="inline-flex h-11 items-center gap-1 rounded-md px-2 text-sm text-gray-600 hover:bg-gray-200"
                />
              }
            >
              <span className="size-4 rounded-full border border-black/50 bg-[conic-gradient(#dc2626,#d97706,#198754,#2563eb,#7c3aed,#dc2626)]" aria-hidden />
              Màu chữ
            </PopoverTrigger>
            <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] gap-3">
              <ColorSwatches exec={exec} large />
            </PopoverContent>
          </Popover>
        </div>
        <Separator />
        <ToolbarButton onClick={() => exec("removeFormat")} title="Xoá định dạng">
          <RemoveFormatting className="h-4 w-4" />
        </ToolbarButton>
        <Separator />
        <ToolbarButton onClick={openLinkPopover} title="Chèn liên kết">
          <LinkIcon className="h-4 w-4" />
        </ToolbarButton>
      </div>

      {linkPopoverOpen && (
        <div className="flex flex-wrap items-start gap-2 border-b bg-muted/20 px-2 py-2">
          <div className="flex flex-1 min-w-[200px] flex-col gap-1">
            <input
              autoFocus
              type="text"
              value={linkUrlInput}
              onChange={(e) => {
                setLinkUrlInput(e.target.value)
                setLinkError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  insertLink()
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  closeLinkPopover()
                }
              }}
              placeholder="https://... hoặc drive.google.com/..."
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            {linkError && <span className="text-xs text-red-600">{linkError}</span>}
          </div>
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={insertLink}>
            Chèn
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-8" onClick={closeLinkPopover}>
            Huỷ
          </Button>
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        {isEmpty && (
          <div className="pointer-events-none absolute inset-0 px-4 py-3 text-muted-foreground text-base">
            {placeholder}
          </div>
        )}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label={placeholder}
          aria-multiline="true"
          onInput={emit}
          onBlur={emit}
          className={cn(
            "w-full h-full overflow-y-auto px-4 py-3 outline-none text-base leading-7 prose-sm",
            "[&_p]:my-1 [&_div]:min-h-[1.5em]",
            contentClassName,
          )}
        />
      </div>
    </div>
  )
}

function ToolbarButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md max-sm:size-11 max-sm:shrink-0 text-gray-600 hover:bg-gray-200 hover:text-gray-900"
    >
      {children}
    </button>
  )
}

function Separator() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-gray-300" aria-hidden />
}

/** Chữ + tô nền. `large` (trong popover điện thoại): ô 36px, cách nhau 8px. */
function ColorSwatches({
  exec,
  large = false,
}: {
  exec: (cmd: string, value?: string) => void
  large?: boolean
}) {
  const dot = cn(
    "rounded-full border border-black/50 outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring transition-transform",
    large ? "size-9" : "h-6 w-6",
  )
  const row = large ? "flex flex-wrap items-center gap-2" : "contents"
  return (
    <>
      <div className={row}>
        <span className="text-xs text-muted-foreground px-1">Màu chữ:</span>
        {COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            title={c.label}
            aria-label={c.label}
            data-color-swatch=""
            onClick={() => exec("foreColor", c.value)}
            className={dot}
            style={{ backgroundColor: c.value }}
          />
        ))}
      </div>
      {!large && <Separator />}
      <div className={row}>
        <span className="text-xs text-muted-foreground px-1">Tô nền:</span>
        {HIGHLIGHTS.map((c) => (
          <button
            key={c.value}
            type="button"
            title={c.label}
            aria-label={c.label}
            data-color-swatch=""
            onClick={() => exec("hiliteColor", c.value)}
            className={cn(
              dot,
              c.value === "transparent" &&
                "bg-[linear-gradient(45deg,transparent_45%,#dc2626_45%,#dc2626_55%,transparent_55%)]",
            )}
            style={c.value !== "transparent" ? { backgroundColor: c.value } : undefined}
          />
        ))}
      </div>
    </>
  )
}
