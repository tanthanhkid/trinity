"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, FileSpreadsheet } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import apiClient, { getApiErrorMessage } from "@/lib/api-client"
import { Can } from "@/lib/rbac"
import { todayVn } from "@/lib/format"
import { DateRangeFilter, type DateRange } from "./date-range-filter"
import { MobileExportMenu } from "./charts/mobile-export-menu"
import { MobileSortBar } from "./mobile-sort-bar"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"

interface EmployeePerformanceRow {
  user_id: number
  full_name: string
  email: string
  new_customers: number
  activities_count: number
}

type SortKey = Exclude<keyof EmployeePerformanceRow, "user_id" | "email">

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "full_name", label: "Nhân viên" },
  { key: "new_customers", label: "Khách mới được giao" },
  { key: "activities_count", label: "Số hoạt động" },
]

/** Tab "Hiệu suất nhân viên" — bảng xếp hạng nhân viên. */
export function ReportEmployeePerformance() {
  const [dateRange, setDateRange] = useState<DateRange>({
    date_from: todayVn(),
    date_to: todayVn(),
  })
  const [sortKey, setSortKey] = useState<SortKey>("new_customers")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [exporting, setExporting] = useState(false)

  const { data, isLoading } = useQuery<EmployeePerformanceRow[]>({
    queryKey: ["report-employee-performance", dateRange],
    queryFn: () =>
      apiClient
        .get("/reports/employee-performance", { params: dateRange })
        .then((r) => r.data),
  })

  const sorted = useMemo(() => {
    const rows = data ?? []
    const dir = sortDir === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv), "vi") * dir
      }
      return ((av as number) - (bv as number)) * dir
    })
  }, [data, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("desc")
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const res = await apiClient.get("/reports/employee-performance/export", {
        params: dateRange,
        responseType: "blob",
      })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `hieu-suat-nhan-vien-${dateRange.date_to}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(getApiErrorMessage(e, "Xuất file không thành công"))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-foreground">Hiệu suất nhân viên</h2>
        <div className="flex items-center gap-2">
          <DateRangeFilter value={dateRange} onChange={setDateRange} />
          <Can perm="reports.export">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 rounded-xl text-sm max-sm:hidden"
            disabled={exporting || isLoading || (data ?? []).length === 0}
            onClick={handleExport}
          >
            <FileSpreadsheet className="size-4" />
            Xuất Excel
          </Button>
          {/* điện thoại — "Xuất Excel" vào menu "⋯" */}
          <MobileExportMenu
            onExport={handleExport}
            isExporting={exporting || isLoading || (data ?? []).length === 0}
          />
          </Can>
        </div>
      </div>

      <MobileSortBar
        options={COLUMNS}
        value={sortKey}
        dir={sortDir}
        onKeyChange={(k) => {
          setSortKey(k)
          setSortDir("desc")
        }}
        onDirToggle={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
      />
      <ShellResponsiveList
        table={
      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              {COLUMNS.map((col) => (
                <th key={col.key} className="px-3 py-2 font-medium">
                  <button
                    type="button"
                    className="flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.label}
                    {sortKey === col.key &&
                      (sortDir === "asc" ? (
                        <ArrowUp className="size-3" />
                      ) : (
                        <ArrowDown className="size-3" />
                      ))}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={COLUMNS.length} className="py-6 text-center text-muted-foreground">
                  Đang tải...
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="py-6 text-center text-muted-foreground">
                  Không có dữ liệu trong kỳ đã chọn.
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr key={row.user_id} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <div>{row.full_name}</div>
                    <div className="text-xs text-muted-foreground">{row.email}</div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{row.new_customers}</td>
                  <td className="px-3 py-2 tabular-nums">{row.activities_count}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
        }
        cards={
          <div className="space-y-3">
            {isLoading ? (
              <p className="py-6 text-center text-muted-foreground">Đang tải...</p>
            ) : sorted.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground">Không có dữ liệu trong kỳ đã chọn.</p>
            ) : (
              sorted.map((row) => (
                <ShellListCard key={row.user_id}>
                  <p className="font-semibold">{row.full_name}</p>
                  <p className="truncate text-xs text-muted-foreground">{row.email}</p>
                  <ShellListCardRow label="Khách mới được giao" value={row.new_customers} />
                  <ShellListCardRow label="Số hoạt động" value={row.activities_count} />
                </ShellListCard>
              ))
            )}
          </div>
        }
      />
    </div>
  )
}
