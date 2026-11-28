"use client"

// «Phiếu của tôi» (luong-mobile): nhân viên xem phiếu của chính mình — chọn tháng, khối nhấn «Thực nhận»,
// nhóm Thu nhập / Khấu trừ gập được, cách tính lương theo công. Dữ liệu thật từ `GET /payslips/me`.
// Chừa chỗ (PR riêng, cần API + tool MCP): nút «Ẩn số» cạnh tiêu đề và «Tải phiếu PDF» cuối trang.
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import apiClient from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { HeroCard, HeroCardLabel, HeroCardValue } from "@/components/ui/hero-card"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { StageChip } from "@/components/ui/stage-chip"
import { Wallet } from "lucide-react"
import { type PayslipRow, formatMonth, statusLabel, statusTone } from "./payroll-payslips-shared"
import { buildMineGroups, mineStatusHint } from "./payroll-mine-model"

function Amount({ value, unit = "₫", className }: { value: string; unit?: string; className?: string }) {
  return (
    <span className={cn("ax-amount whitespace-nowrap", className)}>
      {value}
      <span className="ml-0.5 text-[0.8em] font-medium text-ax-ink-3">{unit}</span>
    </span>
  )
}

export function PayrollMine() {
  const { data, isLoading, isError } = useQuery<PayslipRow[]>({
    queryKey: ["payroll-payslips-me"],
    queryFn: async () => (await apiClient.get<PayslipRow[]>("/payslips/me")).data,
  })
  const [picked, setPicked] = useState<string | null>(null)
  const [open, setOpen] = useState({ inc: true, ded: false })

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-md space-y-3">
        <Skeleton className="h-11 w-full rounded-ax-card" />
        <Skeleton className="h-44 w-full rounded-ax-hero" />
        <Skeleton className="h-40 w-full rounded-ax-card" />
      </div>
    )
  }
  if (isError) return <p className="py-8 text-center text-sm text-ax-danger">Không thể tải phiếu lương của bạn.</p>
  // Mới nhất trước (BE); mỗi tháng lấy phiếu đầu. Tab hiện tối đa 6 tháng gần nhất, cuộn ngang được.
  const byMonth = new Map<string, PayslipRow>()
  for (const p of data ?? []) if (!byMonth.has(p.month)) byMonth.set(p.month, p)
  const months = Array.from(byMonth.keys()).slice(0, 6)
  if (months.length === 0) {
    return (
      <EmptyState
        variant="ax"
        icon={Wallet}
        title="Chưa có phiếu lương"
        message="Khi kế toán tạo phiếu lương cho bạn, phiếu sẽ hiện ở đây."
      />
    )
  }
  const month = picked && byMonth.has(picked) ? picked : months[0]
  const row = byMonth.get(month)!
  const groups = buildMineGroups(row)
  const label = `tháng ${Number(month.split("-")[1])}`

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="ax-text-title">Phiếu lương</h2>
        {/* Chừa chỗ: nút «Ẩn số» (PR riêng). */}
      </div>

      <div role="tablist" aria-label="Chọn tháng" className="-mx-1 flex gap-2 overflow-x-auto px-1 py-1">
        {months.map((m) => {
          const on = m === month
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setPicked(m)}
              className={cn(
                "h-11 min-w-24 flex-1 cursor-pointer rounded-[10px] px-3 text-[15px] font-semibold whitespace-nowrap",
                on ? "bg-ax-primary text-white" : "bg-ax-surface text-ax-ink shadow-[var(--ax-shadow-secondary)] hover:bg-ax-hover",
              )}
            >
              Tháng {Number(m.split("-")[1])}
              <span className="sr-only"> năm {m.split("-")[0]}</span>
            </button>
          )
        })}
      </div>

      <HeroCard>
        <div className="flex items-center justify-between gap-2">
          <HeroCardLabel>Thực nhận {label}</HeroCardLabel>
          <StageChip tone={statusTone(row.status)} size="sm" aria-label={`Trạng thái: ${statusLabel(row.status)}`}>
            {statusLabel(row.status)}
          </StageChip>
        </div>
        <HeroCardValue unit="₫" className="mt-2">{Number(row.total).toLocaleString("vi-VN")}</HeroCardValue>
        <p className="mt-2.5 text-sm leading-snug text-[var(--ax-on-hero-ink-2)]">{mineStatusHint(row)}</p>
      </HeroCard>

      <div className="ax-card overflow-hidden">
        {groups.map((g, i) => {
          const isOpen = open[g.key]
          return (
            <div key={g.key} className={cn(i > 0 && "border-t border-ax-divider")}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}
                className="flex min-h-[60px] w-full cursor-pointer items-center gap-3 px-4 text-left text-base"
              >
                <span className="flex-1 font-semibold">{g.title}</span>
                <Amount value={`${g.sign} ${g.sum}`} className={cn("text-base", g.key === "inc" ? "text-ax-success" : "text-ax-danger")} />
                <ChevronDown aria-hidden className={cn("size-4 text-ax-ink-3 transition-transform", isOpen && "rotate-180")} />
              </button>
              {isOpen && (
                <div className="px-4 pb-2">
                  {g.rows.map((r, j) => (
                    <div key={`${r.label}-${j}`} className="flex justify-between gap-3 border-t border-ax-divider py-2.5">
                      <div className="min-w-0">
                        <div className="text-[15px]">{r.label}</div>
                        <div className="mt-px text-[13px] text-ax-ink-2">{r.sub}</div>
                      </div>
                      <Amount value={r.amount} className="text-[15px] font-normal" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="ax-card px-4 py-3.5">
        <div className="ax-text-group">Cách tính lương theo công</div>
        <div className="mt-1.5 text-[15px] leading-normal tabular-nums">{buildCalcText(row)}</div>
        <p className="mt-1 text-[13px] text-ax-ink-2">Kỳ {formatMonth(row.month)}</p>
      </div>
      {/* Chừa chỗ: nút «Tải phiếu PDF» (PR riêng, API Rust + tool MCP). */}
    </div>
  )
}

function buildCalcText(row: PayslipRow): string {
  const base = Number(row.base_salary).toLocaleString("vi-VN")
  const actual = Number(row.base_salary_actual).toLocaleString("vi-VN")
  if (row.working_days === null) return `${base} ₫ × đủ công = ${actual} ₫`
  return `${base} ₫ × ${row.working_days} / ${row.standard_working_days} ngày = ${actual} ₫`
}
