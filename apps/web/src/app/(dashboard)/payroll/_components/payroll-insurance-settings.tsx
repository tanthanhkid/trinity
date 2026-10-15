"use client"

import { MonthPicker } from "@/components/ui/month-picker"
import { useState } from "react"
import { toast } from "sonner"
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { PayrollMobileRowMenu } from "./payroll-mobile-row-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog"
import { usePermissions } from "@/lib/rbac"
import {
  type InsuranceSetting, type InsuranceSettingPayload,
  useInsuranceSettings, useCreateInsuranceSetting, useUpdateInsuranceSetting,
  useDeleteInsuranceSetting, getApiErrorMessage,
} from "@/hooks/use-insurance-settings"

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

interface FormState {
  name: string; code: string; employee_rate: string; base_cap: string
  effective_from: string; effective_to: string; is_active: boolean
}
function initForm(s: InsuranceSetting | null): FormState {
  return {
    name: s?.name ?? "", code: s?.code ?? "",
    employee_rate: s != null ? String(s.employee_rate) : "",
    base_cap: s?.base_cap != null ? String(s.base_cap) : "",
    effective_from: s?.effective_from ?? "", effective_to: s?.effective_to ?? "",
    is_active: s?.is_active ?? true,
  }
}
function fmtMoney(v: number | string | null): string {
  return v == null ? "Không trần" : Number(v).toLocaleString("vi-VN") + " đ"
}

export function PayrollInsuranceSettings() {
  const canWrite = usePermissions().can("payroll.manage")
  const canDelete = canWrite
  const { data, isLoading, isError } = useInsuranceSettings()
  const create = useCreateInsuranceSetting()
  const update = useUpdateInsuranceSetting()
  const del = useDeleteInsuranceSetting()

  const [editing, setEditing] = useState<InsuranceSetting | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>(() => initForm(null))
  const [deleting, setDeleting] = useState<InsuranceSetting | null>(null)
  const items = data ?? []
  const isPending = create.isPending || update.isPending

  function openDialog(s: InsuranceSetting | null) { setEditing(s); setForm(initForm(s)); setOpen(true) }
  function set<K extends keyof FormState>(k: K, v: FormState[K]) { setForm((p) => ({ ...p, [k]: v })) }

  function handleSave() {
    if (form.name.trim().length < 2) { toast.error("Tên phải ≥ 2 ký tự"); return }
    if (!/^[a-z0-9_]+$/.test(form.code.trim())) { toast.error("Mã chỉ gồm chữ thường, số, gạch dưới"); return }
    const rate = Number.parseFloat(form.employee_rate)
    if (Number.isNaN(rate) || rate < 0 || rate > 100) { toast.error("Tỷ lệ phải 0–100%"); return }
    if (!MONTH_RE.test(form.effective_from)) { toast.error("Hiệu lực từ phải dạng YYYY-MM"); return }
    if (form.effective_to && !MONTH_RE.test(form.effective_to)) { toast.error("Hiệu lực đến phải dạng YYYY-MM"); return }
    const capStr = form.base_cap.replace(/\D/g, "")
    const payload: InsuranceSettingPayload = {
      name: form.name.trim(), code: form.code.trim(), employee_rate: rate,
      base_cap: capStr ? Number.parseInt(capStr, 10) : null,
      effective_from: form.effective_from, effective_to: form.effective_to || null,
      is_active: form.is_active,
    }
    const onErr = (e: unknown) => toast.error(getApiErrorMessage(e, "Lưu thất bại"))
    if (editing) update.mutate({ id: editing.id, payload }, { onSuccess: () => { toast.success("Đã cập nhật"); setOpen(false) }, onError: onErr })
    else create.mutate(payload, { onSuccess: () => { toast.success("Đã tạo cấu hình bảo hiểm"); setOpen(false) }, onError: onErr })
  }

  function confirmDelete() {
    if (!deleting) return
    del.mutate(deleting.id, {
      onSuccess: () => { toast.success("Đã xoá"); setDeleting(null) },
      onError: (e) => toast.error(getApiErrorMessage(e, "Xoá thất bại")),
    })
  }

  const desktopTable = (
        <div className="overflow-x-auto rounded-2xl border">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Tên</th><th>Mã</th><th>Tỷ lệ</th><th>Trần lương đóng</th><th>Hiệu lực</th><th>Trạng thái</th><th className="text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">Chưa có cấu hình bảo hiểm</td></tr>}
              {items.map((s) => (
                <tr key={s.id} className="border-t [&>td]:px-3 [&>td]:py-2">
                  <td className="font-medium">{s.name}</td>
                  <td className="font-mono text-xs text-muted-foreground">{s.code}</td>
                  <td className="font-medium">{Number(s.employee_rate)}%</td>
                  <td className="text-xs">{fmtMoney(s.base_cap)}</td>
                  <td className="text-xs">{s.effective_to ? `${s.effective_from} → ${s.effective_to}` : `Từ ${s.effective_from}`}</td>
                  <td><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.is_active ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>{s.is_active ? "Đang áp dụng" : "Tắt"}</span></td>
                  <td className="text-right whitespace-nowrap">
                    {canWrite && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openDialog(s)} title="Sửa"><Pencil className="h-3.5 w-3.5" /></Button>}
                    {canDelete && <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => setDeleting(s)} title="Xoá"><Trash2 className="h-3.5 w-3.5" /></Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
  )

  const mobileCards =
    items.length === 0 ? (
      <p className="py-8 text-center text-sm text-muted-foreground">Chưa có cấu hình bảo hiểm</p>
    ) : (
      <div className="space-y-3">
        {items.map((s) => (
          <ShellListCard key={s.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold">{s.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{s.code}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.is_active ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>{s.is_active ? "Đang áp dụng" : "Tắt"}</span>
                {(canWrite || canDelete) && (
                  <PayrollMobileRowMenu
                    items={[
                      ...(canWrite ? [{ label: "Sửa", icon: Pencil, onClick: () => openDialog(s) }] : []),
                      ...(canDelete ? [{ label: "Xoá", icon: Trash2, onClick: () => setDeleting(s), destructive: true }] : []),
                    ]}
                  />
                )}
              </div>
            </div>
            <ShellListCardRow label="Tỷ lệ NLĐ" value={`${Number(s.employee_rate)}%`} />
            <ShellListCardRow label="Trần lương đóng" value={fmtMoney(s.base_cap)} />
            <ShellListCardRow label="Hiệu lực" value={s.effective_to ? `${s.effective_from} → ${s.effective_to}` : `Từ ${s.effective_from}`} />
          </ShellListCard>
        ))}
      </div>
    )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Bảo hiểm phần NLĐ đóng (BHXH/BHYT/BHTN). Engine tự khấu trừ vào phiếu lương = min(lương đóng BH, trần) × tỷ lệ%.
        </p>
        {canWrite && (
          <Button className={`shrink-0 ${MOBILE_FAB_CLASS}`} onClick={() => openDialog(null)}>
            <Plus className="mr-2 h-4 w-4" />Thêm cấu hình bảo hiểm
          </Button>
        )}
      </div>

      {isLoading && <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}</div>}
      {isError && <p className="text-center text-red-500 py-8">Không thể tải cấu hình bảo hiểm</p>}

      {!isLoading && !isError && (
        <ShellResponsiveList table={desktopTable} cards={mobileCards} />
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader><DialogTitle>{editing ? "Sửa cấu hình bảo hiểm" : "Thêm cấu hình bảo hiểm"}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 py-2">
            <div className="space-y-2 sm:col-span-2"><Label>Tên *</Label><Input className="max-sm:h-11" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Bảo hiểm xã hội (BHXH)" /></div>
            <div className="space-y-2"><Label>Mã *</Label><Input className="max-sm:h-11" value={form.code} onChange={(e) => set("code", e.target.value)} disabled={!!editing} placeholder="bhxh" /></div>
            <div className="space-y-2"><Label>Tỷ lệ NLĐ (%) *</Label><Input className="max-sm:h-11" value={form.employee_rate} onChange={(e) => set("employee_rate", e.target.value)} placeholder="8" /></div>
            <div className="space-y-2 sm:col-span-2"><Label>Trần lương đóng BH (VNĐ)</Label><Input className="max-sm:h-11" value={form.base_cap} onChange={(e) => set("base_cap", e.target.value)} placeholder="46800000 (bỏ trống = không trần)" /></div>
            <div className="space-y-2"><Label>Hiệu lực từ (YYYY-MM) *</Label><MonthPicker value={form.effective_from} onChange={(v) => set("effective_from", v)} allowClear={false} ariaLabel="Hiệu lực từ" /></div>
            <div className="space-y-2"><Label>Hiệu lực đến (YYYY-MM)</Label><MonthPicker value={form.effective_to} onChange={(v) => set("effective_to", v)} ariaLabel="Hiệu lực đến" /></div>
            <div className="flex items-center gap-2 sm:col-span-2 max-sm:min-h-11">
              <input id="ins_active" type="checkbox" className="h-4 w-4" checked={form.is_active} onChange={(e) => set("is_active", e.target.checked)} />
              <Label htmlFor="ins_active">Đang áp dụng</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button>
            <Button onClick={handleSave} disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Lưu thay đổi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(v) => { if (!v) setDeleting(null) }}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Xoá cấu hình bảo hiểm?</DialogTitle>
            <DialogDescription>Xoá &quot;{deleting?.name}&quot; sẽ không áp dụng cho phiếu lương tạo sau này. Phiếu cũ giữ nguyên.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Huỷ</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={del.isPending}>
              {del.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Xoá
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
