"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Download, CheckCircle, Receipt, Pencil, FileSpreadsheet, ArrowUpDown, ArrowUp, ArrowDown, Trash2 } from "lucide-react"
import { teamColorClass } from "@/lib/team-style"
import { cn } from "@/lib/utils"
import { type PayslipRow, type PayslipTotals, canApproveNow, canEditPayslip, canRemoveFromPeriod, displayRevenue, fmtNum, formatMonth, statusColor, statusLabel } from "./payroll-payslips-shared"

// Header cột bấm để sắp xếp (client-side). Icon trung tính / lên / xuống.
// `inline-flex` button kế thừa text-align của TableHead (right cho cột tiền).
function SortableHead({
  label,
  field,
  sortBy,
  sortDir,
  onSort,
  className,
}: {
  label: string
  field: string
  sortBy: string | null
  sortDir: "asc" | "desc"
  onSort: (f: string) => void
  className?: string
}) {
  const active = sortBy === field
  const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className="relative after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] pointer-coarse:sm:after:-inset-y-3 inline-flex items-center gap-1 select-none align-middle hover:text-foreground"
      >
        {label}
        <Icon className={`size-3 ${active ? "" : "opacity-40"}`} />
      </button>
    </TableHead>
  )
}

// 35 cột: STT + 5 nhóm Template Excel (Thông tin NV 6, Lương cơ bản 9, Doanh số/Thưởng
// 9, Giảm trừ 4, Thanh toán 5) + Trạng thái + Thao tác.
const COLS = 35

// Bảng 35 cột — CHỈ desktop (≥640px); điện thoại dùng danh sách thẻ (`payroll-payslips-cards.tsx`).
export function PayslipsDesktopTable({
  payslips, isLoading, isError, month, totals, sortBy, sortDir, onSort,
  can, canManage, approving, onApprove, onEdit, onDetail, onRemove, onDownload,
  rowHighlightClass, selectRow,
}: {
  payslips: PayslipRow[]
  isLoading: boolean
  isError: boolean
  month: string
  totals: PayslipTotals
  sortBy: string | null
  sortDir: "asc" | "desc"
  onSort: (f: string) => void
  can: (p: "payroll.approve_team" | "payroll.approve_final") => boolean
  canManage: boolean
  approving: boolean
  onApprove: (id: number) => void
  onEdit: (p: PayslipRow) => void
  onDetail: (p: PayslipRow) => void
  onRemove: (p: PayslipRow) => void
  onDownload: (id: number, name: string, kind: "pdf" | "excel") => Promise<void>
  rowHighlightClass: (id: number) => string
  selectRow: (id: number) => void
}) {
  const handleSort = onSort
  return (
        <div className="max-h-[72vh] overflow-auto rounded-2xl border shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
          <table className="w-full min-w-[3350px] caption-bottom border-spacing-0 text-sm [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap [&_tr>*:nth-child(7)]:border-l [&_tr>*:nth-child(16)]:border-l [&_tr>*:nth-child(25)]:border-l [&_tr>*:nth-child(29)]:border-l [&_tr>*:nth-child(30)]:border-l">
            <TableHeader>
              <TableRow>
                {/* Nhóm 1 — Thông tin nhân viên (6 cột) */}
                <TableHead className="sticky left-0 top-0 z-40 w-12 min-w-12 max-w-12 bg-muted text-right">STT</TableHead>
                <SortableHead label="Mã nhân viên" field="employee_code" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="sticky top-0 z-30 bg-muted" />
                <SortableHead label="Họ tên" field="full_name" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="sticky top-0 z-30 bg-muted" />
                <SortableHead label="Vị trí" field="position" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="sticky top-0 z-30 bg-muted" />
                <SortableHead label="Team Lead" field="team" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="sticky top-0 z-30 bg-muted" />
                <SortableHead label="Phòng ban" field="department" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="sticky top-0 z-30 bg-muted" />
                {/* Nhóm 2 — Lương cơ bản (9 cột) */}
                <SortableHead label="Lương cơ bản" field="base_salary" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="sticky top-0 z-30 bg-muted text-right" />
                <TableHead className="sticky top-0 z-30 bg-muted text-right">Lương đóng BHXH</TableHead>
                <TableHead className="sticky top-0 z-30 bg-muted text-right">Ngày công</TableHead>
                <TableHead className="sticky top-0 z-30 bg-muted text-right">Số tiền ngày công</TableHead>
                <TableHead className="sticky top-0 z-30 bg-muted text-right">Thực lĩnh LCB</TableHead>
                <TableHead className="sticky top-0 z-30 bg-muted text-right">Ngày học việc</TableHead>
                <TableHead className="sticky top-0 z-30 bg-muted text-right">Lương học việc</TableHead>
                <TableHead className="sticky top-0 z-30 bg-muted text-right">Phụ cấp học việc</TableHead>
                <TableHead className="sticky top-0 z-30 bg-muted text-right font-semibold">Cộng lương cơ bản</TableHead>
                {/* Nhóm 3 — Doanh số/Thưởng (9 cột) */}
                <SortableHead label="Doanh số" field="sales_personal" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="sticky top-0 z-30 bg-amber-100 text-right text-amber-700" />
                <TableHead className="sticky top-0 z-30 bg-amber-100 text-right text-amber-700">% KPI</TableHead>
                <TableHead className="sticky top-0 z-30 bg-amber-100 text-right text-amber-700">Hệ số (%)</TableHead>
                <TableHead className="sticky top-0 z-30 bg-amber-100 text-right text-amber-700">Bonus</TableHead>
                <TableHead className="sticky top-0 z-30 bg-amber-100 text-right text-amber-700">Vượt mốc cá nhân</TableHead>
                <TableHead className="sticky top-0 z-30 bg-amber-100 text-right text-amber-700">Thưởng nhóm</TableHead>
                <TableHead className="sticky top-0 z-30 bg-amber-100 text-right text-amber-700">Giới thiệu ứng viên</TableHead>
                <TableHead className="sticky top-0 z-30 bg-amber-100 text-right text-amber-700">Thưởng lễ</TableHead>
                <TableHead className="sticky top-0 z-30 bg-amber-100 text-right font-semibold text-amber-700">Cộng doanh số/Thưởng</TableHead>
                {/* Nhóm 4 — Các khoản giảm trừ (4 cột) */}
                <TableHead className="sticky top-0 z-30 bg-rose-100 text-right text-rose-700">Đã ứng</TableHead>
                <TableHead className="sticky top-0 z-30 bg-rose-100 text-right text-rose-700">BHXH</TableHead>
                <TableHead className="sticky top-0 z-30 bg-rose-100 text-right text-rose-700">Thuế TNCN</TableHead>
                <SortableHead label="Tổng giảm trừ" field="tong_giam_tru" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="sticky top-0 z-30 bg-rose-100 text-right font-semibold text-rose-700" />
                {/* Nhóm 5 — Thanh toán (5 cột) */}
                <SortableHead label="Thực nhận" field="total" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="sticky top-0 z-30 bg-emerald-100 text-right font-semibold text-emerald-700" />
                <TableHead className="sticky top-0 z-30 bg-muted">Số tài khoản</TableHead>
                <TableHead className="sticky top-0 z-30 bg-muted">Ngân hàng</TableHead>
                {/* Vận hành — ngoài Template, giữ cho thao tác trên UI */}
                <SortableHead label="Trạng thái" field="status" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="sticky top-0 z-30 bg-muted" />
                <TableHead className="sticky top-0 z-30 bg-muted">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: COLS }).map((__, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))}
              {isError && (
                <TableRow>
                  <TableCell colSpan={COLS} className="py-8 text-center text-red-500">
                    Không thể tải phiếu lương
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !isError && payslips.length === 0 && (
                <TableRow>
                  <TableCell colSpan={COLS} className="py-8 text-center text-muted-foreground">
                    Chưa có phiếu lương cho tháng {formatMonth(month)}
                  </TableCell>
                </TableRow>
              )}
              {payslips.map((p, idx) => (
                <TableRow
                  key={p.id}
                  onClick={() => selectRow(p.id)}
                  className={cn("cursor-pointer", rowHighlightClass(p.id))}
                >
                  <TableCell className="sticky left-0 z-20 w-12 min-w-12 max-w-12 bg-background text-right tabular-nums text-muted-foreground">{idx + 1}</TableCell>
                  <TableCell className="bg-background font-medium tabular-nums">
                    {p.employee?.employee_code ?? `NV${String(p.employee_id).padStart(4, "0")}`}
                  </TableCell>
                  <TableCell className="bg-background font-medium">
                    {p.employee?.user?.full_name ?? `NV #${p.employee_id}`}
                  </TableCell>
                  <TableCell>{p.employee?.job_title_name ?? "—"}</TableCell>
                  {/* Cột "Team Lead" (header dòng ~710): `team_name` KHÔNG phải tên team chung —
                      BE `deriveTeam()` (payslips.service.ts) trả về TÊN NGƯỜI Team Lead phụ trách
                      (chính NV nếu họ là team lead, hoặc manager nếu manager là team lead). Field
                      đặt tên "team_name" nhưng giá trị luôn là tên cá nhân — CHỦ ĐÍCH, khớp header cột.
                      KHÔNG có field "tên team chung" riêng trong hệ thống hiện tại. */}
                  <TableCell>
                    {p.employee?.team_name ? (
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${teamColorClass(p.employee?.team_lead_id)}`}>
                        {p.employee.team_name}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{p.employee?.department || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(p.base_salary)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(p.insurance_base)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.working_days === null ? "—" : p.working_days}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(p.don_gia_ngay_cong)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(p.base_salary_actual)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.training_days === null ? "—" : p.training_days}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(p.training_salary)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(p.probation_allowance)}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">{fmtNum(p.cong_lcb)}</TableCell>
                  <TableCell className="text-right tabular-nums bg-amber-50/40">{fmtNum(displayRevenue(p))}</TableCell>
                  <TableCell className="text-right tabular-nums bg-amber-50/40">
                    {p.kpi_percent === null ? "—" : `${p.kpi_percent}%`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums bg-amber-50/40">
                    {p.bonus_rate === null ? "—" : `${p.bonus_rate}%`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums bg-amber-50/40">{fmtNum(p.bonus_sales_personal)}</TableCell>
                  <TableCell className="text-right tabular-nums bg-amber-50/40">{fmtNum(p.bonus_milestone)}</TableCell>
                  <TableCell className="text-right tabular-nums bg-amber-50/40">{fmtNum(p.bonus_cskh_team)}</TableCell>
                  <TableCell className="text-right tabular-nums bg-amber-50/40">{fmtNum(p.bonus_referral)}</TableCell>
                  <TableCell className="text-right tabular-nums bg-amber-50/40">{fmtNum(p.holiday_bonus)}</TableCell>
                  <TableCell className="text-right tabular-nums bg-amber-50/40 font-semibold text-amber-700">{fmtNum(p.cong_thuong)}</TableCell>
                  <TableCell className="text-right tabular-nums bg-rose-50/40">{fmtNum(p.advances)}</TableCell>
                  <TableCell className="text-right tabular-nums bg-rose-50/40">{fmtNum(p.insurance_total)}</TableCell>
                  <TableCell className="text-right tabular-nums bg-rose-50/40">{fmtNum(p.tax_total)}</TableCell>
                  <TableCell className="text-right tabular-nums bg-rose-50/40 font-semibold text-rose-600">{fmtNum(p.tong_giam_tru)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums bg-emerald-50/60 text-[var(--color-app-primary-ink)]">{fmtNum(p.total)}</TableCell>
                  <TableCell className="tabular-nums">{p.employee?.bank_account_number || "—"}</TableCell>
                  <TableCell>{p.employee?.bank_name || "—"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className={statusColor(p.status)}>{statusLabel(p.status)}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {canApproveNow(can, p.status) && (
                        <Button
                          size="sm" variant="outline"
                          className="h-8"
                          onClick={() => onApprove(p.id)}
                          disabled={approving}
                        >
                          <CheckCircle className="mr-1 h-3 w-3" /> Duyệt
                        </Button>
                      )}
                      {canEditPayslip(canManage, p.status) && (
                        <Button size="sm" variant="ghost" className="h-8" title="Sửa phiếu lương" onClick={() => onEdit(p)}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                      )}
                      {(!!p.components_json?.length || !!p.insurance_json?.length || !!p.tax_json) && (
                        <Button size="sm" variant="ghost" className="h-8" title="Chi tiết phụ cấp / bảo hiểm / thuế" onClick={() => onDetail(p)}>
                          <Receipt className="h-3 w-3" />
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-8" title="Xuất Excel (mẫu kế toán)"
                        onClick={() => void onDownload(p.id, p.employee?.user?.full_name ?? `NV${p.employee_id}`, "excel")}>
                        <FileSpreadsheet className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8" title="Xuất PDF"
                        onClick={() => void onDownload(p.id, p.employee?.user?.full_name ?? `NV${p.employee_id}`, "pdf")}>
                        <Download className="h-3 w-3" />
                      </Button>
                      {canRemoveFromPeriod(canManage, can("payroll.approve_final"), p.status) && (
                        <Button
                          size="sm" variant="ghost" className="h-8 text-destructive hover:text-destructive"
                          title="Loại nhân viên khỏi kỳ lương này"
                          onClick={() => onRemove(p)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && !isError && payslips.length > 0 && (
                <TableRow className="border-t-2 bg-muted font-semibold hover:bg-muted">
                  <TableCell className="sticky left-0 z-20 w-12 min-w-12 max-w-12 bg-muted" />
                  <TableCell className="bg-muted">TỔNG CỘNG</TableCell>
                  <TableCell className="text-muted-foreground">{payslips.length} phiếu</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.base_salary)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.insurance_base)}</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.base_salary_actual)}</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.training_salary)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.probation_allowance)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.cong_lcb)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.sales_personal)}</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.bonus_sales_personal)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.bonus_milestone)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.bonus_cskh_team)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.bonus_referral)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.holiday_bonus)}</TableCell>
                  <TableCell className="text-right tabular-nums text-amber-700">{fmtNum(totals.cong_thuong)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.advances)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.insurance_total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(totals.tax_total)}</TableCell>
                  <TableCell className="text-right tabular-nums text-rose-600">{fmtNum(totals.tong_giam_tru)}</TableCell>
                  <TableCell className="text-right tabular-nums text-[var(--color-app-primary-ink)]">{fmtNum(totals.total)}</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell />
                  <TableCell />
                </TableRow>
              )}
            </TableBody>
          </table>
        </div>  )
}
