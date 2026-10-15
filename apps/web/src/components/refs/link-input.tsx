"use client"

import { useId, useState, type ClipboardEvent, type KeyboardEvent } from "react"
import { useRefSuggest, useResolvedCodes } from "@/hooks/refs/use-refs"
import { codesInPastedText, normalizeCode, type RefView } from "@/lib/refs/mentions"
import { cn } from "@/lib/utils"
import type { CustomRelationLabel } from "@/types/custom-objects"
import { RefChip } from "./ref-chip"
import { SuggestList } from "./suggest-list"

export interface LinkInputProps {
  id?: string
  /** Thẻ đã chọn: `loại:id` (đã lưu) hoặc mã (vừa dán, BE đổi thành `loại:id` khi lưu). */
  value: string[] | undefined
  onChange: (next: string[] | undefined) => void
  /** Nhãn của thẻ đã lưu (BE trả trong `relations`). */
  labels?: CustomRelationLabel[]
  invalid?: boolean
  max?: number
}

function labelToView(l: CustomRelationLabel): RefView | null {
  if (!l.accessible || l.title === null || !l.type) return null
  return { type: l.type, id: l.id, ref: `${l.type}:${l.id}`, code: l.code ?? null, title: l.title, table: l.table ?? "", href: l.href ?? null }
}

/**
 * Trường "Liên kết": nhiều thẻ tới bản ghi ở BẤT KỲ bảng nào (không ràng buộc). Gõ mã/tên (có hay không "@") → gợi ý, ↑↓ +
 * Enter/Tab chọn; Backspace ở ô trống bỏ thẻ cuối; dán "SP001, KH002" thành thẻ. BE kiểm người ghi thấy được bản ghi đích.
 */
export function LinkInput({ id, value, onChange, labels = [], invalid, max = 50 }: LinkInputProps) {
  const listId = useId()
  const [text, setText] = useState("")
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [known, setKnown] = useState<Record<string, RefView>>(() =>
    Object.fromEntries(labels.map(labelToView).filter((v): v is RefView => !!v).map((v) => [v.ref, v])))
  const tokens = value ?? []
  const codes = tokens.filter((t) => !t.includes(":"))
  const resolved = useResolvedCodes(codes)
  const query = text.trim().replace(/^@/, "")
  const suggest = useRefSuggest(query, open)
  const items = (suggest.data ?? []).filter((v) => !tokens.includes(v.ref) && !(v.code && tokens.includes(v.code)))

  function set(next: string[]) { onChange(next.length ? next.slice(0, max) : undefined) }

  function pick(v: RefView) {
    setKnown((k) => ({ ...k, [v.ref]: v }))
    set([...tokens, v.ref])
    setText("")
    setActive(0)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (open && items.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % items.length); return }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return }
      if (e.key === "Enter" || (e.key === "Tab" && query)) { e.preventDefault(); pick(items[Math.min(active, items.length - 1)]); return }
    }
    if (e.key === "Enter") e.preventDefault()
    if (e.key === "Escape") setOpen(false)
    if (e.key === "Backspace" && text === "" && tokens.length) { e.preventDefault(); set(tokens.slice(0, -1)) }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const found = codesInPastedText(e.clipboardData.getData("text/plain"))
    if (found.length === 0) return
    e.preventDefault()
    set([...tokens, ...found.filter((c) => !tokens.includes(c))])
  }

  return (
    <div className="relative">
      <div className={cn("flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input px-2 py-1.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50", invalid && "border-destructive")} data-testid="link-input">
        {tokens.map((t) => {
          const code = normalizeCode(t)
          const view = code ? (resolved.data?.get(code) ?? null) : (known[t] ?? null)
          return <RefChip key={t} code={code ?? t} view={view} pending={!!code && resolved.isLoading} onRemove={() => set(tokens.filter((x) => x !== t))} />
        })}
        <input
          id={id} value={text} placeholder={tokens.length ? "" : "Gõ mã (SP001) hoặc tên để gắn thẻ…"} autoComplete="off"
          role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-invalid={invalid || undefined}
          aria-activedescendant={open && items.length ? `${listId}-${active}` : undefined}
          className="min-w-32 flex-1 bg-transparent py-1 text-base outline-none md:text-sm"
          onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0) }}
          onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown} onPaste={onPaste}
        />
      </div>
      {open && <SuggestList id={listId} items={items} active={active} loading={suggest.isFetching} onPick={pick} onHover={setActive} />}
    </div>
  )
}
