"use client"

import { Loader2, FileSpreadsheet, Cake } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { formatDate } from "@/lib/format"
import type { BirthdayItem } from "@/hooks/use-employees"

export function BirthdayListTable({
  month,
  items,
  isLoading,
  canExport,
  exporting,
  onExport,
}: {
  month: number
  items: BirthdayItem[]
  isLoading: boolean
  canExport: boolean
  exporting: boolean
  onExport: () => void
}) {
  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-card p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cake className="h-5 w-5 text-[var(--color-app-primary-ink)]" />
          <h2 className="text-base font-semibold">
            Danh sách sinh nhật tháng {month}
          </h2>
          <span className="text-sm text-muted-foreground">
            ({items.length} nhân viên)
          </span>
        </div>
        {canExport && (
          <Button
            variant="outline"
            size="sm"
            onClick={onExport}
            disabled={exporting || items.length === 0}
          >
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileSpreadsheet className="mr-2 h-4 w-4" />
            )}
            Xuất Excel
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Không có nhân viên nào sinh nhật trong tháng {month}.
        </p>
      ) : (
        <ShellResponsiveList
          table={
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Mã NV</th>
                <th className="py-2 pr-3 font-medium">Họ tên</th>
                <th className="py-2 pr-3 font-medium">Ngày sinh</th>
                <th className="py-2 pr-3 font-medium">Chức vụ</th>
                <th className="py-2 pr-3 font-medium">Team</th>
                <th className="py-2 pr-3 font-medium">Phòng ban</th>
                <th className="py-2 pr-3 font-medium">Email</th>
                <th className="py-2 font-medium">SĐT</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                    {r.employee_code}
                  </td>
                  <td className="py-2 pr-3 font-medium">{r.full_name ?? "—"}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {formatDate(r.birth_date)}
                  </td>
                  <td className="py-2 pr-3">{r.job_title_name ?? r.position ?? "—"}</td>
                  <td className="py-2 pr-3">{r.team_name}</td>
                  <td className="py-2 pr-3">{r.department ?? "—"}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{r.email}</td>
                  <td className="py-2 tabular-nums">{r.phone ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
          }
          cards={
            <div className="space-y-3">
              {items.map((r) => (
                <ShellListCard key={r.id}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{r.full_name ?? "—"}</span>
                    <span className="font-mono text-xs text-muted-foreground">{r.employee_code}</span>
                  </div>
                  <ShellListCardRow label="Ngày sinh" value={formatDate(r.birth_date)} />
                  <ShellListCardRow label="Chức vụ" value={r.job_title_name ?? r.position ?? "—"} />
                  <ShellListCardRow label="Team" value={r.team_name} />
                  <ShellListCardRow label="Phòng ban" value={r.department ?? "—"} />
                  <ShellListCardRow label="SĐT" value={r.phone ?? "—"} />
                </ShellListCard>
              ))}
            </div>
          }
        />
      )}
    </section>
  )
}
