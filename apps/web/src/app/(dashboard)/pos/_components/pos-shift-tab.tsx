"use client"

import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { usePosShift, usePosShifts } from "@/hooks/pos/use-pos"
import { formatDateTimeVn } from "@/lib/format"
import { vnd } from "@/lib/pos-format"
import { PosCurrentShiftCard, PosOpenShiftCard } from "./pos-shift-cards"

/** Tab Ca: ca hiện tại (mở/đóng) + lịch sử ca (quản lý thấy mọi ca, người bán chỉ thấy ca của mình — BE lọc). */
export function PosShiftTab() {
  const cur = usePosShift()
  const hist = usePosShifts()
  const shifts = hist.data ?? []
  const money = (v: number | null) => (v == null ? "—" : vnd(v))
  if (cur.isLoading) return <LoadingBlock className="p-4" count={4} label="Đang tải ca…" />
  return (
    <div className="space-y-4">
      {/* Không đọc được ca hiện tại ⇒ báo lỗi, KHÔNG mời "Mở ca" (có thể đang có ca mở thật). */}
      {cur.isError && !cur.data ? (
        <ErrorState title="Không đọc được ca đang mở" error={cur.error} onRetry={() => void cur.refetch()} retrying={cur.isFetching} />
      ) : cur.data?.shift && cur.data.summary ? <PosCurrentShiftCard shift={cur.data.shift} summary={cur.data.summary} /> : <PosOpenShiftCard />}
      {hist.isError && !hist.data && <ErrorState compact title="Không tải được lịch sử ca" error={hist.error} onRetry={() => void hist.refetch()} retrying={hist.isFetching} />}
      <section aria-label="Lịch sử ca" className="rounded-[var(--radius)] border bg-card">
        <h2 className="border-b p-3 text-base font-bold text-foreground">Lịch sử ca</h2>
        <ShellResponsiveList
          table={<div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Mở ca</th><th className="p-2">Trạng thái</th><th className="p-2 text-right">Đầu ca</th><th className="p-2 text-right">Dự kiến</th><th className="p-2 text-right">Đếm được</th><th className="p-2 text-right">Chênh lệch</th></tr>
            </thead>
            <tbody className="divide-y">
              {(hist.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="p-2">{formatDateTimeVn(s.opened_at)}</td>
                  <td className="p-2">{s.status === "open" ? "Đang mở" : "Đã đóng"}</td>
                  <td className="p-2 text-right tabular-nums">{vnd(s.opening_cash)}</td>
                  <td className="p-2 text-right tabular-nums">{s.expected_cash == null ? "—" : vnd(s.expected_cash)}</td>
                  <td className="p-2 text-right tabular-nums">{s.closing_cash_counted == null ? "—" : vnd(s.closing_cash_counted)}</td>
                  <td className="p-2 text-right font-semibold tabular-nums">{s.cash_diff == null ? "—" : vnd(s.cash_diff)}</td>
                </tr>
              ))}
              {hist.data && hist.data.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Chưa có ca nào.</td></tr>}
            </tbody>
          </table></div>}
          cards={
            <div className="space-y-3 p-3">
              {shifts.map((s) => (
                <ShellListCard key={s.id}>
                  <ShellListCardRow label="Mở ca" value={formatDateTimeVn(s.opened_at)} />
                  <ShellListCardRow label="Trạng thái" value={s.status === "open" ? "Đang mở" : "Đã đóng"} />
                  <ShellListCardRow label="Đầu ca" value={<span className="tabular-nums">{vnd(s.opening_cash)}</span>} />
                  <ShellListCardRow label="Dự kiến" value={<span className="tabular-nums">{money(s.expected_cash)}</span>} />
                  <ShellListCardRow label="Đếm được" value={<span className="tabular-nums">{money(s.closing_cash_counted)}</span>} />
                  <ShellListCardRow label="Chênh lệch" value={<span className="font-semibold tabular-nums">{money(s.cash_diff)}</span>} />
                </ShellListCard>
              ))}
              {hist.data && shifts.length === 0 && <p className="p-3 text-center text-sm text-muted-foreground">Chưa có ca nào.</p>}
            </div>
          }
        />
      </section>
    </div>
  )
}
