"use client"

import { useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { Loader2, X } from "lucide-react"
import { useRefPreview } from "@/hooks/refs/use-refs"
import type { RefView } from "@/lib/refs/mentions"
import { cn } from "@/lib/utils"

export const CHIP_CLASS = "inline-flex max-w-full items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 align-baseline text-sm text-primary"

/** Ô xem nhanh khi rê chuột: vài trường của bản ghi (BE lọc quyền + che SĐT). Nằm INLINE (không portal). */
function PreviewCard({ view }: { view: RefView }) {
  const q = useRefPreview(view.type, view.id, true)
  return (
    <span role="tooltip" className="absolute left-0 top-full z-50 mt-1 block w-64 rounded-xl border bg-popover p-3 text-left text-sm text-popover-foreground shadow-lg" data-testid="ref-preview">
      <span className="block text-xs text-muted-foreground">{view.table}{view.code ? ` · ${view.code}` : ""}</span>
      <span className="block font-semibold">{view.title}</span>
      {q.isLoading && <Loader2 className="mt-2 size-4 animate-spin" aria-label="Đang tải" />}
      {q.data?.fields.map((f) => (
        <span key={f.label} className="mt-1 flex gap-1 text-xs"><span className="shrink-0 text-muted-foreground">{f.label}:</span><span className="truncate">{f.value}</span></span>
      ))}
    </span>
  )
}

/**
 * Thẻ một bản ghi (SP001 Sản phẩm mẫu): bấm mở bản ghi, rê chuột xem nhanh. `view` null = mã không tìm thấy / ngoài quyền xem
 * ⇒ chỉ hiện mã, không link, không lộ gì thêm.
 */
export function RefChip({ code, view, pending, onRemove, className }: { code?: string | null; view: RefView | null; pending?: boolean; onRemove?: () => void; className?: string }) {
  const [hover, setHover] = useState(false)
  const timer = useRef<number | null>(null)
  if (pending) return <span className={cn(CHIP_CLASS, className)}><span className="font-mono text-xs font-semibold">{code}</span>{onRemove && <RemoveButton onRemove={onRemove} label={code ?? ""} />}</span>
  if (!view) {
    return (
      <span className={cn(CHIP_CLASS, "border-dashed border-muted-foreground/40 bg-muted text-muted-foreground", className)} title="Không tìm thấy hoặc bạn không có quyền xem" data-testid="ref-chip-missing">
        {code ?? "Không xem được"}
        {onRemove && <RemoveButton onRemove={onRemove} label={code ?? ""} />}
      </span>
    )
  }
  const body: ReactNode = (
    <>
      {view.code && <span className="font-mono text-xs font-semibold">{view.code}</span>}
      <span className="truncate">{view.title}</span>
    </>
  )
  const enter = () => { timer.current = window.setTimeout(() => setHover(true), 350) }
  const leave = () => { if (timer.current) window.clearTimeout(timer.current); setHover(false) }
  return (
    <span className="relative inline-flex max-w-full" onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave}>
      {view.href
        ? <Link href={view.href} className={cn(CHIP_CLASS, "hover:bg-primary/20", className)} data-testid="ref-chip" onClick={(e) => e.stopPropagation()}>{body}</Link>
        : <span className={cn(CHIP_CLASS, className)} data-testid="ref-chip">{body}</span>}
      {onRemove && <RemoveButton onRemove={onRemove} label={view.code ?? view.title} />}
      {hover && <PreviewCard view={view} />}
    </span>
  )
}

function RemoveButton({ onRemove, label }: { onRemove: () => void; label: string }) {
  return (
    <button type="button" className="ml-0.5 inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Bỏ thẻ ${label}`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove() }}>
      <X className="size-3.5" />
    </button>
  )
}
