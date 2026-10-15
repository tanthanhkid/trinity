"use client"

import { CalendarX2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { ShellTableEmptyRow } from "@/components/app-shell/table-empty-row"
import { formatDate } from "@/lib/format"
import type { AttendanceRecord } from "@/hooks/use-attendance"
import {
  STATUS_BADGE,
  SortableHead,
  nameToneClass,
  timeVnHistory,
  type SortCol,
} from "./attendance-history-helpers"

interface Pagination {
  page: number
  total_pages: number
  total: number
}

interface AttendanceHistoryTableProps {
  rows: AttendanceRecord[]
  isLoading: boolean
  isAdmin: boolean
  lateAfter: string
  sortBy: SortCol
  sortDir: "asc" | "desc"
  onSort: (col: SortCol) => void
  page: number
  pagination?: Pagination
  onPageChange: (p: number) => void
  onRowClick: (id: number) => void
}

export function AttendanceHistoryTable({
  rows,
  isLoading,
  isAdmin,
  lateAfter,
  sortBy,
  sortDir,
  onSort,
  page,
  pagination,
  onPageChange,
  onRowClick,
}: AttendanceHistoryTableProps) {
  const colSpan = isAdmin ? 9 : 6

  const desktopTable = (
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead
                label="Ngày"
                col="work_date"
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={onSort}
              />
              {isAdmin && (
                <SortableHead
                  label="Nhân viên"
                  col="employee"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSort={onSort}
                />
              )}
              {isAdmin && (
                <TableHead className="whitespace-nowrap">Team</TableHead>
              )}
              {isAdmin && (
                <TableHead className="whitespace-nowrap">Phòng ban</TableHead>
              )}
              <SortableHead
                label="Vào"
                col="check_in"
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={onSort}
              />
              <SortableHead
                label="Ra"
                col="check_out"
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={onSort}
              />
              <SortableHead
                label="Tổng giờ"
                col="total_hours"
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={onSort}
              />
              <SortableHead
                label="Trạng thái"
                col="status"
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={onSort}
              />
              <TableHead className="whitespace-nowrap">Ghi chú</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <ShellTableEmptyRow colSpan={colSpan}>Đang tải...</ShellTableEmptyRow>
            ) : rows.length === 0 ? (
              <ShellTableEmptyRow colSpan={colSpan}>
                Không có dữ liệu chấm công.
              </ShellTableEmptyRow>
            ) : (
              rows.map((rec) => {
                const badge = STATUS_BADGE[rec.status] ?? {
                  label: rec.status,
                  cls: "border-slate-300 bg-slate-100 text-slate-700",
                  dot: "bg-slate-400",
                }
                return (
                  <TableRow
                    key={rec.id}
                    className="cursor-pointer"
                    onClick={() => onRowClick(rec.id)}
                  >
                    <TableCell>{formatDate(rec.work_date)}</TableCell>
                    {isAdmin && (
                      <TableCell className="max-w-[180px]">
                        <span
                          className={nameToneClass(
                            rec.check_in_at,
                            rec.late_minutes,
                          )}
                        >
                          {rec.user?.full_name ?? `NV #${rec.user_id}`}
                        </span>
                      </TableCell>
                    )}
                    {isAdmin && (
                      <TableCell className="text-sm text-muted-foreground">
                        {rec.user?.employee?.team_name || "—"}
                      </TableCell>
                    )}
                    {isAdmin && (
                      <TableCell className="text-sm text-muted-foreground">
                        {rec.user?.employee?.department || "—"}
                      </TableCell>
                    )}
                    <TableCell>
                      <span
                        className={
                          (rec.late_minutes ?? 0) > 0
                            ? "font-semibold text-amber-700"
                            : undefined
                        }
                      >
                        {timeVnHistory(rec.check_in_at)}
                      </span>
                    </TableCell>
                    <TableCell>{timeVnHistory(rec.check_out_at)}</TableCell>
                    <TableCell>
                      {rec.total_hours != null ? `${rec.total_hours}h` : "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.cls}`}
                      >
                        <span className={`size-1.5 rounded-full ${badge.dot}`} />
                        {badge.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {rec.late_minutes && rec.late_minutes > 0 ? (
                        <span className="text-amber-700">
                          Đi muộn {rec.late_minutes} phút (sau {lateAfter})
                        </span>
                      ) : rec.check_in_at ? (
                        <span className="text-emerald-600">Đúng giờ</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
  )

  const mobileCards = isLoading ? (
    <p className="py-8 text-center text-sm text-muted-foreground">Đang tải...</p>
  ) : rows.length === 0 ? (
    <ShellEmptyState icon={CalendarX2} description="Không có dữ liệu chấm công." />
  ) : (
    <div className="space-y-3">
      {rows.map((rec) => {
        const badge = STATUS_BADGE[rec.status] ?? {
          label: rec.status,
          cls: "border-slate-300 bg-slate-100 text-slate-700",
          dot: "bg-slate-400",
        }
        return (
          <ShellListCard key={rec.id} onClick={() => onRowClick(rec.id)}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{formatDate(rec.work_date)}</span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.cls}`}
              >
                <span className={`size-1.5 rounded-full ${badge.dot}`} />
                {badge.label}
              </span>
            </div>
            {isAdmin && (
              <ShellListCardRow
                label="Nhân viên"
                value={
                  <span
                    className={nameToneClass(rec.check_in_at, rec.late_minutes)}
                  >
                    {rec.user?.full_name ?? `NV #${rec.user_id}`}
                  </span>
                }
              />
            )}
            {isAdmin && (
              <ShellListCardRow
                label="Team / Phòng ban"
                value={`${rec.user?.employee?.team_name || "—"} / ${rec.user?.employee?.department || "—"}`}
              />
            )}
            <ShellListCardRow
              label="Vào — Ra"
              value={`${timeVnHistory(rec.check_in_at)} — ${timeVnHistory(rec.check_out_at)}`}
            />
            <ShellListCardRow
              label="Tổng giờ"
              value={rec.total_hours != null ? `${rec.total_hours}h` : "—"}
            />
            <ShellListCardRow
              label="Ghi chú"
              value={
                rec.late_minutes && rec.late_minutes > 0 ? (
                  <span className="text-amber-700">
                    Đi muộn {rec.late_minutes} phút (sau {lateAfter})
                  </span>
                ) : rec.check_in_at ? (
                  <span className="text-emerald-600">Đúng giờ</span>
                ) : (
                  "—"
                )
              }
            />
          </ShellListCard>
        )
      })}
    </div>
  )

  return (
    <>
      <ShellResponsiveList table={desktopTable} cards={mobileCards} />

      {pagination && pagination.total_pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Trang {pagination.page}/{pagination.total_pages} · {pagination.total}{" "}
            bản ghi
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => onPageChange(Math.max(1, page - 1))}
            >
              Trước
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pagination.total_pages}
              onClick={() => onPageChange(page + 1)}
            >
              Sau
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
