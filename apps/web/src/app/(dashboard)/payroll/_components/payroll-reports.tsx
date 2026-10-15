"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { DollarSign, TrendingUp, TrendingDown, Users } from "lucide-react"
import apiClient from "@/lib/api-client"

// BE trả BigInt dưới dạng chuỗi (vd "12000000"). Mọi field tiền là string.
interface SummaryResponse {
  month: string
  total_employees: number
  total_base_salary: string
  total_kpi_bonus: string
  total_deductions: string
  total_payroll_cost: string
}

// GET /reports/by-department trả MẢNG TRỰC TIẾP (không bọc { data }).
interface DepartmentBreakdown {
  department: string
  employee_count: number
  total_base_salary: string
  total_kpi_bonus: string
  total_deductions: string
  total_cost: string
}

interface MonthComparison {
  month: string
  total_payroll_cost: string
  employee_count: number
}

function getCurrentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

function prevMonth(ym: string) {
  const [y, m] = ym.split("-").map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

function formatMonth(ym: string) {
  const [y, m] = ym.split("-")
  return `Tháng ${m}/${y}`
}

function buildMonthOptions() {
  const opts: string[] = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    opts.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`)
  }
  return opts
}

// Nhận number | string (BE trả chuỗi) — luôn Number() trước khi format.
function fmtCurrency(n: number | string | null | undefined) {
  return Number(n ?? 0).toLocaleString("vi-VN") + " VNĐ"
}

export function PayrollReports() {
  const months = buildMonthOptions()
  const [month, setMonth] = useState(getCurrentMonth())

  const summaryQuery = useQuery<SummaryResponse>({
    queryKey: ["payroll-report-summary", month],
    queryFn: async () => {
      const res = await apiClient.get<SummaryResponse>("/reports/summary", {
        params: { month },
      })
      return res.data
    },
  })

  const deptQuery = useQuery<DepartmentBreakdown[]>({
    queryKey: ["payroll-report-dept", month],
    queryFn: async () => {
      const res = await apiClient.get<DepartmentBreakdown[]>("/reports/by-department", {
        params: { month },
      })
      return res.data
    },
  })

  const comparisonQuery = useQuery<MonthComparison[]>({
    queryKey: ["payroll-report-comparison", month],
    queryFn: async () => {
      const res = await apiClient.get<MonthComparison[]>("/reports/comparison", {
        params: { months: `${prevMonth(month)},${month}` },
      })
      return res.data
    },
  })

  const summary = summaryQuery.data
  const depts = deptQuery.data ?? []
  const totalCost = Number(summary?.total_payroll_cost ?? 0)

  // % thay đổi so với tháng trước (tính từ endpoint comparison, guard prev=0).
  // BE getComparison trả mảng THEO ĐÚNG THỨ TỰ input months → cmp[0]=tháng trước, cmp[1]=tháng này.
  let changePct: number | null = null
  const cmp = comparisonQuery.data
  if (cmp && cmp.length >= 2) {
    const prev = Number(cmp[0]?.total_payroll_cost ?? 0)
    const cur = Number(cmp[1]?.total_payroll_cost ?? 0)
    if (prev > 0) changePct = ((cur - prev) / prev) * 100
  }

  // pct mỗi phòng ban = total_cost / tổng tất cả phòng (tính FE — BE không trả pct)
  const deptTotal = depts.reduce((s, d) => s + Number(d.total_cost ?? 0), 0)

  const breakdown = [
    { label: "Lương cơ bản", value: summary?.total_base_salary },
    { label: "Thưởng KPI", value: summary?.total_kpi_bonus },
    { label: "Khấu trừ", value: summary?.total_deductions },
  ]

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select value={month} onValueChange={(v) => typeof v === "string" && setMonth(v)}>
          <SelectTrigger className="h-11 w-44 rounded-xl max-sm:w-full">
            <SelectValue placeholder="Chọn tháng">
              {(v) => (typeof v === "string" && v ? formatMonth(v) : null)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m} value={m}>{formatMonth(m)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="shadow-[0_4px_16px_rgba(0,0,0,0.06)] rounded-2xl">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Tổng chi phí lương {formatMonth(month)}
          </CardTitle>
          <DollarSign className="h-5 w-5 text-[var(--color-app-primary-ink)]" />
        </CardHeader>
        <CardContent>
          {summaryQuery.isLoading ? (
            <Skeleton className="h-9 w-48" />
          ) : summaryQuery.isError ? (
            <p className="text-red-500 text-sm">Không thể tải dữ liệu</p>
          ) : (
            <>
              {/* Dạng thẻ số: đây là MỘT khoản tiền duy nhất kèm một
                  mức thay đổi so tháng trước — không phải phần của tổng nào,
                  không xếp hạng với ai. Biểu đồ xu hướng cần CHUỖI theo tháng
                  mà endpoint này chỉ trả 2 mốc (tháng này / tháng trước); vẽ
                  đường từ 2 điểm là bịa ra một xu hướng không đo được. Bảng
                  chi tiết ngay dưới đã có đủ số theo từng nhân viên. */}
              <p className="text-3xl font-bold">{fmtCurrency(totalCost)}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                {changePct !== null && (
                  <span className={`text-sm flex items-center gap-1 ${changePct >= 0 ? "text-red-500" : "text-[var(--color-app-primary-ink)]"}`}>
                    {changePct >= 0
                      ? <TrendingUp className="h-3.5 w-3.5" />
                      : <TrendingDown className="h-3.5 w-3.5" />}
                    {changePct >= 0 ? "+" : ""}{changePct.toFixed(1)}% so với tháng trước
                  </span>
                )}
                <span className="text-sm text-muted-foreground flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  {summary?.total_employees ?? 0} phiếu lương
                </span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {breakdown.map((b) => (
                  <div key={b.label} className="rounded-xl bg-muted/50 px-3 py-2">
                    <p className="text-xs text-muted-foreground">{b.label}</p>
                    <p className="text-sm font-semibold">{fmtCurrency(b.value)}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-[0_4px_16px_rgba(0,0,0,0.06)] rounded-2xl">
        <CardHeader>
          <CardTitle>Chi phí theo phòng ban</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {deptQuery.isLoading && Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
          {deptQuery.isError && (
            <p className="text-red-500 text-sm">Không thể tải chi phí theo phòng ban</p>
          )}
          {!deptQuery.isLoading && !deptQuery.isError && depts.length === 0 && (
            <p className="text-muted-foreground text-sm text-center py-4">
              Chưa có dữ liệu cho {formatMonth(month)}
            </p>
          )}
          {depts.map((d, i) => {
            const cost = Number(d.total_cost ?? 0)
            const pct = deptTotal > 0 ? (cost / deptTotal) * 100 : 0
            return (
              <div key={d.department}>
                {i > 0 && <Separator className="mb-4" />}
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-medium">
                    {d.department}
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({d.employee_count} người)
                    </span>
                  </span>
                  <span className="text-sm text-muted-foreground">{fmtCurrency(cost)}</span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-[var(--color-app-primary)] transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
