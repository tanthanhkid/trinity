"use client"

import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PAGE_SIZES } from "@/hooks/custom-objects/use-custom-objects"
import { formatNumberVn } from "@/lib/custom-objects/format-value"

export interface RecordsPagerProps {
  page: number
  pageSize: number
  total: number | null
  /** Số dòng đang hiện ở trang này. */
  shown: number
  loading?: boolean
  onPage: (next: number) => void
  onPageSize: (next: number) => void
}

/** Thanh phân trang của danh sách bản ghi tuỳ biến: "Hiện a–b / tổng", Trước / Sau, số bản ghi mỗi trang. */
export function RecordsPager({ page, pageSize, total, shown, loading, onPage, onPageSize }: RecordsPagerProps) {
  const pageCount = total === null ? page : Math.max(1, Math.ceil(total / pageSize))
  const from = shown === 0 ? 0 : (page - 1) * pageSize + 1
  const to = (page - 1) * pageSize + shown
  return (
    <nav aria-label="Phân trang" className="flex flex-col items-center justify-between gap-3 pb-2 sm:flex-row">
      <p className="text-sm text-muted-foreground">
        Đang hiện {formatNumberVn(from)}–{formatNumberVn(to)}{total !== null ? ` / ${formatNumberVn(total)}` : ""}
      </p>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          Mỗi trang
          <select
            aria-label="Số bản ghi mỗi trang"
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="min-h-9 rounded-lg border border-input bg-card px-2 text-sm text-foreground"
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <Button variant="outline" onClick={() => onPage(page - 1)} disabled={page <= 1 || loading} aria-label="Trang trước" className="max-sm:min-h-11">
          <ChevronLeft className="size-4" /> Trước
        </Button>
        <span className="min-w-20 text-center text-sm" aria-live="polite">
          {loading && <Loader2 className="mr-1 inline size-3.5 animate-spin" />}Trang {page}/{pageCount}
        </span>
        <Button variant="outline" onClick={() => onPage(page + 1)} disabled={page >= pageCount || loading} aria-label="Trang sau" className="max-sm:min-h-11">
          Sau <ChevronRight className="size-4" />
        </Button>
      </div>
    </nav>
  )
}
