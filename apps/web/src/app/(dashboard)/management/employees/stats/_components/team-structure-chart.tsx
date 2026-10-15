"use client"

/* Biểu đồ dùng bản nằm trong cây này, không import ngược từ module khác, để chỉnh một nơi không đổi nơi kia. */
import { DonutChart } from "@/app/(dashboard)/reports/_components/charts/donut-chart"
import type { TeamStructureRow } from "@/hooks/use-employees"
import { toSlices } from "./stats-shared"

export function TeamStructureChart({
  rows,
  total,
}: {
  rows: TeamStructureRow[]
  total: number
}) {
  // Gộp "Khác" thay vì xoay vòng màu: quá 6 team thì team thứ 7 dùng lại đúng
  // màu team 1 và chú giải không nối được lát với nhãn (xem `toSlices`).
  const slices = toSlices(
    rows.map((r) => ({ label: r.team_name, count: r.count })),
  )

  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-card p-4 shadow-[var(--shadow-card)] sm:p-5">
      <h2 className="mb-1 text-base font-semibold">Cơ cấu nhân sự theo Team</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Tổng {total} nhân viên trong phạm vi lọc.
      </p>
      {total === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Không có dữ liệu
        </p>
      ) : (
        <div className="flex flex-col items-start gap-6 lg:flex-row">
          <DonutChart
            slices={slices}
            size={180}
            innerLabel={`${total} NV`}
            showLegend={false}
          />
          <div className="max-h-[260px] w-full flex-1 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Team</th>
                  <th className="py-2 pr-2 text-right font-medium">Số NV</th>
                  <th className="py-2 text-right font-medium">Tỷ lệ</th>
                </tr>
              </thead>
              <tbody>
                {slices.map((s) => (
                  <tr key={s.key} className="border-b last:border-0">
                    <td className="py-2 pr-3 align-middle">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: s.color }}
                        />
                        <span
                          className="block max-w-[180px] truncate"
                          title={s.label}
                        >
                          {s.label}
                        </span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-2 text-right font-medium tabular-nums">
                      {s.value}
                    </td>
                    <td className="whitespace-nowrap py-2 text-right tabular-nums text-muted-foreground">
                      {total ? ((s.value / total) * 100).toFixed(1) : "0"}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
