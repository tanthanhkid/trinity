"use client"

import { UserMinus } from "lucide-react"
import type { HrStats } from "@/hooks/use-employees"

/** Biểu đồ cột ngang {nhãn → số lượng} cho 1 chiều thống kê NV đã nghỉ. */
function BreakdownBars({
  title,
  rows,
}: {
  title: string
  rows: { label: string; count: number }[]
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Không có dữ liệu</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.label} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="truncate pr-2 text-muted-foreground" title={r.label}>
                  {r.label}
                </span>
                <span className="shrink-0 font-medium tabular-nums">{r.count}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-amber-100">
                <div
                  className="h-full rounded-full bg-amber-500"
                  style={{ width: `${Math.max(6, (r.count / max) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Thống kê "Nhân viên đã nghỉ việc" (tài khoản vô hiệu hoá — users.status='locked').
 * Chia theo team cũ / phòng ban / chức vụ. Áp cùng bộ lọc với phần Team bên trên.
 * Lưu ý: team quy theo manager_id HIỆN TẠI (giữ làm liên kết lịch sử) — .
 */
export function ResignedStats({ stats }: { stats?: HrStats }) {
  const total = stats?.resigned_total ?? 0
  const byTeam = (stats?.resigned_by_team ?? []).map((t) => ({
    label: t.team_name,
    count: t.count,
  }))
  const byDepartment = stats?.resigned_by_department ?? []
  const byJobTitle = stats?.resigned_by_job_title ?? []

  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-card p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
          <UserMinus className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold">Nhân viên đã nghỉ việc</h2>
          <p className="text-sm text-muted-foreground">
            Tài khoản đã vô hiệu hoá — không tính vào số liệu team đang hoạt động.
          </p>
        </div>
        <span className="ml-auto rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-700">
          {total} người
        </span>
      </div>

      {total === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Chưa có nhân viên nào đã nghỉ việc trong phạm vi lọc.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <BreakdownBars title="Theo team cũ" rows={byTeam} />
          <BreakdownBars title="Theo phòng ban" rows={byDepartment} />
          <BreakdownBars title="Theo chức vụ" rows={byJobTitle} />
        </div>
      )}
    </section>
  )
}
