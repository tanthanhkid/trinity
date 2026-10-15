"use client"

import { VnDateInput } from "@/components/ui/vn-date-input"
import { useState } from "react"
import { AlertTriangle, XCircle, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectItem,
  SelectContent,
} from "@/components/ui/select"
import { useContractStats, type ContractStatBucket } from "@/hooks/use-contracts"
import { useDepartments } from "@/hooks/use-departments"
import { useTeamsForFilter } from "@/hooks/use-teams"
import { firstDayOfMonthVn, todayVn } from "@/lib/format"
/* Biểu đồ dùng bản nằm trong cây này (xem ghi chú ở `attendance/_components/attendance-stats-dialog.tsx`). */
import { DonutChart } from "@/app/(dashboard)/reports/_components/charts/donut-chart"
import { BarChart } from "@/app/(dashboard)/reports/_components/charts/bar-chart"
import { LineChart } from "@/app/(dashboard)/reports/_components/charts/line-chart"
import { categoryColor, CHART_NEUTRAL, CHART_STATUS, CHART_URGENCY } from "@/components/app-shell/charts/chart-colors"

// Màu cố định theo trạng thái HĐ (khớp badge bảng danh sách).
// Tình trạng hợp đồng LÀ một thang đánh giá (còn hiệu lực → sắp hết → đã hết),
// nên dùng đúng bộ màu trạng thái; 2 mức không mang nghĩa đánh giá đi màu xám.
const STATUS_COLOR: Record<string, string> = {
  active: CHART_STATUS.good,
  expiring: CHART_STATUS.warn,
  expired: CHART_STATUS.bad,
  // 2 khoá này KHÔNG được cùng màu: BE luôn trả đủ 5 khoá nên chúng là 2
  // lát nằm cạnh nhau trong CÙNG một vành khuyên; cùng xám thì ô chú giải
  // giống hệt nhau, người đọc không nối được lát với nhãn.
  terminated: CHART_NEUTRAL,
  no_contract: "var(--color-app-chart-seq-2)",
}
const EMPLOYMENT_COLOR: Record<string, string> = {
  working: categoryColor(0),
  resigned: CHART_NEUTRAL,
}
// Màu cảnh báo theo độ gấp: ≤1 tháng (đỏ) → 1–2 tháng (cam) → 2–3 tháng (vàng).
const EXPIRING_COLOR: Record<string, string> = {
  m1: CHART_URGENCY.now,
  m2: CHART_URGENCY.soon,
  m3: CHART_URGENCY.later,
}
// Bảng màu xoay vòng cho loại HĐ / team.
/**
 * ⚠️ Chỉ dùng cho danh sách LOẠI HỢP ĐỒNG (số loại do dữ liệu quyết định).
 * KẸP ở màu cuối chứ không xoay vòng — xoay vòng làm loại thứ 7 trùng màu loại
 * thứ 1 một cách câm. Quá 6 loại thì nên gộp "Khác" ở tầng dữ liệu.
 */
const PALETTE = Array.from({ length: 6 }, (_, i) => categoryColor(i))

const EMPLOYMENT_FILTERS = [
  { value: "working", label: "Đang làm việc" },
  { value: "resigned", label: "Đã nghỉ" },
]

function toSlices(
  buckets: ContractStatBucket[],
  colorOf: (b: ContractStatBucket, i: number) => string,
) {
  return buckets
    .filter((b) => b.count > 0)
    .map((b, i) => ({ key: b.key, label: b.label, color: colorOf(b, i), value: b.count }))
}

function MetricCard({
  label,
  value,
  accent,
  icon,
  borderClass,
}: {
  label: string
  value: number
  accent?: string
  icon?: React.ReactNode
  borderClass?: string
}) {
  return (
    <div className={`rounded-[var(--radius)] border bg-card p-3 ${borderClass ?? ""}`}>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${accent ?? "text-foreground"}`}>
        {value.toLocaleString("vi-VN")}
      </p>
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-4">
      <p className="mb-2 text-sm font-semibold">{title}</p>
      {children}
    </div>
  )
}

export function ContractStatsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  // mặc định: đầu tháng hiện tại → hôm nay (FE tự set trước khi gọi;
  // BE optional — không gửi gì = không lọc ngày).
  const [dateFrom, setDateFrom] = useState(() => firstDayOfMonthVn())
  const [dateTo, setDateTo] = useState(() => todayVn())
  const [department, setDepartment] = useState("")
  const [team, setTeam] = useState("")
  const [employmentStatus, setEmploymentStatus] = useState("")

  const departments = useDepartments()
  const { data: teamsForFilter = [] } = useTeamsForFilter()

  const { data, isLoading } = useContractStats(open, {
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    department: department || undefined,
    team: team || undefined,
    employment_status: employmentStatus || undefined,
  })

  const statusOf = (k: string) =>
    data?.by_status.find((b) => b.key === k)?.count ?? 0

  const monthLabels =
    data?.signed_by_month.map((m) => {
      const [y, mm] = m.month.split("-")
      return `${mm}/${y.slice(2)}`
    }) ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-[95vw] flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Thống kê hợp đồng</DialogTitle>
        </DialogHeader>

        {/* Thanh bộ lọc — sticky để luôn hiện khi cuộn nội dung bên dưới. */}
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background pb-3 max-sm:grid max-sm:grid-cols-2">
          <VnDateInput
            value={dateFrom}
            max={dateTo || undefined}
            onChange={setDateFrom}
            className="w-[150px] max-sm:w-full"
            inputClassName="h-9 text-sm max-sm:h-11"
            ariaLabel="Từ ngày"
          />
          <span className="text-sm text-muted-foreground max-sm:hidden">—</span>
          <VnDateInput
            value={dateTo}
            min={dateFrom || undefined}
            onChange={setDateTo}
            className="w-[150px] max-sm:w-full"
            inputClassName="h-9 text-sm max-sm:h-11"
            ariaLabel="Đến ngày"
          />
          <Select
            value={department || "__all__"}
            onValueChange={(v) => setDepartment(v === "__all__" || !v ? "" : v)}
          >
            <SelectTrigger className="w-40 max-sm:h-11 max-sm:w-full">
              <SelectValue placeholder="Tất cả bộ phận">
                {(v) => (typeof v === "string" && v && v !== "__all__" ? v : "Tất cả bộ phận")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Tất cả bộ phận</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={team || "__all__"}
            onValueChange={(v) => setTeam(v === "__all__" || !v ? "" : v)}
          >
            <SelectTrigger className="w-40 max-sm:h-11 max-sm:w-full">
              <SelectValue placeholder="Tất cả team">
                {(v) => {
                  if (typeof v !== "string" || !v || v === "__all__") return "Tất cả team"
                  return teamsForFilter.find((t) => String(t.team_lead_id) === v)?.name ?? null
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Tất cả team</SelectItem>
              {teamsForFilter.map((t) => (
                <SelectItem key={t.id} value={String(t.team_lead_id)}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={employmentStatus || "__all__"}
            onValueChange={(v) => setEmploymentStatus(v === "__all__" || !v ? "" : v)}
          >
            <SelectTrigger className="w-44 max-sm:col-span-2 max-sm:h-11 max-sm:w-full">
              <SelectValue placeholder="Tất cả tình trạng">
                {(v) => {
                  if (typeof v !== "string" || !v || v === "__all__") return "Tất cả tình trạng"
                  return EMPLOYMENT_FILTERS.find((s) => s.value === v)?.label ?? null
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Tất cả tình trạng</SelectItem>
              {EMPLOYMENT_FILTERS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading || !data ? (
          <div className="flex flex-1 items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 space-y-5 overflow-y-auto pr-1 pt-3">
            {/* Thẻ số liệu nhanh */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <MetricCard label="Tổng hồ sơ" value={data.total} accent="text-foreground" />
              <MetricCard label="Đang hiệu lực" value={statusOf("active")} accent="text-emerald-600" />
              <MetricCard
                label="Sắp hết hạn"
                value={statusOf("expiring")}
                accent="text-amber-700"
                icon={<AlertTriangle className="size-3.5 text-amber-500" />}
                borderClass="border-amber-200"
              />
              <MetricCard
                label="Hết hạn"
                value={statusOf("expired")}
                accent="text-red-600"
                icon={<XCircle className="size-3.5 text-red-500" />}
                borderClass="border-red-200"
              />
              <MetricCard label="Đã chấm dứt" value={statusOf("terminated")} accent="text-slate-500" />
              <MetricCard label="Chưa có HĐ" value={statusOf("no_contract")} accent="text-slate-400" />
            </div>

            {/* 3 donut: trạng thái / loại HĐ / tình trạng làm việc */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <ChartCard title="Theo trạng thái HĐ">
                <DonutChart
                  slices={toSlices(data.by_status, (b) => STATUS_COLOR[b.key] ?? CHART_NEUTRAL)}
                  size={170}
                  innerLabel="hồ sơ"
                />
              </ChartCard>
              <ChartCard title="Theo loại HĐ">
                <DonutChart
                  slices={toSlices(data.by_type, (_, i) => PALETTE[Math.min(i, PALETTE.length - 1)])}
                  size={170}
                  innerLabel="hồ sơ"
                />
              </ChartCard>
              <ChartCard title="Theo tình trạng làm việc">
                <DonutChart
                  slices={toSlices(data.by_employment, (b) => EMPLOYMENT_COLOR[b.key] ?? CHART_NEUTRAL)}
                  size={170}
                  innerLabel="NV"
                />
              </ChartCard>
            </div>

            {/* Sắp hết hạn trong 3 tháng tới (theo thời gian còn lại) */}
            <ChartCard title="Sắp hết hạn trong 3 tháng tới (theo thời gian còn lại)">
              {data.expiring_3m.some((b) => b.count > 0) ? (
                <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:justify-center sm:gap-10">
                  <DonutChart
                    slices={toSlices(data.expiring_3m, (b) => EXPIRING_COLOR[b.key] ?? CHART_URGENCY.soon)}
                    size={180}
                    innerLabel="hồ sơ"
                  />
                  <ul className="space-y-1.5 pt-2 text-sm">
                    {data.expiring_3m.map((b) => (
                      <li key={b.key} className="flex items-center gap-2">
                        <span
                          className="inline-block size-3 rounded-sm"
                          style={{ background: EXPIRING_COLOR[b.key] }}
                        />
                        <span className="text-muted-foreground">{b.label}:</span>
                        <span className="font-semibold tabular-nums">{b.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Không có hợp đồng nào sắp hết hạn trong 3 tháng tới.
                </p>
              )}
            </ChartCard>

            {/* Bar ngang: số hợp đồng theo team — luôn hiện đầy đủ tên team */}
            <ChartCard title="Số hồ sơ theo team">
              <BarChart
                labels={data.by_team.map((t) => t.label)}
                series={[
                  {
                    key: "count",
                    label: "Số hồ sơ",
                    color: categoryColor(0),
                    values: data.by_team.map((t) => t.count),
                  },
                ]}
                horizontal
                height={260}
              />
            </ChartCard>

            {/* Line: HĐ ký mới theo tháng (12 tháng gần nhất) */}
            <ChartCard title="Hợp đồng ký mới theo tháng (12 tháng gần nhất)">
              <LineChart
                labels={monthLabels}
                series={[
                  {
                    key: "signed",
                    label: "HĐ ký mới",
                    color: categoryColor(1),
                    values: data.signed_by_month.map((m) => m.count),
                  },
                ]}
                height={240}
              />
            </ChartCard>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
