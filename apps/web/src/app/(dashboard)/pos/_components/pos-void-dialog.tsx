"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useVoidOrder } from "@/hooks/pos/use-pos"
import { posErrorMessage } from "@/lib/pos-format"

const schema = z.object({ reason: z.string().trim().min(3, "Nhập lý do huỷ (ít nhất 3 ký tự)").max(500) })
type Form = z.infer<typeof schema>

/** Huỷ đơn có lý do (bắt buộc — lưu vết). Đơn đã thu tiền chỉ quản lý huỷ được (BE kiểm). */
export function PosVoidDialog({ orderId, code, onClose, onVoided }: { orderId: number; code: string; onClose: () => void; onVoided: () => void }) {
  const voidOrder = useVoidOrder()
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { reason: "" } })
  const submit = handleSubmit(({ reason }) =>
    voidOrder.mutate({ id: orderId, reason }, {
      onSuccess: () => { toast.success(`Đã huỷ đơn ${code}`); onVoided() },
      onError: (e) => toast.error(posErrorMessage(e, "Không huỷ được đơn")),
    }),
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader><DialogTitle>Huỷ đơn {code}</DialogTitle></DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="pos-void-reason">Lý do huỷ</Label>
            <Input id="pos-void-reason" className="h-11" autoFocus {...register("reason")} aria-invalid={!!errors.reason} />
            {errors.reason && <p role="alert" className="text-sm text-destructive">{errors.reason.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11" onClick={onClose}>Không huỷ</Button>
            <Button type="submit" variant="destructive" className="min-h-11" disabled={voidOrder.isPending}>Huỷ đơn</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
