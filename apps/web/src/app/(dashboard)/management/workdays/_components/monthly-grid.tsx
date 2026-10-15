"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, Check, ChevronLeft, ChevronRight } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { useIsPhone } from "@/hooks/use-is-phone"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { MonthlyGridExportButton } from "./monthly-grid-export-button"
import { useTeamsForFilter } from "@/hooks/use-teams"
import { useDepartments } from "@/hooks/use-departments"

interface DayCell {
  day: number
  status: string
  hours: number | null
  late_minutes: number
  check_in: string | null
  check_out: string | null
  early_leave_compensated?: boolean
}

interface MatrixRow {
  user_id: number
  full_name: string | null
  email: string | null
  employee_code: string | null
  position: string | null
  department: string | null
  /** Team CHÍNH THỨC resolve 3 tầng — null = "Chưa có team". */
  team_name: string | null
  total_work_days: number
  total_work_days_after_approval: number
  total_hours: number
  present_days: number
  half_days: number
  insufficient_days: number
  incomplete_days: number
  leave_days: number
  maternity_days: number
  late_days: number
  total_late_minutes: number
  early_leave_count: number
  early_leave_approved: number
  early_leave_rejected: number
  early_leave_minutes: number
  compensated_days: number
  notes: string
  cells: Record<number, DayCell>
}

interface MatrixResponse {
  date_from: string
  date_to: string
  days_in_month: number
  count: number
  capped: boolean
  rows: MatrixRow[]
}

interface Filters {
  search: string
  department: string
  teamId: number | undefined
  position: string
  status: string
}
const EMPTY_FILTERS: Filters = { search: "", department: "", teamId: undefined, position: "", status: "" }

const PAGE_SIZE = 10

// Bản sao logic BE cellDisplayText (KHÔNG share package FE↔BE).
function formatHm(hours: number | null): string {
  if (hours === null) return ""
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  return `${h}:${m < 10 ? `0${m}` : m}`
}

const WEEKDAY_VN = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"]
const STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "present", label: "Có ngày đủ công" },
  { value: "under", label: "Có ngày thiếu công" },
  { value: "incomplete", label: "Có ngày thiếu vào/ra" },
  { value: "late", label: "Có đi muộn" },
  { value: "leave", label: "Có nghỉ phép" },
]

function DayCellView({ cell }: { cell: DayCell | undefined }) {
  if (!cell) return <span className="text-slate-300">·</span>

  const severe = cell.status === "insufficient" || cell.status === "review"
  const tip = (() => {
    const parts = [
      `Vào ${cell.check_in ?? "—"}`,
      `Ra ${cell.check_out ?? "—"}`,
      `${cell.hours != null ? cell.hours.toFixed(1) : "—"}h`,
    ]
    let s = parts.join(" · ")
    if (cell.late_minutes > 0) s += ` · Đi muộn ${cell.late_minutes}p`
    // "8:00" là KÝ HIỆU đủ công (1 ngày công), KHÔNG phải giờ thực tế — giờ thực tế hiện ở "Xh" trên.
    if (cell.status === "present") s += " · Đủ công"
    if (cell.status === "half_day")
      s += cell.early_leave_compensated
        ? " · Chưa đủ giờ công → ĐÃ BÙ CÔNG (đơn về sớm duyệt) = 1 công"
        : " · Chưa đủ giờ công · 0.5 công"
    if (severe) s += " · Thiếu giờ công nghiêm trọng · 0 công"
    if (cell.status === "leave") s += " · Nghỉ phép đã duyệt"
    if (cell.status === "maternity") s += " · Thai sản"
    return s
  })()

  let text = ""
  let cls = ""
  const late = cell.late_minutes > 0
  switch (cell.status) {
    case "present":
      text = "8:00"
      cls = late ? "text-amber-700 font-medium" : "text-slate-700"
      break
    case "half_day":
      text = formatHm(cell.hours)
      // Được bù công (đơn về sớm duyệt) → xanh + ✓; chưa bù → cam.
      cls = cell.early_leave_compensated
        ? "text-emerald-700 bg-emerald-50 rounded font-medium"
        : "text-orange-700 bg-orange-50 rounded"
      break
    case "insufficient":
    case "review":
      // <4h: thiếu giờ công nghiêm trọng → đỏ (KHÔNG tự bù dù có đơn).
      text = formatHm(cell.hours)
      cls = "text-red-700 bg-red-50 rounded font-medium"
      break
    case "incomplete":
      text = "???"
      cls = "text-yellow-800 bg-yellow-100 rounded font-semibold"
      break
    case "leave":
      text = "8:00"
      cls = "text-purple-700 bg-purple-50 rounded"
      break
    case "maternity":
      text = "8:00"
      cls = "text-pink-700 bg-pink-50 rounded"
      break
    default:
      text = "·"
      cls = "text-slate-300"
  }

  return (
    <span title={tip} className={`inline-flex items-center justify-center gap-0.5 px-1 py-0.5 text-xs ${cls}`}>
      {text}
      {cell.status === "present" && late && <AlertTriangle className="inline h-2.5 w-2.5" />}
      {cell.status === "half_day" && cell.early_leave_compensated && (
        <Check className="inline h-2.5 w-2.5" />
      )}
    </span>
  )
}

interface MonthlyGridProps {
  dateFrom: string
  dateTo: string
}

export function MonthlyGrid({ dateFrom, dateTo }: MonthlyGridProps) {
  // Lọc áp NGAY khi thay đổi (không cần nút "Lọc") — danh sách nhỏ nên live filter mượt.
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const isPhone = useIsPhone()
  // Chú thích màu: <640px thu gọn mặc định (6 dòng ~300px) — bấm "Chú thích" để mở.
  const [legendOpen, setLegendOpen] = useState(false)

  // danh sách Team để cascade Phòng ban → Team.
  // `useTeamsForFilter` (mọi role) thay `useTeams` (chỉ super_admin/hr —
  // 403 cho accountant/chief_accountant cũng vào được /management/workdays).
  const { data: allTeams = [] } = useTeamsForFilter({ includeUnled: true })

  // Mọi thay đổi bộ lọc → quay về trang 1 (event handler, KHÔNG useEffect → không render-storm).
  function patchFilter(patch: Partial<Filters>) {
    // Cascade: đổi department → reset teamId nếu team không thuộc department mới.
    if (patch.department !== undefined && patch.department !== filters.department) {
      const newDept = patch.department
      const teamStillValid =
        filters.teamId === undefined ||
        (newDept === "" && true) ||
        allTeams.some((t) => t.id === filters.teamId && t.department === newDept)
      if (!teamStillValid) {
        setFilters((f) => ({ ...f, ...patch, teamId: undefined }))
        setPage(1)
        return
      }
    }
    setFilters((f) => ({ ...f, ...patch }))
    setPage(1)
  }
  function resetFilters() {
    setFilters(EMPTY_FILTERS)
    setPage(1)
  }

  // params team/dept/position gửi xuống BE để lọc trước khi build matrix.
  const matrixParams = useMemo(() => {
    const p: Record<string, unknown> = { date_from: dateFrom, date_to: dateTo }
    if (filters.teamId !== undefined) p['team_id'] = filters.teamId
    if (filters.department) p['department'] = filters.department
    return p
  }, [dateFrom, dateTo, filters.teamId, filters.department])

  const { data, isLoading, isError } = useQuery<MatrixResponse>({
    queryKey: ["workdays-matrix", matrixParams],
    queryFn: async () => {
      const res = await apiClient.get<MatrixResponse>("/management/attendance/workdays-matrix", {
        params: matrixParams,
      })
      return res.data
    },
    enabled: !!dateFrom && !!dateTo,
    staleTime: 60_000,
  })

  const rows = data?.rows ?? []
  // Fallback từ dateTo (= ngày cuối tháng do page truyền) → tránh flash 31 cột lúc loading (vd tháng 2).
  const fallbackDays = Number(dateTo?.split("-")[2]) || 31
  const daysInMonth = data?.days_in_month ?? fallbackDays

  // [year, month] từ dateFrom để tính thứ + header ngày.
  const [year, month] = useMemo(() => {
    const [y, m] = dateFrom.split("-").map(Number)
    return [y, m] as const
  }, [dateFrom])

  // dropdown "Phòng ban" PHẢI khớp cấu hình Cài đặt → Phòng ban
  // (`useDepartments`), không suy từ `rows` của tháng đang xem.
  const departments = useDepartments()
  const positions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.position).filter((p): p is string => !!p))).sort(),
    [rows],
  )

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase()
    return rows.filter((r) => {
      if (q) {
        const hay = `${r.full_name ?? ""} ${r.employee_code ?? ""} ${r.email ?? ""}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (filters.department && r.department !== filters.department) return false
      if (filters.position && r.position !== filters.position) return false
      if (filters.status) {
        const ok =
          (filters.status === "present" && r.present_days > 0) ||
          (filters.status === "under" && r.half_days + r.insufficient_days > 0) ||
          (filters.status === "incomplete" && r.incomplete_days > 0) ||
          (filters.status === "late" && r.late_days > 0) ||
          (filters.status === "leave" && r.leave_days > 0)
        if (!ok) return false
      }
      return true
    })
  }, [rows, filters])

  const activeFilterCount =
    (filters.department ? 1 : 0) +
    (filters.teamId !== undefined ? 1 : 0) +
    (filters.position ? 1 : 0) +
    (filters.status ? 1 : 0)

  const hasFilters =
    filters.search.trim() !== "" ||
    filters.department !== "" ||
    filters.teamId !== undefined ||
    filters.position !== "" ||
    filters.status !== ""

  // Phân trang 10 NV/trang (client-side; safePage clamp khi danh sách co lại).
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageRows = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  )
  const fromRow = filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1
  const toRow = Math.min(safePage * PAGE_SIZE, filtered.length)

  const days = useMemo(() => Array.from({ length: daysInMonth }, (_, i) => i + 1), [daysInMonth])

  if (isError) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-red-500">
        Không tải được dữ liệu. Vui lòng thử lại.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Bộ lọc — áp ngay khi thay đổi; responsive: xếp dọc trên mobile, hàng ngang từ sm */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <Input
          className="h-9 w-full text-sm max-sm:h-11 sm:w-56"
          placeholder="Tìm tên / mã NV / email..."
          value={filters.search}
          onChange={(e) => patchFilter({ search: e.target.value })}
        />
        <MobileFilterSheet activeCount={activeFilterCount} onReset={resetFilters}>
        {departments.length > 0 && (
          <Select value={filters.department} onValueChange={(v) => patchFilter({ department: v ?? "" })}>
            <SelectTrigger className="h-9 w-full text-sm max-sm:h-11 sm:w-44">
              <SelectValue placeholder="Tất cả phòng ban">
                {(v) => (typeof v === "string" && v ? v : "Tất cả phòng ban")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Tất cả phòng ban</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* Team filter — cascade theo department đang chọn (lọc BE + client đồng nhất). */}
        {allTeams.length > 0 && (
          <Select
            value={filters.teamId !== undefined ? String(filters.teamId) : ""}
            onValueChange={(v) => patchFilter({ teamId: v ? Number(v) : undefined })}
          >
            <SelectTrigger className="h-9 w-full text-sm max-sm:h-11 sm:w-44">
              <SelectValue placeholder="Tất cả team">
                {(v) => {
                  if (typeof v !== "string" || !v) return "Tất cả team"
                  const id = Number(v)
                  return allTeams.find((t) => t.id === id)?.name ?? null
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Tất cả team</SelectItem>
              {(filters.department
                ? allTeams.filter((t) => t.department === filters.department)
                : allTeams
              ).map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {positions.length > 0 && (
          <Select value={filters.position} onValueChange={(v) => patchFilter({ position: v ?? "" })}>
            <SelectTrigger className="h-9 w-full text-sm max-sm:h-11 sm:w-44">
              <SelectValue placeholder="Tất cả chức danh">
                {(v) => (typeof v === "string" && v ? v : "Tất cả chức danh")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Tất cả chức danh</SelectItem>
              {positions.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={filters.status} onValueChange={(v) => patchFilter({ status: v ?? "" })}>
          <SelectTrigger className="h-9 w-full text-sm max-sm:h-11 sm:w-44">
            <SelectValue placeholder="Tất cả trạng thái">
              {(v) => {
                if (typeof v !== "string" || !v) return "Tất cả trạng thái"
                return STATUS_FILTER_OPTIONS.find((o) => o.value === v)?.label ?? null
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả trạng thái</SelectItem>
            {STATUS_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!isPhone && (
          <Button
            size="sm"
            variant="outline"
            className="h-9 w-full sm:w-auto"
            onClick={resetFilters}
            disabled={!hasFilters}
          >
            Đặt lại
          </Button>
        )}
        </MobileFilterSheet>
        <div className="sm:ml-auto">
          {/* forward Team/Phòng ban đang lọc trên bảng xuống Excel (khớp matrixParams
              gửi cho query chính) để file xuất khớp với bảng. */}
          <MonthlyGridExportButton
            dateFrom={dateFrom}
            dateTo={dateTo}
            teamId={filters.teamId}
            department={filters.department || undefined}
          />
        </div>
      </div>

      {/* Chú thích ô + số lượng */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
        <span className="font-semibold text-slate-700">{filtered.length} nhân viên</span>
        {data?.capped && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">
            Dữ liệu bị cắt — thu hẹp khoảng thời gian
          </span>
        )}
        <button
          type="button"
          aria-expanded={legendOpen}
          onClick={() => setLegendOpen((o) => !o)}
          className="text-slate-500 underline underline-offset-2 sm:hidden max-sm:min-h-11 max-sm:px-2"
        >
          {legendOpen ? "Ẩn chú thích" : "Chú thích"}
        </button>
        {/* `contents` giữ nguyên bố cục desktop (các mục vẫn là con trực tiếp của hàng flex);
            <640px: ẩn khi chưa bấm "Chú thích". */}
        <span className={`contents ${legendOpen ? "" : "max-sm:hidden"}`}>
        <span className="text-slate-400">Chú thích:</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="font-medium text-slate-700">8:00</span>
          <span className="text-slate-500">đủ công</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded bg-orange-50 px-1 font-medium text-orange-700">giờ</span>
          <span className="text-slate-500">chưa đủ công (½)</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-0.5 rounded bg-emerald-50 px-1 font-medium text-emerald-700">
            giờ <Check className="h-2.5 w-2.5" />
          </span>
          <span className="text-slate-500">đã bù công (đơn về sớm)</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded bg-red-50 px-1 font-medium text-red-700">giờ</span>
          <span className="text-slate-500">thiếu nghiêm trọng (&lt;4h)</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded bg-yellow-100 px-1 font-semibold text-yellow-800">???</span>
          <span className="text-slate-500">thiếu vào/ra</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded bg-purple-50 px-1 font-medium text-purple-700">8:00</span>
          <span className="text-slate-500">nghỉ phép</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded bg-pink-50 px-1 font-medium text-pink-700">8:00</span>
          <span className="text-slate-500">thai sản</span>
        </span>
        <span className="inline-flex items-center gap-1 text-amber-700">
          <AlertTriangle className="h-3 w-3" /> đi muộn
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-slate-300">·</span>
          <span className="text-slate-500">không có</span>
        </span>
        </span>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-slate-500">Đang tải dữ liệu...</div>
      ) : (
        <>
        <p className="text-xs text-slate-500 sm:hidden">
          Lưới ngày × nhân viên rộng — vuốt ngang trong khung để xem các ngày; cột tên nhân viên được ghim bên trái.
        </p>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="text-sm" style={{ minWidth: "max-content" }}>
            <thead className="border-b bg-slate-50">
              <tr>
                <th className="sticky left-0 z-20 w-10 bg-slate-50 max-sm:hidden px-2 py-2 text-left text-xs font-semibold text-slate-600">#</th>
                <th className="sticky left-10 z-20 min-w-[180px] bg-slate-50 max-sm:left-0 max-sm:min-w-[132px] px-3 py-2 text-left text-xs font-semibold text-slate-600">Nhân viên</th>
                <th className="min-w-[110px] px-2 py-2 text-left text-xs font-semibold text-slate-600">Team</th>
                {days.map((d) => {
                  const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay()
                  const weekend = wd === 0 || wd === 6
                  return (
                    <th key={d} className={`w-9 px-0.5 py-1 text-center text-sm font-semibold ${weekend ? "text-rose-400" : "text-slate-500"}`}>
                      <div>{d}</div>
                      <div className="font-normal">{WEEKDAY_VN[wd]}</div>
                    </th>
                  )
                })}
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600" title="Tổng công thực tế: đủ công + 0.5 × chưa đủ giờ + nghỉ phép + thai sản (chưa áp đơn về sớm)">Tổng công thực tế</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-emerald-700" title="Tổng công sau phê duyệt: số công hệ thống tính cuối cùng sau khi áp các đơn về sớm đã được quản lý phê duyệt (mỗi ngày 4–8h được duyệt tính tròn 1 công).">Công sau phê duyệt</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600">Tổng giờ</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600">Đủ công</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600">Chưa đủ</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600">Nghỉ phép</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600">Thai sản</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600">Đi muộn</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600" title="Số lần về sớm (đơn xin về sớm đã nộp trong kỳ)">Lần về sớm</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600" title="Tổng phút thiếu so với đủ công (8h) trên các ngày về sớm">Phút về sớm</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600">Đơn duyệt</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-600">Đơn từ chối</th>
                <th className="min-w-[160px] px-2 py-2 text-left text-xs font-semibold text-slate-600">Ghi chú</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={daysInMonth + 16} className="py-10 text-center text-sm text-slate-400">
                    Không có dữ liệu trong khoảng thời gian này
                  </td>
                </tr>
              ) : (
                pageRows.map((row, idx) => (
                  <tr key={row.user_id} className="hover:bg-slate-50">
                    <td className="sticky left-0 z-10 w-10 bg-white max-sm:hidden px-2 py-1.5 text-xs text-slate-400">
                      {(safePage - 1) * PAGE_SIZE + idx + 1}
                    </td>
                    <td className="sticky left-10 z-10 min-w-[180px] bg-white max-sm:left-0 max-sm:min-w-[132px] px-3 py-1.5">
                      <div className="font-medium text-slate-900">{row.full_name ?? "—"}</div>
                      <div className="text-sm text-slate-400">
                        {row.employee_code || `NV${row.user_id}`}
                        {row.position ? ` · ${row.position}` : ""}
                      </div>
                    </td>
                    <td className="min-w-[110px] px-2 py-1.5 text-xs text-slate-600">
                      {row.team_name ?? "—"}
                    </td>
                    {days.map((d) => (
                      <td key={d} className="px-0.5 py-1 text-center">
                        <DayCellView cell={row.cells[d]} />
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-center font-medium text-slate-800">{row.total_work_days}</td>
                    <td
                      className={`px-2 py-1.5 text-center font-semibold ${
                        row.total_work_days_after_approval > row.total_work_days
                          ? "text-emerald-700"
                          : "text-slate-800"
                      }`}
                      title={
                        row.total_work_days_after_approval > row.total_work_days
                          ? `Đã bù ${(row.total_work_days_after_approval - row.total_work_days).toFixed(1)} công nhờ đơn về sớm duyệt`
                          : undefined
                      }
                    >
                      {row.total_work_days_after_approval}
                    </td>
                    <td className="px-2 py-1.5 text-center text-slate-700">{row.total_hours.toFixed(1)}</td>
                    <td className="px-2 py-1.5 text-center text-emerald-700">{row.present_days || "—"}</td>
                    <td className="px-2 py-1.5 text-center text-orange-600">{row.half_days + row.insufficient_days || "—"}</td>
                    <td className="px-2 py-1.5 text-center text-purple-700">{row.leave_days || "—"}</td>
                    <td className="px-2 py-1.5 text-center text-pink-700">{row.maternity_days || "—"}</td>
                    <td className="px-2 py-1.5 text-center text-amber-700">{row.late_days || "—"}</td>
                    <td className="px-2 py-1.5 text-center text-slate-700">{row.early_leave_count || "—"}</td>
                    <td className="px-2 py-1.5 text-center text-slate-700">{row.early_leave_minutes || "—"}</td>
                    <td className="px-2 py-1.5 text-center text-emerald-600">{row.early_leave_approved || "—"}</td>
                    <td className="px-2 py-1.5 text-center text-red-600">{row.early_leave_rejected || "—"}</td>
                    <td className="min-w-[160px] px-2 py-1.5 text-xs text-slate-500">{row.notes}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        </>
      )}

      {/* Phân trang 10 nhân viên / trang */}
      {!isLoading && filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
          <span>
            Hiển thị {fromRow}–{toRow} / {filtered.length} nhân viên
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
            >
              <ChevronLeft className="h-4 w-4" /> Trước
            </Button>
            <span className="min-w-[72px] text-center text-slate-500">
              Trang {safePage}/{totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
            >
              Sau <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
