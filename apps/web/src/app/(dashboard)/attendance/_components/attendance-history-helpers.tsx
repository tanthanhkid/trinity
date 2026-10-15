"use client"

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { TableHead } from "@/components/ui/table"

export const STATUS_BADGE: Record<
  string,
  { label: string; cls: string; dot: string }
> = {
  present: {
    label: "Đủ công",
    cls: "border-emerald-300 bg-emerald-100 text-emerald-800",
    dot: "bg-emerald-500",
  },
  // 'late' không còn được ghi mới; giữ entry để hiển thị bản ghi cũ
  late: {
    label: "Đủ công",
    cls: "border-emerald-300 bg-emerald-100 text-emerald-800",
    dot: "bg-emerald-500",
  },
  half_day: {
    label: "Nửa ngày",
    cls: "border-blue-300 bg-blue-100 text-blue-800",
    dot: "bg-blue-500",
  },
  insufficient: {
    label: "Chưa đủ nửa ngày",
    cls: "border-orange-300 bg-orange-100 text-orange-800",
    dot: "bg-orange-500",
  },
  incomplete: {
    label: "Chưa đủ",
    cls: "border-slate-300 bg-slate-100 text-slate-700",
    dot: "bg-slate-400",
  },
  review: {
    label: "Xem xét",
    cls: "border-red-300 bg-red-100 text-red-800",
    dot: "bg-red-500",
  },
  leave: {
    label: "Nghỉ phép",
    cls: "border-purple-300 bg-purple-100 text-purple-800",
    dot: "bg-purple-500",
  },
  maternity: {
    label: "Thai sản",
    cls: "border-pink-300 bg-pink-100 text-pink-800",
    dot: "bg-pink-500",
  },
}

export const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Tất cả trạng thái" },
  { value: "present", label: "Đủ công" },
  { value: "half_day", label: "Nửa ngày" },
  { value: "insufficient", label: "Chưa đủ nửa ngày" },
  { value: "review", label: "Xem xét" },
  { value: "incomplete", label: "Chưa đủ" },
  { value: "leave", label: "Nghỉ phép" },
  { value: "maternity", label: "Thai sản" },
]

export function timeVnHistory(iso: string | null): string {
  if (!iso) return "--:--"
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

export type SortCol =
  | "work_date"
  | "employee"
  | "check_in"
  | "check_out"
  | "total_hours"
  | "status"
  /** Sắp theo sơ đồ tổ chức: Phòng ban → Team → cấp chức danh → tên. */
  | "org"

export function SortableHead({
  label,
  col,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string
  col: SortCol
  sortBy: SortCol
  sortDir: "asc" | "desc"
  onSort: (c: SortCol) => void
}) {
  const active = sortBy === col
  return (
    <TableHead
      className="cursor-pointer select-none whitespace-nowrap"
      onClick={() => onSort(col)}
      title="Bấm để sắp xếp"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ArrowUp className="size-3.5" />
          ) : (
            <ArrowDown className="size-3.5" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </span>
    </TableHead>
  )
}

export function nameToneClass(
  checkInAt: string | null,
  lateMinutes: number | null,
): string {
  if (!checkInAt) return ""
  return (lateMinutes ?? 0) > 0
    ? "rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900"
    : "rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-900"
}
