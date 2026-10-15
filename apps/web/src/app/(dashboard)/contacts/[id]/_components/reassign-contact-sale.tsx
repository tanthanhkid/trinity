"use client"

/**
 * Nút + dialog "Chuyển khách hàng" ở chi tiết Danh bạ.
 * Chuyển SALE phụ trách (`contacts.assigned_to`) qua `POST /contacts/:id/transfer`.
 * Mặc định chọn sẵn sale ĐANG phụ trách; đổi sang sale khác rồi bấm "Chuyển".
 * Quyền: `contacts.transfer` (RBAC quyền + phạm vi, thay so tên vai trò) — BE tự kiểm phạm vi.
 */
import { useMemo, useState } from "react"
import { ArrowRightLeft } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { InlineSelect, type InlineSelectOption } from "@/components/ui/inline-select"
import { getApiErrorMessage } from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"
import { useTransferContact, useAssignableContactSales } from "@/hooks/use-contact-transfer"

const DEFAULT_REASON = "Chuyển khách hàng cho sale khác"

/** Option sale; luôn có người đang phụ trách dù họ không nằm trong danh sách được phép nhận. */
export function buildSaleOptions(
  sales: Array<{ id: number; full_name: string; email: string }>,
  currentId: number | null,
  currentName: string | null,
): InlineSelectOption<number>[] {
  const opts = sales.map((s) => ({
    value: s.id,
    label: s.id === currentId ? `${s.full_name} (đang phụ trách)` : s.full_name,
    description: s.email,
  }))
  if (currentId != null && !sales.some((s) => s.id === currentId)) {
    opts.unshift({
      value: currentId,
      label: `${currentName ?? "Người phụ trách hiện tại"} (đang phụ trách)`,
      description: "",
    })
  }
  return opts
}

interface Props {
  contactId: string
  contactName?: string | null
  assignedTo: number | null
  assigneeName: string | null
}

export function ReassignContactSaleButton({
  contactId, contactName, assignedTo, assigneeName,
}: Props) {
  const { can } = usePermissions()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<number | null>(assignedTo)
  const [note, setNote] = useState("")
  const transfer = useTransferContact(contactId)
  const { data: sales = [], isLoading } = useAssignableContactSales({ enabled: open })

  // Mỗi lần mở: đặt lại mặc định = sale đang phụ trách.
  const openDialog = () => {
    setTarget(assignedTo)
    setNote("")
    setOpen(true)
  }

  const options = useMemo(
    () => buildSaleOptions(sales, assignedTo, assigneeName),
    [sales, assignedTo, assigneeName],
  )

  if (!can("contacts.transfer")) return null

  const unchanged = target == null || target === assignedTo
  const submit = () => {
    if (target == null || unchanged) return
    transfer.mutate(
      { new_assigned_to: target, reason: note.trim() || DEFAULT_REASON },
      {
        onSuccess: () => {
          toast.success("Đã chuyển khách hàng cho sale mới")
          setOpen(false)
        },
        onError: (e) => toast.error(getApiErrorMessage(e, "Không thể chuyển khách hàng. Vui lòng thử lại.")),
      },
    )
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={openDialog}
        title="Chuyển khách hàng cho sale khác"
        className="h-9 text-sm"
      >
        <ArrowRightLeft className="mr-1.5 h-4 w-4" />
        Chuyển khách hàng
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Chuyển khách hàng{contactName ? ` ${contactName}` : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label htmlFor="reassign-contact-sale" className="mb-1 block text-sm font-medium text-muted-foreground">
                Sale phụ trách
              </label>
              <InlineSelect<number>
                id="reassign-contact-sale"
                options={options}
                value={target}
                onChange={setTarget}
                loading={isLoading && options.length === 0}
                searchable
                placeholder="Chọn sale…"
                emptyText="Không có sale phù hợp trong phạm vi quản lý"
              />
              <p className="mt-1 text-sm text-muted-foreground">
                Mặc định là sale đang phụ trách khách hàng này. Chọn sale khác để chuyển.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-muted-foreground">
                Lý do (không bắt buộc)
              </label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Huỷ</Button>
            <Button type="button" disabled={unchanged || transfer.isPending} onClick={submit}>
              {transfer.isPending ? "Đang chuyển…" : "Chuyển khách hàng"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
