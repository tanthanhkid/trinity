"use client"

import { useRef, useState } from "react"
import { ChevronUp, ChevronDown, ChevronsUpDown, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { formatDate, formatDateTimeVn } from "@/lib/format"
import {
  useAttendanceList,
  type AttendanceRecord,
} from "@/hooks/use-attendance"
import { WorkdaysExportButton } from "./workdays-export-button"
import {
  AttendanceOrgFilters,
  EMPTY_ORG_FILTERS,
  type OrgFilterValues,
} from "./attendance-org-filters"

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  present:      { label: "Đủ công",           cls: "border-emerald-300 bg-emerald-50 text-emerald-700" },
  late:         { label: "Đủ công (muộn)",    cls: "border-emerald-300 bg-emerald-50 text-emerald-700" },
  half_day:     { label: "Nửa ngày",          cls: "border-blue-300 bg-blue-50 text-blue-700" },
  insufficient: { label: "Chưa đủ nửa ngày", cls: "border-orange-300 bg-orange-50 text-orange-700" },
  incomplete:   { label: "Chưa chấm ra",      cls: "border-slate-300 bg-slate-100 text-slate-600" },
  review:       { label: "Xem xét",           cls: "border-red-300 bg-red-50 text-red-700" },
  leave:        { label: "Nghỉ phép",         cls: "border-purple-300 bg-purple-50 text-purple-700" },
  maternity:    { label: "Thai sản",          cls: "border-pink-300 bg-pink-50 text-pink-700" },
}

function StatusBadge({ status }: { status: string }) {
  const b = STATUS_MAP[status] ?? { label: status, cls: "border-slate-300 bg-slate-100 text-slate-600" }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${b.cls}`}>
      {b.label}
    </span>
  )
}

type SortBy = "work_date" | "employee" | "check_in" | "check_out" | "total_hours" | "status"
type SortDir = "asc" | "desc"

interface SortHeaderProps {
  label: string
  col: SortBy
  current: SortBy
  dir: SortDir
  onSort: (col: SortBy) => void
  className?: string
}

function SortHeader({ label, col, current, dir, onSort, className }: SortHeaderProps) {
  const active = col === current
  return (
    <th
      className={`cursor-pointer select-none whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold text-slate-600 hover:text-slate-900 ${className ?? ""}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          dir === "asc" ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 text-slate-400" />
        )}
      </span>
    </th>
  )
}

const PAGE_SIZE = 50

interface DetailTableProps {
  dateFrom: string
  dateTo: string
}

export function DetailTable({ dateFrom, dateTo }: DetailTableProps) {
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [orgFilters, setOrgFilters] = useState<OrgFilterValues>(EMPTY_ORG_FILTERS)
  const [sortBy, setSortBy] = useState<SortBy>("work_date")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [page, setPage] = useState(1)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function patchOrgFilter(patch: Partial<OrgFilterValues>) {
    setOrgFilters((f) => ({ ...f, ...patch }))
    setPage(1)
  }

  function handleSearchChange(val: string) {
    setSearch(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(val)
      setPage(1)
    }, 400)
  }

  function handleSort(col: SortBy) {
    if (col === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortBy(col)
      setSortDir("asc")
    }
    setPage(1)
  }

  const { data, isLoading, isError } = useAttendanceList({
    date_from: dateFrom,
    date_to: dateTo,
    page,
    page_size: PAGE_SIZE,
    sort_by: sortBy,
    sort_dir: sortDir,
    search: debouncedSearch || undefined,
    team_id: orgFilters.teamId,
    department: orgFilters.department || undefined,
    job_title_id: orgFilters.jobTitleId,
  })

  const pagination = data?.pagination
  const totalPages = pagination?.total_pages ?? 1
  const safePage = Math.min(page, Math.max(1, totalPages))

  const activeFilterCount =
    (orgFilters.department ? 1 : 0) +
    (orgFilters.teamId !== undefined ? 1 : 0) +
    (orgFilters.jobTitleId !== undefined ? 1 : 0)

  function formatTime(iso: string | null | undefined): string {
    if (!iso) return "—"
    return formatDateTimeVn(iso).split(" ")[0] ?? "—"
  }

  const rows = (data?.data ?? []) as AttendanceRecord[]
  const mobileCards =
    rows.length === 0 ? (
      <p className="py-10 text-center text-sm text-slate-400">Không có dữ liệu trong khoảng thời gian này</p>
    ) : (
      <div className="space-y-3">
        {rows.map((row) => (
          <ShellListCard key={row.id}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{formatDate(row.work_date)}</span>
              <StatusBadge status={row.status} />
            </div>
            <ShellListCardRow
              label="Nhân viên"
              value={
                <>
                  {row.user?.full_name ?? "—"}
                  {row.user?.employee?.position && (
                    <span className="block text-xs font-normal text-slate-400">{row.user.employee.position}</span>
                  )}
                </>
              }
            />
            <ShellListCardRow label="Team" value={row.user?.employee?.team_name ?? "—"} />
            <ShellListCardRow label="Vào — Ra" value={`${formatTime(row.check_in_at)} — ${formatTime(row.check_out_at)}`} />
            <ShellListCardRow label="Giờ công" value={row.total_hours != null ? `${row.total_hours.toFixed(1)}h` : "—"} />
            {row.late_minutes && row.late_minutes > 0 ? (
              <ShellListCardRow label="Muộn" value={<span className="text-amber-700">{row.late_minutes}p</span>} />
            ) : null}
          </ShellListCard>
        ))}
      </div>
    )

  const desktopTable = (
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[700px] text-sm">
          <thead className="border-b bg-slate-50">
            <tr>
              <SortHeader label="Ngày" col="work_date" current={sortBy} dir={sortDir} onSort={handleSort} />
              <SortHeader label="Nhân viên" col="employee" current={sortBy} dir={sortDir} onSort={handleSort} />
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-600">Team</th>
              <SortHeader label="Chấm vào" col="check_in" current={sortBy} dir={sortDir} onSort={handleSort} />
              <SortHeader label="Chấm ra" col="check_out" current={sortBy} dir={sortDir} onSort={handleSort} />
              <SortHeader label="Giờ công" col="total_hours" current={sortBy} dir={sortDir} onSort={handleSort} className="text-right" />
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-600">Muộn</th>
              <SortHeader label="Trạng thái" col="status" current={sortBy} dir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!data?.data?.length ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-sm text-slate-400">
                  Không có dữ liệu trong khoảng thời gian này
                </td>
              </tr>
            ) : (
              (data.data as AttendanceRecord[]).map((row) => (
                <tr key={row.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-700">{formatDate(row.work_date)}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{row.user?.full_name ?? "—"}</div>
                    {row.user?.employee?.position && (
                      <div className="text-xs text-slate-400">{row.user.employee.position}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{row.user?.employee?.team_name ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-700">{formatTime(row.check_in_at)}</td>
                  <td className="px-3 py-2 text-slate-700">{formatTime(row.check_out_at)}</td>
                  <td className="px-3 py-2 text-right text-slate-700">
                    {row.total_hours != null ? `${row.total_hours.toFixed(1)}h` : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {row.late_minutes && row.late_minutes > 0 ? (
                      <span className="text-amber-700">{row.late_minutes}p</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
  )

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-500">
        Đang tải dữ liệu...
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-red-500">
        Không tải được dữ liệu. Vui lòng thử lại.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-sm:flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            className="w-64 pl-8 text-sm max-sm:h-11 max-sm:w-full"
            placeholder="Tìm theo tên nhân viên..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
        <MobileFilterSheet
          activeCount={activeFilterCount}
          onReset={() => {
            setOrgFilters(EMPTY_ORG_FILTERS)
            setPage(1)
          }}
        >
          <AttendanceOrgFilters value={orgFilters} onChange={patchOrgFilter} />
        </MobileFilterSheet>
        <div className="ml-auto flex items-center gap-2">
          {pagination && (
            <span className="text-sm text-slate-500">{pagination.total} bản ghi</span>
          )}
          {/* forward Team/Phòng ban/Chức danh đang lọc trên bảng xuống Excel
              để file xuất khớp với bảng. */}
          <WorkdaysExportButton
            dateFrom={dateFrom}
            dateTo={dateTo}
            teamId={orgFilters.teamId}
            department={orgFilters.department || undefined}
            jobTitleId={orgFilters.jobTitleId}
          />
        </div>
      </div>

      <ShellResponsiveList table={desktopTable} cards={mobileCards} />

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">
            Trang {safePage}/{totalPages} — {pagination?.total ?? 0} bản ghi
          </span>
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Trước
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Sau
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
