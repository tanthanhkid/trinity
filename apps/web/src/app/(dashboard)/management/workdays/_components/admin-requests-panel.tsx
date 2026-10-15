"use client"

import { VnDateInput } from "@/components/ui/vn-date-input"
import { useMemo, useState } from "react"
import { Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  REQUEST_TYPE_LABEL,
  useAttendanceRequests,
  type AttendanceRequest,
} from "@/hooks/use-attendance"
import { usePermissions } from "@/lib/rbac"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { useIsPhone } from "@/hooks/use-is-phone"
import { AdminRequestsTable } from "./admin-requests-table"
import {
  AttendanceOrgFilters,
  EMPTY_ORG_FILTERS,
  type OrgFilterValues,
} from "./attendance-org-filters"

const STATUS_OPTS = [
  { value: "__all__", label: "Tất cả trạng thái" },
  { value: "pending", label: "Chờ duyệt" },
  { value: "approved", label: "Đã duyệt" },
  { value: "rejected", label: "Từ chối" },
]

const TYPE_OPTS = [
  { value: "__all__", label: "Tất cả loại" },
  ...Object.entries(REQUEST_TYPE_LABEL).map(([k, v]) => ({ value: k, label: v })),
]

export function AdminRequestsPanel() {
  const isAdmin = usePermissions().can("attendance.manage")
  const isPhone = useIsPhone()
  // Mặc định KHÔNG lọc theo ngày → hiện tất cả đơn (đặc biệt đơn chờ duyệt) cho admin.
  const [dateFrom, setDateFrom] = useState<string>("")
  const [dateTo, setDateTo] = useState<string>("")
  const [typeFilter, setTypeFilter] = useState("__all__")
  const [statusFilter, setStatusFilter] = useState("__all__")
  const [search, setSearch] = useState("")
  const [orgFilters, setOrgFilters] = useState<OrgFilterValues>(EMPTY_ORG_FILTERS)
  const [page, setPage] = useState(1)

  const { data, isLoading } = useAttendanceRequests({
    page: 1,
    page_size: 1000,
    team_id: orgFilters.teamId,
    department: orgFilters.department || undefined,
    job_title_id: orgFilters.jobTitleId,
  })
  const allRequests: AttendanceRequest[] = data?.data ?? []
  // Lọc phía client trên tối đa 1000 đơn — vượt thì báo, không để bộ đếm trông như đã đủ.
  const truncated = (data?.pagination?.total ?? 0) > allRequests.length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allRequests.filter((r) => {
      if (dateFrom && r.work_date < dateFrom) return false
      if (dateTo && r.work_date > dateTo) return false
      if (typeFilter !== "__all__" && r.type !== typeFilter) return false
      if (statusFilter !== "__all__" && r.status !== statusFilter) return false
      if (q && !(r.user_name ?? "").toLowerCase().includes(q)) return false
      return true
    })
  }, [allRequests, dateFrom, dateTo, typeFilter, statusFilter, search])

  // Phân trang client-side 10 đơn/trang ( clamp — không dùng useEffect).
  const PAGE_SIZE = 10
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function patchOrgFilter(patch: Partial<OrgFilterValues>) {
    setOrgFilters((f) => ({ ...f, ...patch }))
    setPage(1)
  }

  function handleReset() {
    setDateFrom("")
    setDateTo("")
    setTypeFilter("__all__")
    setStatusFilter("__all__")
    setSearch("")
    setOrgFilters(EMPTY_ORG_FILTERS)
    setPage(1)
  }

  const activeFilterCount =
    (dateFrom || dateTo ? 1 : 0) +
    (typeFilter !== "__all__" ? 1 : 0) +
    (statusFilter !== "__all__" ? 1 : 0) +
    (orgFilters.department ? 1 : 0) +
    (orgFilters.teamId !== undefined ? 1 : 0) +
    (orgFilters.jobTitleId !== undefined ? 1 : 0)

  // Ô tìm nhân viên: <640px ở NGOÀI bảng lọc, desktop giữ vị trí cũ trong hàng lọc.
  const searchField = (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-slate-600">Tìm nhân viên</label>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
        <Input
          className="w-48 bg-white pl-8 text-sm max-sm:h-11 max-sm:w-full"
          placeholder="Tên nhân viên..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
        />
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 max-sm:border-0 max-sm:bg-transparent max-sm:p-0">
        {isPhone && searchField}
        <MobileFilterSheet activeCount={activeFilterCount} onReset={handleReset}>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Từ ngày</label>
          <VnDateInput
            value={dateFrom}
            max={dateTo || undefined}
            ariaLabel="Từ ngày"
            onChange={(iso) => { setDateFrom(iso); setPage(1) }}
            className="w-[160px] max-sm:w-full"
            inputClassName="bg-white text-sm max-sm:h-11"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Đến ngày</label>
          <VnDateInput
            value={dateTo}
            min={dateFrom || undefined}
            ariaLabel="Đến ngày"
            onChange={(iso) => { setDateTo(iso); setPage(1) }}
            className="w-[160px] max-sm:w-full"
            inputClassName="bg-white text-sm max-sm:h-11"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Loại đơn</label>
          <Select value={typeFilter} onValueChange={(v) => { if (v !== null) { setTypeFilter(v); setPage(1) } }}>
            <SelectTrigger className="w-44 bg-white text-sm max-sm:h-11 max-sm:w-full">
              <SelectValue placeholder="Tất cả loại">
                {(v) => {
                  if (typeof v !== "string" || !v) return null
                  return TYPE_OPTS.find((o) => o.value === v)?.label ?? null
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Trạng thái</label>
          <Select value={statusFilter} onValueChange={(v) => { if (v !== null) { setStatusFilter(v); setPage(1) } }}>
            <SelectTrigger className="w-40 bg-white text-sm max-sm:h-11 max-sm:w-full">
              <SelectValue placeholder="Tất cả trạng thái">
                {(v) => {
                  if (typeof v !== "string" || !v) return null
                  return STATUS_OPTS.find((o) => o.value === v)?.label ?? null
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!isPhone && searchField}
        <AttendanceOrgFilters value={orgFilters} onChange={patchOrgFilter} />
        {!isPhone && (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleReset}>
            <X className="size-3.5" />
            Đặt lại
          </Button>
        )}
        </MobileFilterSheet>
        {!isLoading && (
          <span className="text-xs text-slate-500">
            {filtered.length} / {allRequests.length} đơn
          </span>
        )}
        {!isLoading && truncated && (
          <span className="text-xs text-amber-600">
            Chỉ tải {allRequests.length}/{data?.pagination.total} đơn đầu — hãy lọc theo nhóm/phòng ban để thấy đủ.
          </span>
        )}
      </div>

      <AdminRequestsTable rows={paged} isLoading={isLoading} isAdmin={isAdmin} />

      {!isLoading && totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">
            Trang {safePage} / {totalPages} · {filtered.length} đơn
          </span>
          <div className="flex gap-2">
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
