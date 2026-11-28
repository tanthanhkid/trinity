"use client"

import { useMemo, useState } from "react"
import { Minus, Plus, Receipt, Search } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { useIsPhone } from "@/hooks/use-is-phone"
import { cn } from "@/lib/utils"
import { vnd } from "@/lib/pos-format"
import type { CartLine } from "@/lib/pos-cart"
import type { PosMenu, PosMenuProduct } from "@/types/pos"

const ALL = 0

interface Props {
  menu: PosMenu
  onPick: (p: PosMenuProduct) => void
  /** Dòng trong giỏ hiện tại — để hiện số lượng đã chọn trên thẻ/hàng món. */
  lines?: CartLine[]
  /** Điện thoại: bớt một món (dòng gần nhất của món đó). Không truyền ⇒ ẩn nút "−". */
  onDec?: (productId: number) => void
}

/**
 * Lưới món theo danh mục + tìm nhanh.
 * Desktop/tablet: thẻ món cao ≥ 104px, huy hiệu số lượng góc phải. Điện thoại (<640px): danh sách
 * hàng (tên + giá, "−" khi đã chọn, "+" xanh) — bố cục riêng, đích chạm ≥ 44px.
 */
export function PosMenuGrid({ menu, onPick, lines = [], onDec }: Props) {
  const [cat, setCat] = useState<number>(ALL)
  const [q, setQ] = useState("")
  const isPhone = useIsPhone()

  const products = useMemo(() => {
    const s = q.trim().toLowerCase()
    return menu.products.filter((p) => {
      if (cat !== ALL && p.category_id !== cat) return false
      return !s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s)
    })
  }, [menu.products, cat, q])

  const qtyOf = useMemo(() => {
    const m = new Map<number, number>()
    for (const l of lines) m.set(l.product_id, (m.get(l.product_id) ?? 0) + l.quantity)
    return m
  }, [lines])

  return (
    <section aria-label="Thực đơn" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-ax-ink-3" aria-hidden />
        <Input
          variant="ax" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm món theo tên hoặc mã…"
          aria-label="Tìm món" className="h-12 pl-[42px] text-base"
        />
      </div>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Danh mục">
        {[{ id: ALL, name: "Tất cả" }, ...menu.categories].map((c) => (
          <button
            key={c.id} type="button" role="tab" aria-selected={cat === c.id} onClick={() => setCat(c.id)}
            className={cn(
              "min-h-11 shrink-0 rounded-[var(--ax-radius-chip)] border px-[18px] text-[15px] font-semibold tracking-[-0.011em] transition-colors focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
              cat === c.id
                ? "border-[var(--ax-primary-soft-border)] bg-ax-primary-soft text-ax-primary-ink"
                : "border-ax-line bg-ax-surface text-ax-ink hover:bg-ax-hover",
            )}
          >
            {c.name}
          </button>
        ))}
      </div>
      {products.length === 0 ? (
        <EmptyState variant="ax" icon={Receipt} title="Không có món phù hợp." message="Thử gõ ngắn hơn hoặc chọn Tất cả." />
      ) : isPhone ? (
        <ul className="-mx-4 flex-1 overflow-y-auto border-y border-ax-divider bg-ax-surface">
          {products.map((p) => {
            const n = qtyOf.get(p.id) ?? 0
            return (
              <li key={p.id} className={cn("flex min-h-[68px] items-center gap-2 border-b border-ax-divider py-2 pl-4 pr-3 last:border-b-0", n > 0 && "bg-ax-primary-soft/50")}>
                <button type="button" onClick={() => onPick(p)} className="min-h-14 min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]">
                  <span className="block truncate text-base font-semibold tracking-[-0.011em] text-ax-ink">{p.name}</span>
                  <span className="ax-amount block text-[15px] text-ax-ink-2">{vnd(p.price)}</span>
                </button>
                {n > 0 && onDec && (
                  <>
                    <button type="button" aria-label={`Giảm ${p.name}`} onClick={() => onDec(p.id)} className="grid size-11 place-items-center rounded-[10px] border border-ax-btn-border bg-ax-surface text-ax-ink shadow-ax-card focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]"><Minus className="size-[18px]" aria-hidden /></button>
                    <span className="ax-amount w-6 text-center text-lg font-bold" aria-label={`${n} đã chọn`}>{n}</span>
                  </>
                )}
                <button type="button" aria-label={`Thêm ${p.name}`} onClick={() => onPick(p)} className="grid size-12 shrink-0 place-items-center rounded-[10px] text-white ax-grad-primary shadow-[var(--ax-shadow-primary)] focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]"><Plus className="size-5" aria-hidden /></button>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(168px,1fr))] content-start gap-2.5 overflow-y-auto p-1">
          {products.map((p) => {
            const n = qtyOf.get(p.id) ?? 0
            return (
              <button
                key={p.id} type="button" onClick={() => onPick(p)}
                className={cn(
                  "relative flex min-h-[104px] flex-col justify-between gap-2 rounded-ax-field border-[1.5px] px-3.5 py-3 text-left shadow-ax-card transition active:scale-[0.98] hover:border-ax-primary focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
                  n > 0 ? "border-ax-primary bg-ax-primary-soft" : "border-ax-line bg-ax-surface",
                )}
              >
                <span className="pr-7 text-[15px] font-semibold leading-[1.3] tracking-[-0.011em] text-ax-ink line-clamp-2">{p.name}</span>
                <span className="ax-amount text-[17px] font-bold text-ax-primary-ink">{vnd(p.price)}</span>
                {n > 0 && (
                  <span className="ax-amount absolute right-2.5 top-2.5 grid h-7 min-w-7 place-items-center rounded-full bg-ax-primary px-1.5 text-sm font-bold text-white" aria-label={`${n} đã chọn`}>{n}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
