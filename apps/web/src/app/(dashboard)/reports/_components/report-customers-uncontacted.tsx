"use client"

import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import apiClient from "@/lib/api-client"
import { formatDate } from "@/lib/format"

interface UncontactedRow {
  id: number
  full_name: string | null
  phone: string
  // `assigned_to` có mặt trong payload để BE nhận ra người phụ trách khi áp
  // quy tắc che SĐT — FE không cần hiển thị field này, chỉ dùng `assignee_name`.
  assigned_to: number | null
  assignee_name: string | null
  created_at: string
}

interface UncontactedResponse {
  rows: UncontactedRow[]
  next_cursor: number | null
  days: number
}

const DAY_OPTIONS = [7, 14, 30] as const

/**
 * "Khách chưa được chăm sóc quá N ngày" — cursor pagination (id desc), SĐT
 * đã che theo đúng quy tắc Danh bạ (interceptor BE), FE chỉ hiển thị nguyên
 * chuỗi trả về.
 */
export function ReportCustomersUncontacted() {
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(7)
  const [cursorStack, setCursorStack] = useState<Array<number | undefined>>([undefined])
  const [pageIndex, setPageIndex] = useState(0)

  const cursor = cursorStack[pageIndex]

  const { data, isLoading } = useQuery<UncontactedResponse>({
    queryKey: ["report-customers-uncontacted", days, cursor],
    queryFn: () =>
      apiClient
        .get("/reports/customers/uncontacted", { params: { days, cursor } })
        .then((r) => r.data),
  })

  const handleDaysChange = (d: (typeof DAY_OPTIONS)[number]) => {
    if (d === days) return
    setDays(d)
    setCursorStack([undefined])
    setPageIndex(0)
  }

  const goNext = () => {
    if (!data?.next_cursor) return
    const next = [...cursorStack]
    next[pageIndex + 1] = data.next_cursor
    setCursorStack(next)
    setPageIndex((p) => p + 1)
  }

  const goPrev = () => {
    if (pageIndex === 0) return
    setPageIndex((p) => p - 1)
  }

  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 shadow-[var(--shadow-card)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Khách chưa được chăm sóc</p>
        <div className="flex items-center gap-1">
          {DAY_OPTIONS.map((d) => (
            <Button
              key={d}
              type="button"
              size="sm"
              variant={d === days ? "soft" : "outline"}
              aria-pressed={d === days}
              className="h-8 rounded-xl text-xs"
              onClick={() => handleDaysChange(d)}
            >
              {d} ngày
            </Button>
          ))}
        </div>
      </div>

      <ShellResponsiveList
        table={<div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">Khách hàng</th>
              <th className="pb-2 pr-3 font-medium">SĐT</th>
              <th className="pb-2 pr-3 font-medium">Người phụ trách</th>
              <th className="pb-2 font-medium">Ngày tạo</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted-foreground">
                  Đang tải...
                </td>
              </tr>
            ) : !data || data.rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted-foreground">
                  Không có khách nào quá {days} ngày chưa được chăm sóc.
                </td>
              </tr>
            ) : (
              data.rows.map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="py-2 pr-3">{row.full_name ?? "—"}</td>
                  <td className="py-2 pr-3 tabular-nums">{row.phone}</td>
                  <td className="py-2 pr-3">{row.assignee_name ?? "Chưa gán"}</td>
                  <td className="py-2">{formatDate(row.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>}
        cards={
          <div className="space-y-3">
            {isLoading ? (
              <p className="py-6 text-center text-muted-foreground">Đang tải...</p>
            ) : !data || data.rows.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground">
                Không có khách nào quá {days} ngày chưa được chăm sóc.
              </p>
            ) : (
              data.rows.map((row) => (
                <ShellListCard key={row.id}>
                  <p className="font-semibold">{row.full_name ?? "—"}</p>
                  <ShellListCardRow label="SĐT" value={<span className="tabular-nums">{row.phone}</span>} />
                  <ShellListCardRow label="Người phụ trách" value={row.assignee_name ?? "Chưa gán"} />
                  <ShellListCardRow label="Ngày tạo" value={formatDate(row.created_at)} />
                </ShellListCard>
              ))
            )}
          </div>
        }
      />

      <div className="mt-3 flex items-center justify-end gap-2 max-sm:[&>*]:flex-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn("h-8 rounded-xl text-xs", pageIndex === 0 && "opacity-50")}
          disabled={pageIndex === 0}
          onClick={goPrev}
        >
          Trang trước
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn("h-8 rounded-xl text-xs", !data?.next_cursor && "opacity-50")}
          disabled={!data?.next_cursor}
          onClick={goNext}
        >
          Trang sau
        </Button>
      </div>
    </div>
  )
}
