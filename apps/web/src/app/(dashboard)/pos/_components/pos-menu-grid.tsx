"use client"

import { useMemo, useState } from "react"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { vnd } from "@/lib/pos-format"
import type { PosMenu, PosMenuProduct } from "@/types/pos"

const ALL = 0

/** Lưới món theo danh mục + tìm nhanh. Thẻ món cao ≥ 88px (đích chạm ≥ 44px cho tablet). */
export function PosMenuGrid({ menu, onPick }: { menu: PosMenu; onPick: (p: PosMenuProduct) => void }) {
  const [cat, setCat] = useState<number>(ALL)
  const [q, setQ] = useState("")

  const products = useMemo(() => {
    const s = q.trim().toLowerCase()
    return menu.products.filter((p) => {
      if (cat !== ALL && p.category_id !== cat) return false
      return !s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s)
    })
  }, [menu.products, cat, q])

  return (
    <section aria-label="Thực đơn" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm món theo tên hoặc mã…"
          aria-label="Tìm món" className="h-11 pl-9 text-base"
        />
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Danh mục">
        {[{ id: ALL, name: "Tất cả" }, ...menu.categories].map((c) => (
          <button
            key={c.id} type="button" role="tab" aria-selected={cat === c.id} onClick={() => setCat(c.id)}
            className={cn(
              "min-h-11 shrink-0 rounded-full border px-4 text-sm font-semibold transition-colors",
              cat === c.id ? "border-primary/30 bg-primary/10 text-[var(--color-app-primary-ink)]" : "border-border bg-background text-foreground hover:bg-muted",
            )}
          >
            {c.name}
          </button>
        ))}
      </div>
      {products.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Không có món phù hợp.</p>
      ) : (
        <div className="grid flex-1 auto-rows-min grid-cols-2 content-start gap-2.5 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
          {products.map((p) => (
            <button
              key={p.id} type="button" onClick={() => onPick(p)}
              className="flex min-h-[88px] flex-col justify-between gap-1 rounded-[var(--radius)] border bg-card p-3 text-left shadow-sm transition active:scale-[0.98] hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"
            >
              <span className="line-clamp-2 text-sm font-semibold text-foreground">{p.name}</span>
              <span className="text-base font-bold tabular-nums text-primary">{vnd(p.price)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
