"use client"

import { EyeOff, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { Product } from "@/types/product"

/**
 * Xác nhận "Xoá" sản phẩm — xoá HẲN, không hoàn tác. Tách bạch với "Ẩn" (bật lại được).
 * BE trả 409 khi sản phẩm đã có trong đơn bán hàng/liên hệ: hiện NGUYÊN VĂN lý do của BE và
 * đổi sang hành động duy nhất còn lại là "Ẩn sản phẩm".
 */
export function ProductDeleteDialog({
  product,
  pending,
  error,
  onCancel,
  onConfirm,
  onHide,
}: {
  product: Product | null
  pending: boolean
  /** Thông điệp BE khi xoá bị từ chối (`conflict` = 409 → chỉ còn đường ẩn). */
  error: { message: string; conflict: boolean } | null
  onCancel: () => void
  onConfirm: (product: Product) => void
  onHide: (product: Product) => void
}) {
  const blocked = error?.conflict === true
  return (
    <Dialog open={!!product} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Xoá sản phẩm</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Xoá hẳn sản phẩm <strong className="text-foreground">{product?.name}</strong>? Hành động này{" "}
          <strong className="text-foreground">không thể hoàn tác</strong>. Nếu chỉ muốn ngừng bán,
          hãy chọn &quot;Ẩn&quot; — sản phẩm vẫn còn và bật lại được.
        </p>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Huỷ
          </Button>
          {product?.is_active && (
            <Button variant={blocked ? "default" : "outline"} disabled={pending} onClick={() => onHide(product)}>
              <EyeOff className="mr-1.5 size-4" /> Ẩn sản phẩm
            </Button>
          )}
          {!blocked && (
            <Button variant="destructive" disabled={pending} onClick={() => product && onConfirm(product)}>
              <Trash2 className="mr-1.5 size-4" /> Xoá vĩnh viễn
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
