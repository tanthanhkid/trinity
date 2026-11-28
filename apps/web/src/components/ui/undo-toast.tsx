"use client"

import * as React from "react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"

/** Thời gian toast có Hoàn tác tự ẩn (ms). */
export const UNDO_TOAST_DURATION = 5000

/**
 * Toast «Ánh xanh» có nút Hoàn tác (docs/design/anh-xanh.md): thanh tối gradient
 * #26282E → #17181C, bo 12, bóng tầng «nổi»; chữ trắng, nút Hoàn tác chữ #BFD6EA.
 *
 * Dùng `showUndoToast()` (đi qua `<Toaster>` của sonner sẵn có trong `app/providers.tsx`).
 * Mẫu dùng: lưu NGAY (lạc quan) rồi cho hoàn tác, thay vì hỏi xác nhận trước.
 * Rộng `w-full` = theo khung toast của sonner (`--width`, 356px; điện thoại gần hết ngang).
 *
 * @example
 * await saveField("phone", next)
 * showUndoToast("Đã lưu số điện thoại", { onUndo: () => saveField("phone", prev) })
 */
export function UndoToast({
  message,
  onUndo,
  undoLabel = "Hoàn tác",
  className,
}: {
  message: React.ReactNode
  onUndo?: () => void
  undoLabel?: string
  className?: string
}) {
  return (
    <div
      data-slot="undo-toast"
      className={cn(
        "flex w-full items-center gap-4 rounded-[var(--ax-radius-card)] py-3 pr-2 pl-4 text-white ax-grad-toast shadow-[var(--ax-shadow-float)]",
        className,
      )}
    >
      <span className="min-w-0 flex-1 text-sm">{message}</span>
      {onUndo ? (
        <button
          type="button"
          onClick={onUndo}
          className="relative h-8 shrink-0 cursor-pointer rounded-[var(--ax-radius-field)] px-3 text-sm font-semibold text-[var(--ax-toast-action)] transition-colors duration-150 outline-none hover:bg-white/10 focus-visible:shadow-[0_0_0_2px_#17181c,0_0_0_4px_rgba(191,214,234,.7)] after:absolute after:top-1/2 after:left-1/2 after:h-11 after:w-[max(100%,44px)] after:-translate-x-1/2 after:-translate-y-1/2"
        >
          {undoLabel}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Hiện toast có Hoàn tác. Bấm Hoàn tác ⇒ gọi `onUndo` một lần rồi đóng toast.
 * Trả về id toast (để `toast.dismiss(id)` nếu cần đóng sớm).
 */
export function showUndoToast(
  message: React.ReactNode,
  {
    onUndo,
    undoLabel,
    duration = UNDO_TOAST_DURATION,
  }: { onUndo?: () => void; undoLabel?: string; duration?: number } = {},
): string | number {
  let done = false
  return toast.custom(
    (id) => (
      <UndoToast
        message={message}
        undoLabel={undoLabel}
        onUndo={
          onUndo
            ? () => {
                if (done) return
                done = true
                toast.dismiss(id)
                onUndo()
              }
            : undefined
        }
      />
    ),
    { duration },
  )
}
