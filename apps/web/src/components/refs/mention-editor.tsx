"use client"

import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from "react"
import { useRouter } from "next/navigation"
import { useRefSuggest, useResolvedCodes } from "@/hooks/refs/use-refs"
import {
  caretText, chipBeforeCaret, makeChip, placeCaretAtEnd, renderValue, replaceWithChip, serialize, updateChipLabels,
} from "@/lib/refs/editor-dom"
import { findMentionQuery, mentionCodes, tagPastedCodes, type RefView } from "@/lib/refs/mentions"
import { cn } from "@/lib/utils"
import { SuggestList } from "./suggest-list"

export interface MentionEditorProps {
  id?: string
  value: string | undefined
  onChange: (next: string | undefined) => void
  invalid?: boolean
  placeholder?: string
  /** Chiều cao tối thiểu theo số dòng (giống Textarea rows). */
  rows?: number
  disabled?: boolean
  maxLength?: number
  /** Gọi khi ô mất tiêu điểm (vd lưu ngay). */
  onBlur?: () => void
  /** Ctrl/⌘ + Enter (vd gửi bình luận). */
  onSubmit?: () => void
}

interface Query { query: string; node: Text; start: number; end: number }

/**
 * Ô soạn thảo chữ dài có gắn thẻ @ (dùng chung cho mọi ô chữ dài). Gõ `@` → gợi ý theo mã hoặc tên trên mọi bảng; ↑↓ chọn,
 * Enter/Tab chèn thẻ; Backspace sau thẻ xoá cả thẻ; dán `SP001` tự thành thẻ; bấm thẻ mở bản ghi. Giá trị lưu là chữ `@SP001`.
 */
export function MentionEditor({ id, value, onChange, invalid, placeholder, rows = 4, disabled, maxLength = 10000, onBlur, onSubmit }: MentionEditorProps) {
  const router = useRouter()
  const listId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const emitted = useRef<string | null>(null)
  const [q, setQ] = useState<Query | null>(null)
  const [active, setActive] = useState(0)
  const [codes, setCodes] = useState<string[]>(() => mentionCodes(value ?? ""))
  const suggest = useRefSuggest(q?.query ?? "", q !== null)
  const resolved = useResolvedCodes(codes)
  const items = q ? (suggest.data ?? []) : []

  // Giá trị đổi từ NGOÀI (mở bản ghi khác, reset form) ⇒ dựng lại DOM; giá trị do chính ô này phát ra thì không đụng (giữ con trỏ).
  useEffect(() => {
    const el = ref.current
    if (!el || (value ?? "") === emitted.current) return
    renderValue(el, value ?? "", toLabels(resolved.data, codes))
    emitted.current = value ?? ""
    setCodes(mentionCodes(value ?? ""))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  useEffect(() => {
    if (ref.current && resolved.data) updateChipLabels(ref.current, toLabels(resolved.data, codes))
  }, [resolved.data, codes])

  function emit() {
    const el = ref.current
    if (!el) return
    const text = serialize(el).slice(0, maxLength)
    emitted.current = text
    onChange(text.trim() === "" ? undefined : text)
    const next = mentionCodes(text)
    if (next.join() !== codes.join()) setCodes(next)
  }

  function detect() {
    const el = ref.current
    const c = el ? caretText(el) : null
    const m = c ? findMentionQuery(c.before) : null
    setQ(m && c ? { query: m.query.trimEnd(), node: c.node, start: m.start, end: c.offset } : null)
    setActive(0)
  }

  function pick(v: RefView) {
    if (!q || !v.code) return
    const chip = makeChip(v.code, v)
    replaceWithChip(q.node, q.start, q.end, chip)
    setQ(null)
    emit()
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (q && items.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % items.length); return }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(items[Math.min(active, items.length - 1)]); return }
    }
    if (q && e.key === "Escape") { e.preventDefault(); setQ(null); return }
    if (e.key === "Backspace" && ref.current) {
      const chip = chipBeforeCaret(ref.current)
      if (chip) { e.preventDefault(); chip.remove(); emit(); return }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit(); return }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      document.execCommand("insertLineBreak")
    }
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    e.preventDefault()
    const text = e.clipboardData.getData("text/plain")
    const tagged = tagPastedCodes(text)
    if (tagged === text) { document.execCommand("insertText", false, text); return }
    const el = ref.current
    if (!el) return
    document.execCommand("insertText", false, tagged)
    const full = serialize(el)
    renderValue(el, full, toLabels(resolved.data, codes))
    placeCaretAtEnd(el)
    emit()
  }

  function onClick(e: MouseEvent<HTMLDivElement>) {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-code]")
    const href = chip?.dataset.href
    if (!href) return
    e.preventDefault()
    if (e.metaKey || e.ctrlKey) window.open(href, "_blank", "noopener")
    else router.push(href)
  }

  const empty = (value ?? "") === ""
  return (
    <div className="relative">
      <div
        ref={ref} id={id} role="textbox" aria-multiline="true" aria-invalid={invalid || undefined} aria-autocomplete="list"
        aria-controls={q ? listId : undefined} aria-activedescendant={q && items.length ? `${listId}-${active}` : undefined}
        aria-placeholder={placeholder} contentEditable={!disabled} suppressContentEditableWarning data-testid="mention-editor"
        className={cn("w-full whitespace-pre-wrap break-words rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm", disabled && "cursor-not-allowed opacity-50")}
        style={{ minHeight: `${rows * 1.5 + 1}rem` }}
        onInput={() => { emit(); detect() }} onKeyUp={(e) => { if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) detect() }}
        onKeyDown={onKeyDown} onPaste={onPaste} onClick={onClick} onBlur={() => { window.setTimeout(() => setQ(null), 150); onBlur?.() }}
      />
      {empty && placeholder && <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">{placeholder}</span>}
      {q && <SuggestList id={listId} items={items} active={active} loading={suggest.isFetching} onPick={pick} onHover={setActive} />}
    </div>
  )
}

function toLabels(data: Map<string, RefView> | undefined, codes: string[]): Map<string, RefView | null> {
  const m = new Map<string, RefView | null>()
  if (!data) return m
  for (const c of codes) m.set(c, data.get(c) ?? null)
  return m
}
