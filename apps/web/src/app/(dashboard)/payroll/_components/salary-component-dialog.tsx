"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { autoMaskVnDate, parseVnDate, monthToVnDate } from "@/lib/format"
import {
  type SalaryComponent, type SalaryComponentPayload, type ComponentType, type CalcMethod,
  useCreateSalaryComponent, useUpdateSalaryComponent, getApiErrorMessage,
} from "@/hooks/use-salary-components"

const TYPE_LABEL: Record<ComponentType, string> = {
  allowance: "Phụ cấp", bonus: "Thưởng", deduction: "Khấu trừ",
}

// Field hiệu lực lưu theo THÁNG (YYYY-MM) nhưng hiển thị/nhập dd/MM/yyyy (ngày = 01).
// Parse dd/MM/yyyy → YYYY-MM: "" = rỗng, undefined = sai định dạng.
function vnDateToMonth(vn: string): string | undefined {
  const iso = parseVnDate(vn) // "" | undefined | "YYYY-MM-DD"
  if (iso === "" || iso === undefined) return iso
  return iso.slice(0, 7)
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  editing: SalaryComponent | null
}

interface FormState {
  name: string; code: string; component_type: ComponentType; calc_method: CalcMethod
  fixed_amount: string; percent_value: string; applies_to: string
  effective_from: string; effective_to: string; sort_order: string
  is_active: boolean; description: string
}

function initForm(c: SalaryComponent | null): FormState {
  return {
    name: c?.name ?? "", code: c?.code ?? "",
    component_type: c?.component_type ?? "allowance",
    calc_method: c?.calc_method ?? "fixed",
    fixed_amount: c?.fixed_amount != null ? String(c.fixed_amount) : "",
    percent_value: c?.percent_value != null ? String(c.percent_value) : "",
    applies_to: c?.applies_to ?? "all",
    effective_from: monthToVnDate(c?.effective_from), // YYYY-MM → dd/MM/yyyy
    effective_to: monthToVnDate(c?.effective_to),
    sort_order: c != null ? String(c.sort_order) : "0",
    is_active: c?.is_active ?? true,
    description: c?.description ?? "",
  }
}

export function SalaryComponentDialog({ open, onOpenChange, editing }: Props) {
  const [form, setForm] = useState<FormState>(() => initForm(editing))
  const create = useCreateSalaryComponent()
  const update = useUpdateSalaryComponent()
  const isPending = create.isPending || update.isPending

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  // Dialog luôn mounted và cha mở bằng prop `open` (Radix không gọi onOpenChange khi mở bằng prop),
  // nên khởi tạo lại form mỗi khi mở hoặc đổi bản ghi đang sửa.
  useEffect(() => {
    if (open) setForm(initForm(editing))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id])

  function handleOpenChange(v: boolean) {
    onOpenChange(v)
  }

  function validate(): SalaryComponentPayload | null {
    if (form.name.trim().length < 2) { toast.error("Tên phải có ít nhất 2 ký tự"); return null }
    if (!/^[a-z0-9_]+$/.test(form.code.trim())) {
      toast.error("Mã chỉ gồm chữ thường, số, gạch dưới"); return null
    }
    const fromMonth = vnDateToMonth(form.effective_from)
    if (!fromMonth) { toast.error("Hiệu lực từ phải dạng dd/MM/yyyy"); return null }
    let toMonth: string | null = null
    if (form.effective_to.trim()) {
      const t = vnDateToMonth(form.effective_to)
      if (!t) { toast.error("Hiệu lực đến phải dạng dd/MM/yyyy"); return null }
      toMonth = t
    }
    const payload: SalaryComponentPayload = {
      name: form.name.trim(), code: form.code.trim(),
      component_type: form.component_type, calc_method: form.calc_method,
      applies_to: form.applies_to.trim() || "all",
      effective_from: fromMonth,
      effective_to: toMonth,
      is_active: form.is_active,
      sort_order: Number.parseInt(form.sort_order || "0", 10) || 0,
      description: form.description.trim() || undefined,
    }
    if (form.calc_method === "fixed") {
      const amt = Number.parseInt(form.fixed_amount.replace(/\D/g, ""), 10)
      if (Number.isNaN(amt) || amt < 0) { toast.error("Số tiền không hợp lệ"); return null }
      payload.fixed_amount = amt
    } else {
      const pct = Number.parseFloat(form.percent_value)
      if (Number.isNaN(pct) || pct < 0 || pct > 100) { toast.error("% phải trong khoảng 0–100"); return null }
      payload.percent_value = pct
    }
    return payload
  }

  function handleSave() {
    const payload = validate()
    if (!payload) return
    const onDone = (msg: string) => { toast.success(msg); onOpenChange(false) }
    const onErr = (e: unknown) => toast.error(getApiErrorMessage(e, "Lưu thất bại"))
    if (editing) {
      update.mutate({ id: editing.id, payload }, { onSuccess: () => onDone("Đã cập nhật"), onError: onErr })
    } else {
      create.mutate(payload, { onSuccess: () => onDone("Đã tạo thành phần lương"), onError: onErr })
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg rounded-2xl flex flex-col max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{editing ? "Sửa thành phần lương" : "Thêm thành phần lương"}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Tên *</Label>
              <Input className="max-sm:h-11" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Phụ cấp điện thoại" />
            </div>
            <div className="space-y-2">
              <Label>Mã (slug) *</Label>
              <Input className="max-sm:h-11" value={form.code} onChange={(e) => set("code", e.target.value)}
                disabled={!!editing} placeholder="allowance_phone" />
            </div>
            <div className="space-y-2">
              <Label>Loại *</Label>
              <Select value={form.component_type} onValueChange={(v) => set("component_type", (v ?? "allowance") as ComponentType)}>
                <SelectTrigger className="max-sm:h-11"><SelectValue>{(v) => (typeof v === "string" ? TYPE_LABEL[v as ComponentType] ?? null : null)}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectItem value="allowance">Phụ cấp</SelectItem>
                  <SelectItem value="bonus">Thưởng</SelectItem>
                  <SelectItem value="deduction">Khấu trừ</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Cách tính *</Label>
              <Select value={form.calc_method} onValueChange={(v) => set("calc_method", (v ?? "fixed") as CalcMethod)}>
                <SelectTrigger className="max-sm:h-11"><SelectValue>{(v) => (v === "percent_base" ? "% theo lương cơ bản" : v === "fixed" ? "Số tiền cố định" : null)}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Số tiền cố định</SelectItem>
                  <SelectItem value="percent_base">% theo lương cơ bản</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.calc_method === "fixed" ? (
              <div className="space-y-2">
                <Label>Số tiền (VNĐ) *</Label>
                <Input className="max-sm:h-11" value={form.fixed_amount} onChange={(e) => set("fixed_amount", e.target.value)} placeholder="300000" />
              </div>
            ) : (
              <div className="space-y-2">
                <Label>% theo lương cơ bản *</Label>
                <Input className="max-sm:h-11" value={form.percent_value} onChange={(e) => set("percent_value", e.target.value)} placeholder="10.5" />
              </div>
            )}
            <div className="space-y-2">
              <Label>Áp cho</Label>
              <Input className="max-sm:h-11" value={form.applies_to} onChange={(e) => set("applies_to", e.target.value)} placeholder="all hoặc rank:NV" />
            </div>
            <div className="space-y-2">
              <Label>Hiệu lực từ (dd/MM/yyyy) *</Label>
              <Input className="max-sm:h-11" inputMode="numeric" placeholder="01/06/2026" value={form.effective_from}
                onChange={(e) => set("effective_from", autoMaskVnDate(e.target.value))} />
            </div>
            <div className="space-y-2">
              <Label>Hiệu lực đến (dd/MM/yyyy)</Label>
              <Input className="max-sm:h-11" inputMode="numeric" placeholder="Để trống = không giới hạn" value={form.effective_to}
                onChange={(e) => set("effective_to", autoMaskVnDate(e.target.value))} />
            </div>
            <div className="space-y-2">
              <Label>Thứ tự</Label>
              <Input className="max-sm:h-11" value={form.sort_order} onChange={(e) => set("sort_order", e.target.value)} placeholder="0" />
            </div>
            <div className="flex items-center gap-2 pt-7 max-sm:min-h-11 max-sm:pt-0">
              <input id="is_active" type="checkbox" className="h-4 w-4"
                checked={form.is_active} onChange={(e) => set("is_active", e.target.checked)} />
              <Label htmlFor="is_active">Đang áp dụng</Label>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Ghi chú</Label>
            <Input className="max-sm:h-11" value={form.description} onChange={(e) => set("description", e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
