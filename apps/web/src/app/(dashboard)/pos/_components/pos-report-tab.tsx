"use client"

import { useState } from "react"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { VnDateInput } from "@/components/ui/vn-date-input"
import { usePosDailyReport } from "@/hooks/pos/use-pos"
import { todayVn } from "@/lib/format"
import { vnd } from "@/lib/pos-format"

const METHOD_LABEL = { cash: "Tiền mặt", bank_transfer: "Chuyển khoản" } as const

/** Báo cáo doanh thu 1 ngày (giờ VN): tổng, theo phương thức, theo món, theo giờ. Chỉ đơn đã thanh toán. */
export function PosReportTab() {
  const [date, setDate] = useState(todayVn())
  const q = usePosDailyReport(date)
  const r = q.data
  const maxHour = Math.max(1, ...(r?.by_hour.map((h) => h.revenue) ?? [1]))
  const stat = (label: string, value: string) => (
    <div className="rounded-lg border bg-card p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-xl font-bold tabular-nums text-foreground">{value}</dd></div>
  )
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label htmlFor="pos-report-date" className="text-sm font-medium text-foreground">Ngày</label>
        <VnDateInput id="pos-report-date" value={date} onChange={(v) => v && setDate(v)} className="w-44 max-sm:w-full" inputClassName="h-11" />
      </div>
      {q.isLoading && <LoadingBlock variant="cards" count={2} label="Đang tải báo cáo…" />}
      {q.isError && !q.data && <ErrorState title="Không tải được báo cáo ngày" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {r && (
        <>
          <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {stat("Doanh thu", vnd(r.revenue))}{stat("Số đơn", String(r.order_count))}
            {stat("Trung bình / đơn", vnd(r.avg_order_value))}{stat("Giảm giá", vnd(r.discount))}
          </dl>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-[var(--radius)] border bg-card p-3" aria-label="Theo phương thức">
              <h2 className="mb-2 text-base font-bold text-foreground">Theo phương thức thanh toán</h2>
              {r.by_method.length === 0 && <p className="text-sm text-muted-foreground">Chưa có giao dịch.</p>}
              {r.by_method.map((m) => <div key={m.method} className="flex justify-between py-1 text-sm"><span>{METHOD_LABEL[m.method]}</span><span className="font-semibold tabular-nums">{vnd(m.amount)}</span></div>)}
            </section>
            <section className="rounded-[var(--radius)] border bg-card p-3" aria-label="Theo giờ">
              <h2 className="mb-2 text-base font-bold text-foreground">Theo giờ</h2>
              {r.by_hour.length === 0 && <p className="text-sm text-muted-foreground">Chưa có giao dịch.</p>}
              {r.by_hour.map((h) => (
                <div key={h.hour} className="flex items-center gap-2 py-0.5 text-xs">
                  <span className="w-10 tabular-nums">{String(h.hour).padStart(2, "0")}h</span>
                  <div className="h-3 flex-1 rounded bg-muted"><div className="h-3 rounded bg-primary" style={{ width: `${Math.round((h.revenue / maxHour) * 100)}%` }} /></div>
                  <span className="w-24 text-right tabular-nums">{vnd(h.revenue)}</span>
                </div>
              ))}
            </section>
          </div>
          <section className="rounded-[var(--radius)] border bg-card" aria-label="Theo món">
            <h2 className="border-b p-3 text-base font-bold text-foreground">Theo món</h2>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr><th className="p-2">Món</th><th className="p-2 text-right">SL</th><th className="p-2 text-right">Doanh thu</th></tr></thead>
              <tbody className="divide-y">
                {r.by_product.map((p) => <tr key={p.product_id}><td className="p-2">{p.product_name}</td><td className="p-2 text-right tabular-nums">{p.quantity}</td><td className="p-2 text-right tabular-nums">{vnd(p.revenue)}</td></tr>)}
                {r.by_product.length === 0 && <tr><td colSpan={3} className="p-6 text-center text-muted-foreground">Chưa có món nào bán.</td></tr>}
              </tbody>
            </table>
            <p className="p-2 text-xs text-muted-foreground">Doanh thu theo món tính trước giảm giá cấp đơn{r.by_product_truncated ? "; chỉ hiện 50 món đầu" : ""}.</p>
          </section>
        </>
      )}
    </div>
  )
}
