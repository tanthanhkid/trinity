"use client"

import { useState, type ReactNode } from "react"
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Download } from "lucide-react"
import { toast } from "sonner"
import apiClient from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { todayVn, isoToVnDate, parseVnDate, autoMaskVnDate } from "@/lib/format"
import {
  useAbsentEmployees,
  type AbsentEmployee,
  type AbsentSortColumn,
} from "@/hooks/use-attendance"

const PAGE_SIZE = 10

/** Màu nền nhạt luân phiên theo TEAM (nhóm cùng team → cùng màu) — khớp Excel. */
const TEAM_BG = [
  "bg-emerald-50",
  "bg-blue-50",
  "bg-amber-50",
  "bg-purple-50",
  "bg-pink-50",
  "bg-cyan-50",
  "bg-yellow-50",
  "bg-orange-50",
]

function genderLabel(g: string | null): string {
  if (g === "M") return "Nam"
  if (g === "F") return "Nữ"
  return "—"
}

const COLUMNS: {
  key: AbsentSortColumn
  label: string
  cell: (e: AbsentEmployee) => ReactNode
}[] = [
  {
    key: "employee_code",
    label: "Mã NV",
    cell: (e) => <span className="font-mono text-xs">{e.employee_code}</span>,
  },
  {
    key: "full_name",
    label: "Họ tên",
    cell: (e) => (
      <span className="font-medium">
        {e.full_name ?? e.email ?? `NV #${e.user_id}`}
      </span>
    ),
  },
  { key: "phone", label: "SĐT", cell: (e) => e.phone ?? "—" },
  { key: "email", label: "Email", cell: (e) => e.email ?? "—" },
  { key: "team", label: "Team", cell: (e) => e.team_name ?? "—" },
  { key: "position", label: "Chức danh", cell: (e) => e.position ?? "—" },
  { key: "department", label: "Bộ phận", cell: (e) => e.department ?? "—" },
  { key: "gender", label: "Giới tính", cell: (e) => genderLabel(e.gender) },
  { key: "office_name", label: "Văn phòng", cell: (e) => e.office_name ?? "—" },
]

/**
 * Bảng NV VẮNG (chưa chấm vào lẫn ra) — ô chọn ngày riêng (mặc định hôm nay), cột bấm-để-sort
 * (server-side), tô màu theo Team, phân trang 10/trang. Xuất Excel theo ĐÚNG ngày + sort đang xem.
 */
export function AttendanceAbsentTable({
  initialDate,
  enabled,
}: {
  initialDate?: string
  enabled: boolean
}) {
  const [date, setDate] = useState<string>(initialDate ?? todayVn())
  const [dateText, setDateText] = useState<string>(
    isoToVnDate(initialDate ?? todayVn()),
  )
  const [sortBy, setSortBy] = useState<AbsentSortColumn>("team") // ưu tiên theo Team
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)

  const { data, isLoading } = useAbsentEmployees(date, sortBy, sortDir, enabled)
  const employees = data?.absent_employees ?? []

  const total = employees.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * PAGE_SIZE
  const pageRows = employees.slice(start, start + PAGE_SIZE)

  // Map team_id → class màu (theo thứ tự xuất hiện trong list đã sort). Tính trong render (thuần).
  const teamColor = new Map<number, string>()
  let teamSeq = 0
  for (const e of employees) {
    if (e.team_id == null) continue
    if (!teamColor.has(e.team_id)) {
      teamColor.set(e.team_id, TEAM_BG[teamSeq % TEAM_BG.length])
      teamSeq += 1
    }
  }

  function handleSort(col: AbsentSortColumn) {
    if (col === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortBy(col)
      setSortDir("asc")
    }
    setPage(1) // đổi sort → về trang 1 (event handler, không useEffect)
  }

  function handleDateChange(raw: string) {
    const masked = autoMaskVnDate(raw)
    setDateText(masked)
    const iso = parseVnDate(masked)
    if (iso) {
      setDate(iso)
      setPage(1)
    }
  }

  async function handleExport() {
    setExporting(true)
    try {
      const res = await apiClient.get<Blob>(
        "/management/attendance/absent-export",
        {
          params: { date, sort_by: sortBy, sort_dir: sortDir },
          responseType: "blob",
        },
      )
      const blob = res.data
      if (!blob || blob.size === 0) throw new Error("empty")
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `nv-chua-cham-cong_${date}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      toast.success("Đã xuất Excel danh sách nhân viên chưa chấm công.")
    } catch {
      toast.error("Xuất Excel thất bại. Vui lòng thử lại.")
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-red-200 bg-red-50/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-red-700">
          <AlertTriangle className="size-4" />
          Nhân viên chưa chấm công (vắng)
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
            {total}
          </span>
        </p>
        {total > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={exporting}
            onClick={handleExport}
          >
            <Download className="size-4" />
            {exporting ? "Đang tải…" : "Xuất Excel"}
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Chọn ngày</label>
        <Input
          type="text"
          inputMode="numeric"
          placeholder="DD/MM/YYYY"
          value={dateText}
          onChange={(e) => handleDateChange(e.target.value)}
          className="h-8 w-[160px] text-sm"
        />
      </div>

      {isLoading && !data ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Đang tải danh sách…
        </p>
      ) : total === 0 ? (
        <p className="py-6 text-center text-sm font-medium text-emerald-600">
          🎉 Tất cả nhân viên đã chấm công.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-red-100 bg-card">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="border-b bg-red-50 text-left text-xs text-red-700">
                  {COLUMNS.map((col) => (
                    <th key={col.key} className="px-3 py-2 font-semibold">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-red-900"
                        onClick={() => handleSort(col.key)}
                      >
                        {col.label}
                        {sortBy === col.key ? (
                          sortDir === "asc" ? (
                            <ArrowUp className="size-3" />
                          ) : (
                            <ArrowDown className="size-3" />
                          )
                        ) : (
                          <ArrowUpDown className="size-3 opacity-40" />
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((e) => (
                  <tr
                    key={e.user_id}
                    className={cn(
                      "border-b last:border-0",
                      e.team_id != null ? teamColor.get(e.team_id) : undefined,
                    )}
                  >
                    {COLUMNS.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          "px-3 py-2",
                          col.key !== "employee_code" &&
                            col.key !== "full_name" &&
                            "text-muted-foreground",
                        )}
                      >
                        {col.cell(e)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {start + 1}–{Math.min(start + PAGE_SIZE, total)} / {total}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Trước
                </Button>
                <span className="tabular-nums">
                  {safePage} / {totalPages}
                </span>
                <Button
                  type="button"
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
        </>
      )}
    </div>
  )
}
