"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { FileBarChart, LayoutTemplate, Pencil, Plus } from "lucide-react"
import apiClient from "@/lib/api-client"
import { todayVn } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { MonthPicker } from "@/components/ui/month-picker"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { BarChart } from "../charts/bar-chart"
import { ReportEditorDialog } from "./report-editor-dialog"
import { ReportPresetsDialog } from "./report-presets-dialog"
import {
  monthLabel, periodValue,
  type CustomReportList, type CustomReportResult, type PeriodKind,
} from "./custom-report-types"

const PERIOD_LABEL: Record<PeriodKind, string> = { this_month: "Tháng này", month: "Tháng…", year: "Năm…", all: "Tất cả" }
const num = (v: number) => v.toLocaleString("vi-VN", { maximumFractionDigits: 2 })

/**
 * Tab "Báo cáo tuỳ chỉnh" (#25) — báo cáo dùng chung cho MỌI bảng: quản trị viên cấu hình (bảng, trường ngày,
 * cột cộng tổng, trường nhóm), người khác chỉ xem; số liệu theo phạm vi quyền xem bảng của người xem.
 */
export function ReportCustom() {
  const list = useQuery<CustomReportList>({
    queryKey: ["custom-reports"],
    queryFn: () => apiClient.get("/reports/custom").then((r) => r.data),
  })
  const reports = list.data?.reports ?? []
  const canManage = list.data?.can_manage ?? false
  const [picked, setId] = useState<string>("")
  const [kind, setKind] = useState<PeriodKind>("this_month")
  const [month, setMonth] = useState(() => todayVn().slice(0, 7))
  const [year, setYear] = useState(() => todayVn().slice(0, 4))
  const [editor, setEditor] = useState<{ open: boolean; id?: string }>({ open: false })
  const [presetsOpen, setPresetsOpen] = useState(false)

  // Chưa chọn / báo cáo đang chọn bị xoá hoặc mất quyền → báo cáo đầu tiên.
  const id = reports.some((r) => r.id === picked) ? picked : (reports[0]?.id ?? "")

  const period = periodValue(kind, month, year)
  const result = useQuery<CustomReportResult>({
    queryKey: ["custom-report", id, period],
    queryFn: () => apiClient.get(`/reports/custom/${id}`, { params: { period } }).then((r) => r.data),
    enabled: !!id,
  })

  if (list.isLoading) return <Skeleton className="h-40 w-full" />

  const editorDialog = canManage && (
    <>
      <ReportEditorDialog
        open={editor.open}
        editId={editor.id}
        onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
        onSaved={(savedId) => savedId && setId(savedId)}
      />
      <ReportPresetsDialog open={presetsOpen} onOpenChange={setPresetsOpen} onInstalled={(first) => first && setId(first)} />
    </>
  )

  if (!reports.length) {
    return (
      <>
        <EmptyState
          icon={FileBarChart}
          title="Chưa có báo cáo"
          message={canManage
            ? "Tạo báo cáo cho bất kỳ bảng nào: chọn bảng, trường ngày để lọc theo tháng/năm, cột cần cộng tổng và cách nhóm."
            : "Quản trị viên chưa cấu hình báo cáo nào bạn xem được."}
          action={canManage ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setPresetsOpen(true)}><LayoutTemplate className="size-4" />Dùng báo cáo mẫu</Button>
              <Button variant="outline" onClick={() => setEditor({ open: true })}><Plus className="size-4" />Tự tạo báo cáo</Button>
            </div>
          ) : undefined}
        />
        {editorDialog}
      </>
    )
  }

  const years = Array.from({ length: 6 }, (_, i) => String(Number(todayVn().slice(0, 4)) - i))
  const data = result.data

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={id} onValueChange={(v) => v && setId(v)}>
          <SelectTrigger aria-label="Báo cáo" className="min-w-52 max-sm:w-full">
            <SelectValue>{(v) => reports.find((r) => r.id === v)?.name ?? "Chọn báo cáo"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {reports.map((r) => (
              <SelectItem key={r.id} value={r.id}>{r.name} <span className="text-muted-foreground">· {r.source_label}</span></SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(v) => v && setKind(v as PeriodKind)}>
          <SelectTrigger aria-label="Kỳ báo cáo" className="w-32">
            <SelectValue>{(v) => PERIOD_LABEL[v as PeriodKind]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PERIOD_LABEL) as PeriodKind[]).map((k) => <SelectItem key={k} value={k}>{PERIOD_LABEL[k]}</SelectItem>)}
          </SelectContent>
        </Select>
        {kind === "month" && <MonthPicker value={month} onChange={(v) => v && setMonth(v)} ariaLabel="Tháng" allowClear={false} className="w-36" />}
        {kind === "year" && (
          <Select value={year} onValueChange={(v) => v && setYear(v)}>
            <SelectTrigger aria-label="Năm" className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>{years.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {canManage && (
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => setEditor({ open: true, id })}><Pencil className="size-4" />Sửa</Button>
            <Button variant="outline" onClick={() => setEditor({ open: true })}><Plus className="size-4" />Thêm báo cáo</Button>
            <Button variant="outline" onClick={() => setPresetsOpen(true)}><LayoutTemplate className="size-4" />Mẫu</Button>
          </div>
        )}
      </div>

      {result.isError ? (
        <EmptyState icon={FileBarChart} message="Không chạy được báo cáo này — bảng hoặc trường có thể đã bị đổi. Quản trị viên mở Sửa để chọn lại." />
      ) : !data ? (
        <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : (
        <ReportBody data={data} />
      )}
      {editorDialog}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-4 py-3.5 shadow-[var(--shadow-card)]">
      <p className="truncate text-sm text-muted-foreground">{label}</p>
      <div className="mt-1 truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] text-foreground tabular-nums sm:text-[26px]">{value}</div>
      {hint && <p className="truncate text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ReportBody({ data }: { data: CustomReportResult }) {
  const sums = data.fields.sums
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Số bản ghi" value={num(data.count)} hint={`${data.period.label} · theo ${data.fields.date.toLowerCase()}`} />
        {sums.map((s) => <Stat key={s.key} label={`Tổng ${s.label.toLowerCase()}`} value={num(data.sums[s.key] ?? 0)} />)}
      </div>
      {data.missing_date > 0 && (
        <p className="text-sm text-muted-foreground">
          {num(data.missing_date)} bản ghi chưa có “{data.fields.date}” — chỉ tính trong kỳ Tất cả.
        </p>
      )}

      {data.fields.group && (
        <section className="space-y-2">
          <h3 className="text-[15px] font-semibold">Theo {data.fields.group.toLowerCase()}</h3>
          {data.groups.length ? (
            <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--muted)] text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{data.fields.group}</th>
                    <th className="px-3 py-2 text-right font-medium">Số bản ghi</th>
                    {sums.map((s) => <th key={s.key} className="px-3 py-2 text-right font-medium">{s.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((g) => (
                    <tr key={g.key ?? "__empty"} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2">{g.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(g.count)}</td>
                      {sums.map((s) => <td key={s.key} className="px-3 py-2 text-right tabular-nums">{num(g.sums[s.key] ?? 0)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Không có bản ghi trong kỳ.</p>
          )}
        </section>
      )}

      {data.by_month.length > 1 && (
        <section className="space-y-2">
          <h3 className="text-[15px] font-semibold">Theo tháng</h3>
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-3">
            <BarChart
              labels={data.by_month.map((m) => monthLabel(m.month))}
              series={[{ key: "count", label: "Số bản ghi", color: "var(--color-app-chart-1)", values: data.by_month.map((m) => m.count) }]}
              height={220}
            />
          </div>
        </section>
      )}
    </div>
  )
}
