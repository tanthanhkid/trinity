"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { PayrollMobileRowMenu } from "./payroll-mobile-row-menu"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog"
import { usePermissions } from "@/lib/rbac"
import { monthToVnDate } from "@/lib/format"
import {
  type SalaryComponent, type ComponentType,
  useSalaryComponents, useDeleteSalaryComponent, getApiErrorMessage,
} from "@/hooks/use-salary-components"
import { SalaryComponentDialog } from "./salary-component-dialog"

const TYPE_META: Record<ComponentType, { label: string; cls: string }> = {
  allowance: { label: "Phụ cấp", cls: "bg-emerald-50 text-emerald-600" },
  bonus: { label: "Thưởng", cls: "bg-sky-50 text-sky-700" },
  deduction: { label: "Khấu trừ", cls: "bg-rose-50 text-rose-600" },
}

function fmtValue(c: SalaryComponent): string {
  if (c.calc_method === "percent_base") return `${Number(c.percent_value ?? 0)}% lương CB`
  return `${Number(c.fixed_amount ?? 0).toLocaleString("vi-VN")} đ`
}

function fmtRange(c: SalaryComponent): string {
  const from = monthToVnDate(c.effective_from)
  return c.effective_to ? `${from} → ${monthToVnDate(c.effective_to)}` : `Từ ${from}`
}

export function PayrollSalaryComponents() {
  const canWrite = usePermissions().can("payroll.manage")
  const canDelete = canWrite
  const { data, isLoading, isError } = useSalaryComponents()
  const del = useDeleteSalaryComponent()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<SalaryComponent | null>(null)
  const [deleting, setDeleting] = useState<SalaryComponent | null>(null)

  const items = data ?? []

  function openCreate() { setEditing(null); setDialogOpen(true) }
  function openEdit(c: SalaryComponent) { setEditing(c); setDialogOpen(true) }

  function confirmDelete() {
    if (!deleting) return
    del.mutate(deleting.id, {
      onSuccess: () => { toast.success("Đã xoá thành phần lương"); setDeleting(null) },
      onError: (e) => toast.error(getApiErrorMessage(e, "Xoá thất bại")),
    })
  }

  const desktopTable = (
        <div className="overflow-x-auto rounded-2xl border">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Tên</th><th>Mã</th><th>Loại</th><th>Giá trị</th>
                <th>Áp cho</th><th>Hiệu lực</th><th>Trạng thái</th><th className="text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">Chưa có thành phần lương nào</td></tr>
              )}
              {items.map((c) => (
                <tr key={c.id} className="border-t [&>td]:px-3 [&>td]:py-2">
                  <td className="font-medium">{c.name}</td>
                  <td className="font-mono text-xs text-muted-foreground">{c.code}</td>
                  <td><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_META[c.component_type].cls}`}>{TYPE_META[c.component_type].label}</span></td>
                  <td>{fmtValue(c)}</td>
                  <td className="text-xs">{c.applies_to === "all" ? "Toàn bộ" : c.applies_to}</td>
                  <td className="text-xs">{fmtRange(c)}</td>
                  <td>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.is_active ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>
                      {c.is_active ? "Đang áp dụng" : "Tắt"}
                    </span>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {canWrite && (
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(c)} title="Sửa">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => setDeleting(c)} title="Xoá">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
  )

  const mobileCards =
    items.length === 0 ? (
      <p className="py-8 text-center text-sm text-muted-foreground">Chưa có thành phần lương nào</p>
    ) : (
      <div className="space-y-3">
        {items.map((c) => (
          <ShellListCard key={c.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold">{c.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{c.code}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_META[c.component_type].cls}`}>{TYPE_META[c.component_type].label}</span>
                {(canWrite || canDelete) && (
                  <PayrollMobileRowMenu
                    items={[
                      ...(canWrite ? [{ label: "Sửa", icon: Pencil, onClick: () => openEdit(c) }] : []),
                      ...(canDelete ? [{ label: "Xoá", icon: Trash2, onClick: () => setDeleting(c), destructive: true }] : []),
                    ]}
                  />
                )}
              </div>
            </div>
            <ShellListCardRow label="Giá trị" value={fmtValue(c)} />
            <ShellListCardRow label="Áp cho" value={c.applies_to === "all" ? "Toàn bộ" : c.applies_to} />
            <ShellListCardRow label="Hiệu lực" value={fmtRange(c)} />
            <ShellListCardRow
              label="Trạng thái"
              value={
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.is_active ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>
                  {c.is_active ? "Đang áp dụng" : "Tắt"}
                </span>
              }
            />
          </ShellListCard>
        ))}
      </div>
    )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Cấu hình phụ cấp / thưởng / khấu trừ. Hệ thống tự cộng/trừ vào phiếu lương theo kỳ hiệu lực.
        </p>
        {canWrite && (
          <Button className={`shrink-0 ${MOBILE_FAB_CLASS}`} onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />Thêm thành phần
          </Button>
        )}
      </div>

      {isLoading && <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}</div>}
      {isError && <p className="text-center text-red-500 py-8">Không thể tải danh sách thành phần lương</p>}

      {!isLoading && !isError && (
        <ShellResponsiveList table={desktopTable} cards={mobileCards} />
      )}

      {canWrite && (
        <SalaryComponentDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />
      )}

      <Dialog open={deleting !== null} onOpenChange={(v) => { if (!v) setDeleting(null) }}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Xoá thành phần lương?</DialogTitle>
            <DialogDescription>
              Xoá &quot;{deleting?.name}&quot; sẽ không áp dụng cho các phiếu lương tạo sau này. Phiếu lương cũ giữ nguyên giá trị đã tính.
            </DialogDescription>
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
