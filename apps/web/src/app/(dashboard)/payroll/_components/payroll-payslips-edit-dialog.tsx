"use client"

import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Loader2 } from "lucide-react"
import apiClient from "@/lib/api-client"
import { PayslipRow, formatMonth, fmt } from "./payroll-payslips-shared"
// ============ Dialog Sửa phiếu lương ============
interface EditFormState {
  working_days: string
  standard_working_days: string
  base_salary: string
  training_days: string
  training_salary: string
  probation_allowance: string
  sales_personal: string
  bonus_rate: string
  kpi_percent: string
  bonus_sales_personal: string
  sales_team: string
  bonus_cskh_team: string
  bonus_milestone: string
  bonus_referral: string
  holiday_bonus: string
  advances: string
  notes: string
}

function digits(v: string): string {
  return v.replace(/\D/g, "")
}
function n(v: string): number {
  return Number(v || 0)
}

export function PayslipEditDialog({
  row, month, onClose, onSaved,
}: {
  row: PayslipRow
  month: string
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<EditFormState>({
    working_days: row.working_days === null ? "" : String(row.working_days),
    standard_working_days: String(row.standard_working_days || 24),
    base_salary: digits(row.base_salary),
    training_days: row.training_days === null ? "" : String(row.training_days),
    training_salary: digits(row.training_salary),
    probation_allowance: digits(row.probation_allowance),
    sales_personal: digits(row.sales_personal),
    bonus_rate: row.bonus_rate === null ? "" : String(row.bonus_rate),
    kpi_percent: row.kpi_percent === null ? "" : String(row.kpi_percent),
    bonus_sales_personal: digits(row.bonus_sales_personal),
    sales_team: digits(row.sales_team),
    bonus_cskh_team: digits(row.bonus_cskh_team),
    bonus_milestone: digits(row.bonus_milestone),
    bonus_referral: digits(row.bonus_referral),
    holiday_bonus: digits(row.holiday_bonus),
    advances: digits(row.advances),
    notes: row.notes ?? "",
  })

  function set<K extends keyof EditFormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function applyBonusSuggestion() {
    const rate = numOrNull(form.bonus_rate)
    const sug = rate !== null && rate > 0 ? Math.round((n(form.sales_personal) * rate) / 100) : 0
    setForm((prev) => ({ ...prev, bonus_sales_personal: String(sug) }))
    toast.success("Đã áp Bonus = Doanh số × Hệ số. Bạn có thể chỉnh lại.")
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiClient.patch(`/payslips/${row.id}`, {
        working_days: numOrNull(form.working_days),
        standard_working_days: Number(form.standard_working_days) || 24,
        base_salary: form.base_salary || "0",
        training_days: numOrNull(form.training_days),
        training_salary: form.training_salary || "0",
        probation_allowance: form.probation_allowance || "0",
        sales_personal: form.sales_personal || "0",
        bonus_rate: numOrNull(form.bonus_rate),
        kpi_percent: numOrNull(form.kpi_percent),
        bonus_sales_personal: form.bonus_sales_personal || "0",
        sales_team: form.sales_team || "0",
        bonus_cskh_team: form.bonus_cskh_team || "0",
        bonus_milestone: form.bonus_milestone || "0",
        bonus_referral: form.bonus_referral || "0",
        holiday_bonus: form.holiday_bonus || "0",
        advances: form.advances || "0",
        notes: form.notes,
      })
    },
    onSuccess: () => {
      toast.success("Đã lưu phiếu lương. Tổng thực nhận đã tính lại.")
      onSaved()
    },
    onError: () => toast.error("Không thể lưu. Phiếu đã duyệt không sửa được, hoặc dữ liệu không hợp lệ."),
  })

  // Tạm tính trực tiếp (các phần tính được ở FE); BHXH/thuế/thực nhận tính LẠI ở server khi lưu.
  const wd = numOrNull(form.working_days)
  const std = Number(form.standard_working_days) || 24
  const donGiaNgayCong = std > 0 ? Math.round(n(form.base_salary) / std) : 0
  const baseActual = wd === null ? n(form.base_salary) : Math.round((n(form.base_salary) * wd) / std)
  const congLcb = baseActual + n(form.training_salary) + n(form.probation_allowance)
  const congThuong =
    n(form.bonus_sales_personal) + n(form.bonus_cskh_team) + n(form.bonus_milestone) +
    n(form.bonus_referral) + n(form.holiday_bonus)
  const tongLuong = congLcb + congThuong
  // Hệ số (%) → Bonus DS gợi ý = Doanh số × Hệ số / 100 (KHÔNG tự áp; kế toán bấm "Áp dụng").
  const bonusRate = numOrNull(form.bonus_rate)
  const bonusSuggested =
    bonusRate !== null && bonusRate > 0 ? Math.round((n(form.sales_personal) * bonusRate) / 100) : 0
  // Cảnh báo khi đã nhập hệ số nhưng Bonus DS chưa khớp gợi ý (kế toán quên bấm "Áp dụng").
  const bonusMismatch =
    bonusRate !== null && bonusRate > 0 && n(form.bonus_sales_personal) !== bonusSuggested
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="flex max-h-[90vh] flex-col rounded-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sửa phiếu lương — {row.employee?.user?.full_name} · Tháng {formatMonth(row.month)}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto pr-1">
          {/* I/ Thông tin cơ bản */}
          <section className="space-y-3">
            <p className="rounded bg-[var(--color-app-primary-soft)] px-2 py-1 text-sm font-semibold text-[var(--color-app-primary-ink)]">I/ Thông tin cơ bản</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MoneyField label="Lương cơ bản" value={form.base_salary} onChange={(v) => set("base_salary", v)} />
              <NumField
                label="Ngày công thực tế" value={form.working_days} onChange={(v) => set("working_days", v)}
                hint="Trống = đủ công (nguyên lương)"
              />
              <NumField
                label="Ngày công chuẩn" value={form.standard_working_days}
                onChange={(v) => set("standard_working_days", v)} hint="Mặc định 24"
              />
              <NumField
                label="Ngày học việc" value={form.training_days} onChange={(v) => set("training_days", v)}
                hint="Trống = không có học việc"
              />
              <MoneyField label="Lương học việc" value={form.training_salary} onChange={(v) => set("training_salary", v)} />
              <MoneyField label="Phụ cấp học việc (2)" value={form.probation_allowance} onChange={(v) => set("probation_allowance", v)} />
              <NumField label="Tỷ lệ KPI (%)" value={form.kpi_percent} onChange={(v) => set("kpi_percent", v)}
                hint="Tỷ lệ KPI đạt được (vd 85.5 = 85,5%)" />
            </div>
            <ComputedRow label="Số tiền ngày công (đơn giá)" value={donGiaNgayCong} formula="Lương cơ bản / Ngày công chuẩn" />
            <ComputedRow label="Thực lĩnh LCB (1)" value={baseActual} formula="Lương cơ bản × Ngày công / Ngày chuẩn" />
            <ComputedRow label="CỘNG LCB (1+2)" value={congLcb} formula="Thực lĩnh LCB + Lương học việc + Phụ cấp học việc" bold />
          </section>

          {/* II/ Thưởng */}
          <section className="space-y-3">
            <p className="rounded bg-[var(--color-app-primary-soft)] px-2 py-1 text-sm font-semibold text-[var(--color-app-primary-ink)]">II/ Các khoản thưởng</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MoneyField label="Doanh số cá nhân" value={form.sales_personal} onChange={(v) => set("sales_personal", v)} />
              <NumField label="Hệ số (%)" value={form.bonus_rate} onChange={(v) => set("bonus_rate", v)}
                hint="Tỷ lệ thưởng trên doanh số (vd 0.4 = 0,4%)" />
              <MoneyField label="Bonus DS cá nhân" value={form.bonus_sales_personal} onChange={(v) => set("bonus_sales_personal", v)}
                hint="Bonus on personal sales" />
              <MoneyField label="Doanh số Team" value={form.sales_team} onChange={(v) => set("sales_team", v)} />
              <MoneyField label="Thưởng / Bonus Team" value={form.bonus_cskh_team} onChange={(v) => set("bonus_cskh_team", v)} />
              <MoneyField label="Thưởng mốc / Vượt mốc" value={form.bonus_milestone} onChange={(v) => set("bonus_milestone", v)}
                hint="Điền sẵn = thưởng KPI" />
              <MoneyField label="Thưởng giới thiệu" value={form.bonus_referral} onChange={(v) => set("bonus_referral", v)} />
              <MoneyField label="Thưởng Lễ (5)" value={form.holiday_bonus} onChange={(v) => set("holiday_bonus", v)} />
            </div>
            {bonusRate !== null && bonusRate > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-sky-50 px-3 py-2">
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium text-sky-700">Bonus DS gợi ý theo hệ số</span>
                  <span className="block text-sm italic text-sky-700">= Doanh số × Hệ số ({bonusRate}%)</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums font-semibold text-sky-700">{fmt(bonusSuggested)}</span>
                  <Button type="button" size="sm" variant="outline" className="h-8" onClick={applyBonusSuggestion}>
                    Áp dụng
                  </Button>
                </span>
              </div>
            )}
            {bonusMismatch && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Bonus DS cá nhân hiện tại (<strong>{fmt(form.bonus_sales_personal)}</strong>) chưa khớp gợi ý theo hệ số
                (<strong>{fmt(bonusSuggested)}</strong>). Bấm <strong>"Áp dụng"</strong> nếu muốn tính Bonus theo Hệ số.
              </div>
            )}
            <ComputedRow label="Cộng doanh số & thưởng (1+2+3+4+5)" value={congThuong}
              formula="Bonus DS + Vượt mốc + Thưởng nhóm + Giới thiệu + Thưởng Lễ" bold />
          </section>

          {/* III/ Tổng & giảm trừ */}
          <section className="space-y-3">
            <p className="rounded bg-[var(--color-app-primary-soft)] px-2 py-1 text-sm font-semibold text-[var(--color-app-primary-ink)]">III/ Tổng lương & giảm trừ</p>
            <ComputedRow label="TỔNG LƯƠNG (chưa trừ BHXH)" value={tongLuong} formula="Cộng LCB + Cộng Thưởng" bold />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MoneyField label="Các khoản đã chi lĩnh trước" value={form.advances} onChange={(v) => set("advances", v)} />
            </div>
            <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <p>• <strong>Trích BHXH</strong> = 8% + 1,5% + 1% × lương đóng bảo hiểm — <em>hệ thống tự tính</em>.</p>
              <p>• <strong>Thuế TNCN</strong> = lũy tiến từng phần trên thu nhập chịu thuế − giảm trừ gia cảnh — <em>hệ thống tự tính</em>.</p>
              <p>• <strong>Tổng thực nhận</strong> = Tổng lương − (đã chi lĩnh + BHXH + thuế + khấu trừ khác). BHXH/Thuế/Thực nhận sẽ <strong>tính lại tự động sau khi lưu</strong>.</p>
              <p className="mt-1">Hiện tại (kỳ trước khi sửa): BHXH <strong>{fmt(row.insurance_total)}</strong> · Thuế <strong>{fmt(row.tax_total)}</strong> · Thực nhận <strong>{fmt(row.total)}</strong>.</p>
            </div>
          </section>

          {/* IV/ Tài khoản nhận lương */}
          <section className="space-y-3">
            <p className="rounded bg-[var(--color-app-primary-soft)] px-2 py-1 text-sm font-semibold text-[var(--color-app-primary-ink)]">IV/ Tài khoản nhận lương</p>
            <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <p>Số tài khoản: <strong>{row.employee?.bank_account_number || "—"}</strong> · Ngân hàng: <strong>{row.employee?.bank_name || "—"}</strong></p>
              <p className="mt-0.5 italic">Lấy từ hồ sơ nhân viên (sửa tại Quản lý nhân viên).</p>
            </div>
          </section>

          {/* Ghi chú */}
          <section className="space-y-1.5">
            <label className="text-sm font-medium">Ghi chú</label>
            <textarea
              className="min-h-[64px] w-full rounded-lg border px-3 py-2 text-sm"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              maxLength={2000}
              placeholder="Ghi chú thêm cho phiếu lương..."
            />
          </section>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t pt-3 max-sm:flex-col">
          <Button variant="outline" onClick={onClose} disabled={saveMutation.isPending}>Huỷ</Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Lưu phiếu lương
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MoneyField({
  label, value, onChange, hint,
}: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Input
        inputMode="numeric"
        value={value === "" ? "" : Number(value).toLocaleString("vi-VN")}
        onChange={(e) => onChange(digits(e.target.value))}
        className="h-10 text-right tabular-nums max-sm:h-11"
        placeholder="0"
      />
      {hint && <p className="text-sm italic text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Chuỗi rỗng hoặc không phải số hữu hạn (vd "." đơn lẻ) → null; không để NaN lọt vào JSON. */
function numOrNull(raw: string): number | null {
  if (raw === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Chỉ số + tối đa MỘT dấu chấm: '21.5.2' → NaN → JSON null (= "đủ công/không đặt") sẽ lưu sai im lặng. */
function oneDecimalPoint(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "")
  const i = cleaned.indexOf(".")
  return i < 0 ? cleaned : cleaned.slice(0, i + 1) + cleaned.slice(i + 1).replace(/\./g, "")
}

function NumField({
  label, value, onChange, hint,
}: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(oneDecimalPoint(e.target.value))}
        className="h-10 text-right tabular-nums max-sm:h-11"
        placeholder="—"
      />
      {hint && <p className="text-sm italic text-muted-foreground">{hint}</p>}
    </div>
  )
}

// Dòng giá trị TỰ TÍNH (read-only) + công thức hiển thị cho kế toán.
function ComputedRow({
  label, value, formula, bold,
}: { label: string; value: number; formula: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
      <span className="space-y-0.5">
        <span className={`block text-sm ${bold ? "font-semibold" : ""}`}>{label}</span>
        <span className="block text-sm italic text-muted-foreground">= {formula}</span>
      </span>
      <span className={`tabular-nums ${bold ? "text-base font-bold text-[var(--color-app-primary-ink)]" : "font-medium"}`}>
        {fmt(value)}
      </span>
    </div>
  )
}
