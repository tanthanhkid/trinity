"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { UserPlus, Loader2 } from "lucide-react"
import apiClient from "@/lib/api-client"
import { PayslipRow, COMPONENT_TYPE_META, formatMonth, fmt } from "./payroll-payslips-shared"

// ============ Dialog Thêm người vào kỳ lương ============
interface AddableEmployee {
  employee_id: number
  employee_code: string
  user_id: number
  full_name: string | null
  email: string
  job_title_name: string | null
  team_name: string | null
  team_lead_id: number | null
}

export function AddToPeriodDialog({ month, onClose }: { month: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [search, setSearch] = useState("")

  const { data, isLoading, isError } = useQuery<AddableEmployee[]>({
    queryKey: ["payroll-addable", month],
    queryFn: async () => {
      const res = await apiClient.get<AddableEmployee[]>(
        "/payslips/addable",
        { params: { month } },
      )
      return res.data
    },
  })

  const addMutation = useMutation({
    mutationFn: async (employeeId: number) => {
      await apiClient.post("/payslips/add-to-period", {
        month,
        employee_id: employeeId,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payroll-payslips", month] })
      void qc.invalidateQueries({ queryKey: ["payroll-addable", month] })
      toast.success("Đã thêm nhân viên vào kỳ lương.")
    },
    onError: () =>
      toast.error("Không thể thêm. Có thể nhân viên đã có trong kỳ này."),
  })

  const list = data ?? []
  const kw = search.trim().toLowerCase()
  const filtered = kw
    ? list.filter(
        (e) =>
          (e.full_name ?? "").toLowerCase().includes(kw) ||
          (e.employee_code ?? "").toLowerCase().includes(kw),
      )
    : list

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Thêm người vào kỳ — Tháng {formatMonth(month)}</DialogTitle>
          <DialogDescription>
            Chọn nhân viên đang làm việc chưa có phiếu lương trong kỳ này. Hệ thống tạo
            phiếu mới (hoặc khôi phục phiếu đã loại) theo lương cơ bản, sửa lại được sau.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm theo tên hoặc mã NV..."
          className="h-10 max-sm:h-11"
        />
        <div className="flex-1 overflow-y-auto rounded-lg border">
          {isLoading && (
            <p className="p-4 text-sm text-muted-foreground">Đang tải...</p>
          )}
          {isError && (
            <p className="p-4 text-sm text-red-500">
              Không thể tải danh sách nhân viên.
            </p>
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <p className="p-4 text-center text-sm text-muted-foreground">
              Không còn nhân viên nào để thêm vào kỳ này.
            </p>
          )}
          {filtered.map((e) => (
            <div
              key={e.employee_id}
              className="flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {e.full_name ?? e.email}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {e.employee_code}
                  {e.job_title_name ? ` · ${e.job_title_name}` : ""}
                  {e.team_name ? ` · ${e.team_name}` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={addMutation.isPending}
                onClick={() => addMutation.mutate(e.employee_id)}
              >
                <UserPlus className="mr-1 h-3 w-3" /> Thêm
              </Button>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Đóng</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============ Dialog Chi tiết (phụ cấp / bảo hiểm / thuế) ============
export function PayslipDetailDialog({ row, onClose }: { row: PayslipRow | null; onClose: () => void }) {
  return (
    <Dialog open={row !== null} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Chi tiết khấu trừ / phụ cấp — {row?.employee?.user?.full_name ?? ""}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          {row && !row.components_json?.length && !row.insurance_json?.length && !row?.tax_json && Number(row?.insurance_base ?? 0) <= 0 && (
            <p className="text-sm text-muted-foreground">Phiếu này chưa có khoản phụ cấp / bảo hiểm / thuế chi tiết.</p>
          )}
          {!!row?.components_json?.length && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">Phụ cấp / Thưởng / Khấu trừ</p>
              {row.components_json.map((c) => (
                <div key={c.code} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${COMPONENT_TYPE_META[c.component_type].cls}`}>
                      {COMPONENT_TYPE_META[c.component_type].label}
                    </span>
                    <span>{c.name}</span>
                  </span>
                  <span className={c.component_type === "deduction" ? "font-medium text-rose-600" : "font-medium"}>
                    {c.component_type === "deduction" ? "−" : "+"}{fmt(c.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {Number(row?.insurance_base ?? 0) > 0 && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-semibold text-muted-foreground">Cơ cấu lương cơ bản</p>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Lương đóng BHXH</span>
                <span className="font-medium">{fmt(row?.insurance_base ?? "0")}</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Phụ cấp xăng xe/ăn ca</span>
                <span className="font-medium">{fmt(row?.phu_cap_xang_xe ?? "0")}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                BHXH tính trên mức cố định theo chức vụ; phần chênh so với lương cơ bản chuyển thành phụ cấp.
              </p>
            </div>
          )}
          {!!row?.insurance_json?.length && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-semibold text-muted-foreground">Bảo hiểm (NLĐ đóng)</p>
              {row.insurance_json.map((i) => (
                <div key={i.code} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">{i.rate}%</span>
                    <span>{i.name}</span>
                  </span>
                  <span className="font-medium text-rose-600">−{fmt(i.amount)}</span>
                </div>
              ))}
            </div>
          )}
          {!!row?.tax_json && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-semibold text-muted-foreground">Thuế TNCN (lũy tiến từng phần)</p>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Thu nhập tính thuế</span>
                <span>{fmt(row.tax_json.taxable_income)}</span>
              </div>
              {row.tax_json.brackets.map((b, idx) => (
                <div key={idx} className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{fmt(b.portion)} × {b.rate}%</span>
                  <span>−{fmt(b.tax)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between border-t pt-1 text-sm">
                <span className="font-medium">Tổng thuế</span>
                <span className="font-medium text-rose-600">−{fmt(row.tax_json.tax)}</span>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}


// ============ Dialog xác nhận loại khỏi kỳ ============
export function RemovePayslipDialog({
  row, month, pending, onClose, onConfirm,
}: {
  row: PayslipRow
  month: string
  pending: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Loại nhân viên khỏi kỳ lương?</DialogTitle>
          <DialogDescription>
            Phiếu lương của{" "}
            <span className="font-medium">
              {row.employee?.user?.full_name ?? `NV #${row.employee_id}`}
            </span>{" "}
            trong tháng {formatMonth(month)} sẽ bị xóa khỏi kỳ này và{" "}
            <span className="font-medium">không tự quay lại</span> khi bấm “Tạo phiếu
            lương”. Các tháng khác và hồ sơ nhân viên không bị ảnh hưởng.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Huỷ
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Loại khỏi kỳ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
