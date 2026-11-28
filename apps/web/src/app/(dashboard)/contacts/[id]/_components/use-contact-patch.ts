"use client"

import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import apiClient from "@/lib/api-client"
import { errorMessage } from "@/lib/error-messages"
import { showUndoToast } from "@/components/ui/undo-toast"

export type ContactPatch = Record<string, string | number | null>

/**
 * Lưu NGAY một vài trường của khách qua `PATCH /contacts/:id` (cùng API form đầy đủ) rồi hiện toast có Hoàn tác
 * (docs/design/anh-xanh.md: lưu lạc quan, không hỏi xác nhận). Hoàn tác = PATCH lại giá trị cũ.
 * `prev` = null ⇒ không có chỗ quay lại (vd giai đoạn chưa từng chọn, BE không nhận xoá) ⇒ toast không có nút Hoàn tác.
 */
export function useContactPatch(contactId: number | string) {
  const queryClient = useQueryClient()
  const id = String(contactId)

  const send = useCallback(
    async (data: ContactPatch) => {
      await apiClient.patch(`/contacts/${id}`, data)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["contact", id] }),
        queryClient.invalidateQueries({ queryKey: ["contacts"] }),
      ])
    },
    [id, queryClient],
  )

  return useCallback(
    async (
      message: string,
      next: ContactPatch,
      prev: ContactPatch | null,
      /** Có ⇒ lỗi đưa về chỗ gọi (hiện tại ô đang sửa) thay vì toast lỗi. */
      onError?: (message: string) => void,
    ): Promise<boolean> => {
      try {
        await send(next)
      } catch (err) {
        const msg = errorMessage(err, "Không thể cập nhật thông tin")
        if (onError) onError(msg)
        else toast.error(msg)
        return false
      }
      showUndoToast(message, {
        onUndo: prev
          ? () => {
              send(prev).catch((err) => toast.error(errorMessage(err, "Không thể hoàn tác")))
            }
          : undefined,
      })
      return true
    },
    [send],
  )
}
