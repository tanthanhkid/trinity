"use client"

import { useState, useRef } from "react"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { useIsPhone } from "@/hooks/use-is-phone"
import { todayVn, isoToVnDate, parseVnDate, autoMaskVnDate } from "@/lib/format"
import {
  AttendanceOrgFilters,
  EMPTY_ORG_FILTERS,
  type OrgFilterValues,
} from "@/app/(dashboard)/management/workdays/_components/attendance-org-filters"
import {
  useAttendanceList,
  useAttendanceSettings,
} from "@/hooks/use-attendance"
import { AttendanceDetailDialog } from "./attendance-detail-dialog"
import { AttendanceHistoryTable } from "./attendance-history-table"
import { STATUS_OPTIONS, type SortCol } from "./attendance-history-helpers"

export function AttendanceHistoryCard({
  isAdmin,
  canEdit,
  canDelete,
  userId,
}: {
  isAdmin: boolean
  canEdit: boolean
  /**
   * Quyền XOÁ bản ghi (super_admin + hr). Mặc định = `isAdmin` (giữ hành vi cũ cho trang
   * cá nhân). Trang "Quản lý chấm công" truyền riêng để kế toán XEM nhưng KHÔNG xoá.
 */
  canDelete?: boolean
  /**
   * Khi truyền (trang /attendance cá nhân) → ép scope chỉ bản ghi của user này,
   * KỂ CẢ với admin (super_admin/hr). BE `listRecords` honor `dto.user_id` cho
   * admin; non-admin bị BE ép `user_id=self` nên truyền vào vô hại (không leak).
   * KHÔNG truyền (trang /management/workdays) → admin xem bản ghi TOÀN NV.
 */
  userId?: number
}) {
  const isPhone = useIsPhone()
  const today = todayVn()
  const [dateFrom, setDateFrom] = useState<string>(today)
  const [dateTo, setDateTo] = useState<string>(today)
  const [dateFromText, setDateFromText] = useState<string>(isoToVnDate(today))
  const [dateToText, setDateToText] = useState<string>(isoToVnDate(today))
  const [search, setSearch] = useState<string>("")
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [orgFilters, setOrgFilters] = useState<OrgFilterValues>(EMPTY_ORG_FILTERS)
  const [page, setPage] = useState(1)
  // mặc định sắp theo sơ đồ tổ chức (Phòng ban → Team → cấp chức danh → tên)
  // thay vì hiển thị ngẫu nhiên. Excel (attendance-export.service.ts) luôn dùng cùng thứ tự.
  const [sortBy, setSortBy] = useState<SortCol>("org")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [detailId, setDetailId] = useState<number | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const list = useAttendanceList({
    date_from: dateFrom,
    date_to: dateTo,
    user_id: userId,
    search: search || undefined,
    status: statusFilter || undefined,
    team_id: isAdmin ? orgFilters.teamId : undefined,
    department: isAdmin ? (orgFilters.department || undefined) : undefined,
    job_title_id: isAdmin ? orgFilters.jobTitleId : undefined,
    page,
    page_size: 10,
    sort_by: sortBy,
    sort_dir: sortDir,
  })
  const shift = useAttendanceSettings()
  const lateAfter = shift.data?.late_after ?? "08:10"

  function toggleSort(col: SortCol) {
    if (col === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortBy(col)
      setSortDir("asc")
    }
    setPage(1)
  }

  function handleSearchChange(v: string) {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      setSearch(v)
      setPage(1)
    }, 300)
  }

  function patchOrgFilter(patch: Partial<OrgFilterValues>) {
    setOrgFilters((f) => ({ ...f, ...patch }))
    setPage(1)
  }

  // Ô tìm nhân viên (admin): trên điện thoại ở NGOÀI bảng lọc, desktop giữ vị trí cũ.
  const searchField = (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">
        Tìm nhân viên
      </label>
      <Input
        type="text"
        placeholder="Tên nhân viên..."
        defaultValue={search}
        onChange={(e) => handleSearchChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (searchTimerRef.current)
              clearTimeout(searchTimerRef.current)
            setSearch(e.currentTarget.value)
            setPage(1)
          }
        }}
        className="h-8 w-[200px] text-sm max-sm:h-11 max-sm:w-full"
      />
    </div>
  )

  const activeFilterCount =
    (dateFrom !== today || dateTo !== today ? 1 : 0) +
    (statusFilter ? 1 : 0) +
    (isAdmin
      ? (orgFilters.department ? 1 : 0) +
        (orgFilters.teamId !== undefined ? 1 : 0) +
        (orgFilters.jobTitleId !== undefined ? 1 : 0)
      : 0)

  function resetFilters() {
    setDateFrom(today)
    setDateTo(today)
    setDateFromText(isoToVnDate(today))
    setDateToText(isoToVnDate(today))
    setStatusFilter("")
    setOrgFilters(EMPTY_ORG_FILTERS)
    setPage(1)
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Lịch sử chấm công</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            {isAdmin && isPhone && searchField}
            <MobileFilterSheet activeCount={activeFilterCount} onReset={resetFilters}>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Từ ngày</label>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="DD/MM/YYYY"
                value={dateFromText}
                onChange={(e) => {
                  const masked = autoMaskVnDate(e.target.value)
                  setDateFromText(masked)
                  const iso = parseVnDate(masked)
                  if (iso) {
                    setDateFrom(iso)
                    setPage(1)
                  }
                }}
                className="h-8 w-[140px] text-sm max-sm:h-11 max-sm:w-full"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Đến ngày</label>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="DD/MM/YYYY"
                value={dateToText}
                onChange={(e) => {
                  const masked = autoMaskVnDate(e.target.value)
                  setDateToText(masked)
                  const iso = parseVnDate(masked)
                  if (iso) {
                    setDateTo(iso)
                    setPage(1)
                  }
                }}
                className="h-8 w-[140px] text-sm max-sm:h-11 max-sm:w-full"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Trạng thái</label>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(typeof v === "string" ? v : "")
                  setPage(1)
                }}
              >
                <SelectTrigger className="h-8 w-[180px] text-sm max-sm:h-11 max-sm:w-full">
                  <SelectValue placeholder="Tất cả trạng thái">
                    {(v) => {
                      if (typeof v !== "string") return null
                      return (
                        STATUS_OPTIONS.find((o) => o.value === v)?.label ??
                        "Tất cả trạng thái"
                      )
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isAdmin && !isPhone && searchField}
            {isAdmin && (
              <AttendanceOrgFilters value={orgFilters} onChange={patchOrgFilter} />
            )}
            </MobileFilterSheet>
          </div>

          <AttendanceHistoryTable
            rows={list.data?.data ?? []}
            isLoading={list.isLoading}
            isAdmin={isAdmin}
            lateAfter={lateAfter}
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={toggleSort}
            page={page}
            pagination={list.data?.pagination}
            onPageChange={setPage}
            onRowClick={setDetailId}
          />
        </CardContent>
      </Card>

      <AttendanceDetailDialog
        recordId={detailId}
        canEdit={canEdit}
        canDelete={canDelete ?? isAdmin}
        onClose={() => setDetailId(null)}
      />
    </>
  )
}
