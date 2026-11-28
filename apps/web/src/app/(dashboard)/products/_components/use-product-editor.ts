"use client"

/**
 * Trạng thái sửa một sản phẩm cho cả hai bố cục: bản nháp, bản đã lưu, lưu (kèm Hoàn tác) và lưu nhanh từng trường.
 * Lưu = `PATCH /products/:id` (`useUpdateProduct`) chỉ với các trường đã đổi; Hoàn tác gửi lại giá trị cũ của đúng các trường đó.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { getApiErrorMessage } from "@/lib/api-client"
import { showUndoToast } from "@/components/ui/undo-toast"
import { useUpdateProduct } from "@/hooks/products/use-products"
import type { Product } from "@/types/product"
import {
  changedFields,
  countChanges,
  draftFromProduct,
  fieldsToPayload,
  hasErrors,
  mergeIntoDraft,
  pickFields,
  sameFields,
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

  // Bản đã lưu mới nhất cho Hoàn tác (toast sống lâu hơn một lần vẽ).
  const savedRef = useRef(saved)
  useEffect(() => {
    savedRef.current = saved
  }, [saved])

  /**
   * Gửi CHỈ các trường `fields`; thành công ⇒ cập nhật bản đã lưu và áp vào bản nháp — trường nào bản nháp đã khác
   * `expected` (người dùng gõ tiếp trong lúc chờ) thì giữ chữ đang gõ. Dùng `mutateAsync` để MỖI lần gửi đều nhận kết quả
   * (`mutate` chỉ gọi callback của lần gọi sau cùng).
   */
  const mutateFields = useCallback(
    (fields: Partial<ProductDraft>, expected: Partial<ProductDraft>, errorText: string, after?: () => void) => {
      update.mutateAsync({ id: product.id, payload: fieldsToPayload(fields) }).then(
        () => {
          setSaved((s) => ({ ...s, ...fields }))
          setDraft((d) => mergeIntoDraft(d, fields, expected))
          after?.()
        },
        (err: unknown) => toast.error(getApiErrorMessage(err, errorText)),
      )
    },
    [product.id, update],
  )

  /** Lưu `fields` (giá trị cũ `prev`) rồi toast Hoàn tác — Hoàn tác chỉ trả lại đúng các trường đó. */
  const send = useCallback(
    (fields: Partial<ProductDraft>, prev: Partial<ProductDraft>, expected: Partial<ProductDraft>, message: string, onDone?: () => void) => {
      mutateFields(fields, expected, "Lưu thất bại, thử lại sau", () => {
        onDone?.()
        showUndoToast(message, {
          onUndo: () => {
            // Trường đó đã được lưu lại lần nữa sau lần này ⇒ không hoàn tác đè lên bản mới hơn.
            if (!sameFields(pickFields(savedRef.current, fields), fields)) {
              toast.error("Đã có thay đổi mới hơn nên không hoàn tác lần lưu này")
              return
            }
            mutateFields(prev, fields, "Chưa hoàn tác được")
          },
        })
      })
    },
    [mutateFields],
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
      const fields = changedFields(saved, draft)
      send(fields, pickFields(saved, fields), fields, "Đã lưu sản phẩm", onDone)
      return true
    },
    [changes, errors, send, draft, saved],
  )

  /** Lưu NGAY một vài trường (đổi giá, ẩn/mở bán, ảnh) — chỉ gửi đúng các trường đó, không đụng phần nháp khác. */
  const quickSave = useCallback(
    (p: Partial<ProductDraft>, message: string, onDone?: () => void) => {
      const prev = pickFields(saved, p)
      send(p, prev, prev, message, onDone)
    },
    [send, saved],
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

export type ProductEditor = ReturnType<typeof useProductEditor>
