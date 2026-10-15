"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ShellListCard } from "@/components/app-shell/list-card"
import { CheckCircle, Download, FileSpreadsheet, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { type PayslipRow, canApproveNow, canEditPayslip, canRemoveFromPeriod, fmt, formatMonth, statusColor, statusLabel } from "./payroll-payslips-shared"

interface Actions {
  can: (p: "payroll.approve_team" | "payroll.approve_final") => boolean
  canManage: boolean
  approving: boolean
  onApprove: (id: number) => void
  onEdit: (p: PayslipRow) => void
  onDetail: (p: PayslipRow) => void
  onRemove: (p: PayslipRow) => void
  onDownload: (id: number, name: string, kind: "pdf" | "excel") => Promise<void>
}

// Menu "⋯" của thẻ — cùng gate quyền với cột "Thao tác" của bảng desktop. Xoá (loại khỏi kỳ)
// đứng CUỐI và vẫn đi qua dialog xác nhận (`RemovePayslipDialog`). Bọc `stopPropagation`
// để chạm menu không mở chi tiết (portal vẫn nổi bọt theo cây React nên bọc ở ngoài cùng).
function PayslipCardMenu({ p, a }: { p: PayslipRow; a: Actions }) {
  const name = p.employee?.user?.full_name ?? `NV${p.employee_id}`
  const approve = canApproveNow(a.can, p.status)
  const edit = canEditPayslip(a.canManage, p.status)
  const remove = canRemoveFromPeriod(a.canManage, a.can("payroll.approve_final"), p.status)
  const item = "max-sm:min-h-11"
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" aria-label="Thao tác khác" />}
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {approve && (
            <DropdownMenuItem className={item} disabled={a.approving} onClick={() => a.onApprove(p.id)}>
              <CheckCircle /> Duyệt
            </DropdownMenuItem>
          )}
          {edit && (
            <DropdownMenuItem className={item} onClick={() => a.onEdit(p)}>
              <Pencil /> Sửa phiếu lương
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className={item} onClick={() => void a.onDownload(p.id, name, "excel")}>
            <FileSpreadsheet /> Xuất Excel
          </DropdownMenuItem>
          <DropdownMenuItem className={item} onClick={() => void a.onDownload(p.id, name, "pdf")}>
            <Download /> Xuất PDF
          </DropdownMenuItem>
          {remove && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className={item} variant="destructive" onClick={() => a.onRemove(p)}>
                <Trash2 /> Loại khỏi kỳ
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function PayslipCard({ p, a }: { p: PayslipRow; a: Actions }) {
  const meta = [p.employee?.department, p.employee?.team_name].filter(Boolean).join(" · ")
  return (
    <ShellListCard onClick={() => a.onDetail(p)} className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold">{p.employee?.user?.full_name ?? `NV #${p.employee_id}`}</p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {p.employee?.employee_code ?? `NV${String(p.employee_id).padStart(4, "0")}`}
          </p>
        </div>
        <div className="-mr-2 -mt-2 shrink-0">
          <PayslipCardMenu p={p} a={a} />
        </div>
      </div>
      <Badge variant="secondary" className={statusColor(p.status)}>{statusLabel(p.status)}</Badge>
      <div>
        <p className="text-xs text-muted-foreground">Thực nhận</p>
        <p className="text-xl font-semibold tabular-nums text-[var(--color-app-primary-ink)]">{fmt(p.total)}</p>
      </div>
      {meta && <p className="truncate text-xs text-muted-foreground">{meta}</p>}
    </ShellListCard>
  )
}

// Danh sách thẻ — CHỈ điện thoại (<640px, bọc bởi `ShellResponsiveList`). Thẻ tổng ở đầu thay
// dòng "TỔNG CỘNG" của bảng; chạm thẻ mở dialog Chi tiết.
export function PayslipsMobileList({
  payslips, isLoading, isError, month, totalAll, filteredFrom, ...actions
}: Actions & {
  payslips: PayslipRow[]
  isLoading: boolean
  isError: boolean
  month: string
  totalAll: number
  filteredFrom: number | null
}) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}
      </div>
    )
  }
  if (isError) return <p className="py-8 text-center text-sm text-red-500">Không thể tải phiếu lương</p>
  if (payslips.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Chưa có phiếu lương cho tháng {formatMonth(month)}
      </p>
    )
  }
  return (
    <div className="space-y-3">
      <ShellListCard className="space-y-0.5 bg-muted">
        <p className="text-xs text-muted-foreground">
          {payslips.length} phiếu{filteredFrom !== null ? ` (lọc từ ${filteredFrom})` : ""} · Tổng thực nhận
        </p>
        <p className="text-xl font-semibold tabular-nums text-[var(--color-app-primary-ink)]">{fmt(totalAll)}</p>
      </ShellListCard>
      {payslips.map((p) => <PayslipCard key={p.id} p={p} a={actions} />)}
    </div>
  )
}
