"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Pencil, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { usePermissions } from "@/lib/rbac"
import {
  type TaxBracket, type TaxSetting,
  useTaxConfig, useUpdateBracket, useUpdateTaxSetting, getApiErrorMessage,
} from "@/hooks/use-tax-config"

const fmt = (v: number | string | null) =>
  v == null ? "∞" : Number(v).toLocaleString("vi-VN") + " đ"

export function PayrollTaxConfig() {
  const canWrite = usePermissions().can("payroll.manage")
  const { data, isLoading, isError } = useTaxConfig()
  const updBracket = useUpdateBracket()
  const updSetting = useUpdateTaxSetting()

  const [editBracket, setEditBracket] = useState<TaxBracket | null>(null)
  const [rateInput, setRateInput] = useState("")
  const [editSetting, setEditSetting] = useState<TaxSetting | null>(null)
  const [personalInput, setPersonalInput] = useState("")
  const [depInput, setDepInput] = useState("")

  const brackets = (data?.brackets ?? []).filter((b) => b.is_active)
  const setting = (data?.settings ?? []).find((s) => s.is_active) ?? null

  function openBracket(b: TaxBracket) { setEditBracket(b); setRateInput(String(b.rate)) }
  function saveBracket() {
    if (!editBracket) return
    const rate = Number.parseFloat(rateInput)
    if (Number.isNaN(rate) || rate < 0 || rate > 100) { toast.error("Thuế suất 0–100%"); return }
    updBracket.mutate({ id: editBracket.id, payload: { rate } }, {
      onSuccess: () => { toast.success("Đã cập nhật bậc thuế"); setEditBracket(null) },
      onError: (e) => toast.error(getApiErrorMessage(e, "Lưu thất bại")),
    })
  }
  function openSetting(s: TaxSetting) { setEditSetting(s); setPersonalInput(String(s.personal_deduction)); setDepInput(String(s.dependent_deduction)) }
  function saveSetting() {
    if (!editSetting) return
    const p = Number.parseInt(personalInput.replace(/\D/g, ""), 10)
    const d = Number.parseInt(depInput.replace(/\D/g, ""), 10)
    if (Number.isNaN(p) || Number.isNaN(d)) { toast.error("Số tiền không hợp lệ"); return }
    updSetting.mutate({ id: editSetting.id, payload: { personal_deduction: p, dependent_deduction: d } }, {
      onSuccess: () => { toast.success("Đã cập nhật giảm trừ"); setEditSetting(null) },
      onError: (e) => toast.error(getApiErrorMessage(e, "Lưu thất bại")),
    })
  }

  if (isLoading) return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}</div>
  if (isError) return <p className="text-center text-red-500 py-8">Không thể tải cấu hình thuế</p>

  const desktopTable = (
      <div className="overflow-x-auto rounded-2xl border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Bậc</th><th>Thu nhập tính thuế / tháng</th><th>Thuế suất</th><th className="text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {brackets.length === 0 && <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">Chưa có biểu thuế</td></tr>}
            {brackets.map((b) => (
              <tr key={b.id} className="border-t [&>td]:px-3 [&>td]:py-2">
                <td className="font-medium">{b.bracket_order}</td>
                <td>{fmt(b.lower_bound)} – {fmt(b.upper_bound)}</td>
                <td><span className="rounded-full px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700">{Number(b.rate)}%</span></td>
                <td className="text-right">
                  {canWrite && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openBracket(b)} title="Sửa thuế suất"><Pencil className="h-3.5 w-3.5" /></Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  )

  const mobileCards =
    brackets.length === 0 ? (
      <p className="py-8 text-center text-sm text-muted-foreground">Chưa có biểu thuế</p>
    ) : (
      <div className="space-y-3">
        {brackets.map((b) => (
          <ShellListCard key={b.id}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">Bậc {b.bracket_order}</span>
              <div className="flex items-center gap-1">
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">{Number(b.rate)}%</span>
                {canWrite && (
                  <Button size="icon" variant="ghost" onClick={() => openBracket(b)} aria-label="Sửa thuế suất">
                    <Pencil className="size-4" />
                  </Button>
                )}
              </div>
            </div>
            <ShellListCardRow label="Thu nhập tính thuế / tháng" value={`${fmt(b.lower_bound)} – ${fmt(b.upper_bound)}`} />
          </ShellListCard>
        ))}
      </div>
    )

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Thuế TNCN tính lũy tiến từng phần trên thu nhập tính thuế (= chịu thuế − bảo hiểm − giảm trừ gia cảnh). Engine tự áp vào phiếu lương.
      </p>

      <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Giảm trừ gia cảnh</CardTitle>
          {canWrite && setting && (
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 max-sm:min-w-11" onClick={() => openSetting(setting)} title="Sửa" aria-label="Sửa giảm trừ gia cảnh"><Pencil className="h-3.5 w-3.5" /></Button>
          )}
        </CardHeader>
        <CardContent className="text-sm">
          {setting ? (
            <div className="flex flex-wrap gap-x-8 gap-y-1">
              <span>Bản thân: <b>{fmt(setting.personal_deduction)}</b>/tháng</span>
              <span>Mỗi người phụ thuộc: <b>{fmt(setting.dependent_deduction)}</b>/tháng</span>
              <span className="text-muted-foreground">Hiệu lực từ {setting.effective_from}</span>
            </div>
          ) : <span className="text-muted-foreground">Chưa cấu hình giảm trừ gia cảnh</span>}
        </CardContent>
      </Card>

      <ShellResponsiveList table={desktopTable} cards={mobileCards} />

      <Dialog open={editBracket !== null} onOpenChange={(v) => { if (!v) setEditBracket(null) }}>
        <DialogContent className="sm:max-w-sm rounded-2xl">
          <DialogHeader><DialogTitle>Sửa thuế suất bậc {editBracket?.bracket_order}</DialogTitle></DialogHeader>
          <div className="space-y-2 py-2">
            <Label>Thuế suất (%)</Label>
            <Input className="max-sm:h-11" value={rateInput} onChange={(e) => setRateInput(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditBracket(null)}>Huỷ</Button>
            <Button onClick={saveBracket} disabled={updBracket.isPending}>
              {updBracket.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editSetting !== null} onOpenChange={(v) => { if (!v) setEditSetting(null) }}>
        <DialogContent className="sm:max-w-sm rounded-2xl">
          <DialogHeader><DialogTitle>Sửa giảm trừ gia cảnh</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2"><Label>Giảm trừ bản thân (VNĐ)</Label><Input className="max-sm:h-11" value={personalInput} onChange={(e) => setPersonalInput(e.target.value)} /></div>
            <div className="space-y-2"><Label>Giảm trừ mỗi người phụ thuộc (VNĐ)</Label><Input className="max-sm:h-11" value={depInput} onChange={(e) => setDepInput(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditSetting(null)}>Huỷ</Button>
            <Button onClick={saveSetting} disabled={updSetting.isPending}>
              {updSetting.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
