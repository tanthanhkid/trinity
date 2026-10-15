"use client"

import type { TeamStatusRow } from "@/hooks/use-employees"
import { STATUS_BUCKETS } from "./stats-shared"
import { TeamStatusBarChart } from "./team-status-bar-chart"

export function TeamStatusChart({ rows }: { rows: TeamStatusRow[] }) {
  const labels = rows.map((r) => r.team_name)
  const series = STATUS_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    color: b.color,
    values: rows.map((r) => r[b.key]),
  }))
  const hasData = rows.some(
    (r) => r.active + r.probation + r.on_leave + r.resigned + r.other > 0,
  )

  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-card p-4 shadow-[var(--shadow-card)] sm:p-5">
      <h2 className="mb-1 text-base font-semibold">
        Nhân sự theo trạng thái của từng Team
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Cột chồng: đang làm việc / thử việc / tạm nghỉ / nghỉ việc. Di chuột vào
        cột để xem chi tiết; kéo ngang khi có nhiều Team.
      </p>
      {hasData ? (
        <TeamStatusBarChart labels={labels} series={series} height={300} />
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Không có dữ liệu
        </p>
      )}
    </section>
  )
}
