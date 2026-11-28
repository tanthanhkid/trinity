"use client"

/**
 * Trạng thái sửa một sản phẩm cho cả hai bố cục: bản nháp, bản đã lưu, lưu (kèm Hoàn tác) và lưu nhanh từng trường.
 * Lưu = `PATCH /products/:id` (`useUpdateProduct`); Hoàn tác gửi lại bản trước đó.
 */
import { useCallback, useState } from "react"
import { toast } from "sonner"
import { getApiErrorMessage } from "@/lib/api-client"
import { showUndoToast } from "@/components/ui/undo-toast"
import { useUpdateProduct } from "@/hooks/products/use-products"
import type { Product } from "@/types/product"
import {
  countChanges,
  draftFromProduct,
  draftToPayload,
  hasErrors,
  validateDraft,
  type ProductDraft,
} from "./product-draft"

export function useProductEditor(product: Product) {
  const update = useUpdateProduct()
  const [draft, setDraft] = useState<ProductDraft>(() => draftFromProduct(product))
  const [saved, setSaved] = useState<ProductDraft>(() => draftFromProduct(product))
  const [showErrors, setShowErrors] = useState(false)

  const changes = countChanges(draft, saved)
  const errors = validateDraft(draft)

  // Dữ liệu máy chủ đổi (người khác sửa, refetch) mà mình chưa sửa gì ⇒ theo máy chủ (chỉnh state ngay lúc vẽ, không qua effect).
  const [seen, setSeen] = useState(product)
  if (seen !== product) {
    setSeen(product)
    if (changes === 0) {
      const next = draftFromProduct(product)
      setDraft(next)
      setSaved(next)
    }
  }

  const patch = useCallback((p: Partial<ProductDraft>) => setDraft((d) => ({ ...d, ...p })), [])
  const discard = useCallback(() => {
    setDraft(saved)
    setShowErrors(false)
  }, [saved])

  /** Gửi `next` lên máy chủ; thành công ⇒ toast Hoàn tác trả về `before`. */
  const commit = useCallback(
    (next: ProductDraft, before: ProductDraft, message: string, onDone?: () => void) => {
      update.mutate(
        { id: product.id, payload: draftToPayload(next) },
        {
          onSuccess: () => {
            setSaved(next)
            setDraft(next)
            onDone?.()
            showUndoToast(message, {
              onUndo: () =>
                update.mutate(
                  { id: product.id, payload: draftToPayload(before) },
                  {
                    onSuccess: () => {
                      setSaved(before)
                      setDraft(before)
                    },
                    onError: (err) => toast.error(getApiErrorMessage(err, "Chưa hoàn tác được")),
                  },
                ),
            })
          },
          onError: (err) => toast.error(getApiErrorMessage(err, "Lưu thất bại, thử lại sau")),
        },
      )
    },
    [product.id, update],
  )

  /** Lưu cả bản nháp. Trả `false` nếu còn lỗi nhập (hoặc thiếu thuộc tính bắt buộc) — chưa gửi gì. */
  const save = useCallback(
    (onDone?: () => void, blocked?: () => boolean): boolean => {
      if (changes === 0) return false
      if (hasErrors(errors) || blocked?.()) {
        setShowErrors(true)
        return false
      }
      setShowErrors(false)
      commit(draft, saved, "Đã lưu sản phẩm", onDone)
      return true
    },
    [changes, errors, commit, draft, saved],
  )

  /** Lưu NGAY một vài trường (đổi giá, ẩn/mở bán, ảnh) trên nền bản đã lưu — không đụng phần nháp khác. */
  const quickSave = useCallback(
    (p: Partial<ProductDraft>, message: string, onDone?: () => void) => {
      commit({ ...saved, ...p }, saved, message, onDone)
    },
    [commit, saved],
  )

  return {
    draft,
    saved,
    patch,
    discard,
    save,
    quickSave,
    changes,
    errors: showErrors ? errors : {},
    showErrors,
    saving: update.isPending,
  }
}
