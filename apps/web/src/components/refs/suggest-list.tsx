"use client"

import { Loader2 } from "lucide-react"
import type { RefView } from "@/lib/refs/mentions"
import { cn } from "@/lib/utils"

/**
 * Danh sách gợi ý thẻ @ (dùng chung cho ô soạn thảo và trường Liên kết). Mỗi dòng: `SP001 · Sản phẩm mẫu · Sản phẩm`.
 * Chọn bằng chuột dùng `onMouseDown` + preventDefault để ô soạn thảo KHÔNG mất con trỏ trước khi chèn thẻ.
 */
export function SuggestList({ id, items, active, loading, onPick, onHover, className }: {
  id: string
  items: RefView[]
  active: number
  loading?: boolean
  onPick: (v: RefView) => void
  onHover: (i: number) => void
  className?: string
}) {
  return (
    <div className={cn("absolute left-0 right-0 z-50 mt-1 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg", className)}>
      {loading && items.length === 0 && <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tìm…</div>}
      {!loading && items.length === 0 && <div className="p-2 text-sm text-muted-foreground">Không có bản ghi phù hợp (gõ mã như SP001 hoặc tên)</div>}
      <ul id={id} role="listbox" aria-label="Gợi ý gắn thẻ">
        {items.map((v, i) => (
          <li key={v.ref} id={`${id}-${i}`} role="option" aria-selected={i === active} data-testid="ref-suggestion"
            className={cn("flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm", i === active && "bg-muted")}
            onMouseDown={(e) => { e.preventDefault(); onPick(v) }} onMouseEnter={() => onHover(i)}>
            <span className="w-16 shrink-0 font-mono text-xs font-semibold text-primary">{v.code ?? "—"}</span>
            <span className="min-w-0 flex-1 truncate">{v.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{v.table}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
