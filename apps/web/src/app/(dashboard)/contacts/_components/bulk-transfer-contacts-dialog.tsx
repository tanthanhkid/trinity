"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  useAssignableContactSales,
  useBulkTransferContacts,
} from "@/hooks/use-contact-transfer"

/**
 * DEPT_HEAD/team_lead/super_admin chuyển quyền phụ trách NHIỀU liên
 * hệ (Danh bạ) đã chọn trên `/contacts` sang 1 người khác (ví dụ khi
 * nhân viên nghỉ việc). Tái dùng
 * `selectedIds` đã có sẵn cho bulk-delete (super_admin) — nút này thêm bên
 * cạnh, KHÔNG đụng luồng xoá hiện hữu.
 */
export function BulkTransferContactsDialog({
  open,
  onOpenChange,
  contactIds,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  contactIds: string[]
  onDone: () => void
}) {
  const [search, setSearch] = useState("")
  const [selectedSaleId, setSelectedSaleId] = useState<number | null>(null)
  const { data: saleUsers = [], isLoading } = useAssignableContactSales({ enabled: open })
  const bulkTransfer = useBulkTransferContacts()

  const filtered = saleUsers.filter((u) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })

  const handleClose = () => {
    setSearch("")
    setSelectedSaleId(null)
    onOpenChange(false)
  }

  const handleConfirm = () => {
    if (!selectedSaleId) return
    bulkTransfer.mutate(
      { contact_ids: contactIds.map(Number), new_assigned_to: selectedSaleId },
      {
        onSuccess: (result) => {
          if (result.transferredIds.length > 0) {
            toast.success(`Đã chuyển ${result.transferredIds.length} khách hàng thành công`)
          }
          if (result.failed.length > 0) {
            toast.error(
              `${result.failed.length} khách hàng chuyển thất bại: ` +
                result.failed.slice(0, 3).map((f) => f.error).join("; ") +
                (result.failed.length > 3 ? "..." : ""),
              { duration: 8000 },
            )
          }
          onDone()
          handleClose()
        },
        onError: (err) => {
          const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          toast.error(msg ?? "Không thể chuyển khách hàng. Vui lòng thử lại.")
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Chuyển {contactIds.length} khách hàng cho sale khác</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            autoFocus
            placeholder={isLoading ? "Đang tải..." : "Tìm sale..."}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-60 overflow-y-auto rounded-lg border">
            {filtered.length > 0 ? (
              filtered.map((sale) => (
                <button
                  key={sale.id}
                  type="button"
                  onClick={() => setSelectedSaleId(sale.id)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 border-b last:border-b-0 ${
                    selectedSaleId === sale.id ? "bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)] font-semibold" : ""
                  }`}
                >
                  {sale.full_name}
                  <span className="ml-2 text-xs text-muted-foreground">{sale.email}</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                {isLoading ? "Đang tải..." : "Không tìm thấy sale phù hợp trong phạm vi quản lý."}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            Huỷ
          </Button>
          <Button
            disabled={!selectedSaleId || bulkTransfer.isPending}
            onClick={handleConfirm}
          >
            {bulkTransfer.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Xác nhận chuyển
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
