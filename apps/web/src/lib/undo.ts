import { toast } from "sonner"

/** Cửa sổ hoàn tác chung: 5 giây — đủ để nhận ra bấm nhầm, không đủ lâu để quên. */
export const UNDO_WINDOW_MS = 5000
export const UNDO_LABEL = "Hoàn tác"

type Pending = { timer: ReturnType<typeof setTimeout> | null; run: () => void }
const pending = new Set<Pending>()

/** Chạy ngay mọi thao tác đang chờ hết cửa sổ hoàn tác (đóng tab / tải lại trang thì không bỏ rơi việc người dùng đã bấm). */
export function flushUndoables() {
  for (const p of [...pending]) p.run()
}
if (typeof window !== "undefined") window.addEventListener("pagehide", flushUndoables)

/**
 * Thao tác KHÔNG có đường lùi trên máy chủ (xoá): ẩn ngay trên màn hình, chỉ gửi lên máy chủ sau 5 giây.
 * Bấm "Hoàn tác" trong 5 giây ⇒ không gửi gì, gọi `onUndo` để hiện lại.
 * Biến điều khiển nằm ngoài component nên chuyển trang trong lúc chờ vẫn gửi đúng hẹn.
 */
export function deferWithUndo({
  message,
  commit,
  onUndo,
  undoneMessage = "Đã hoàn tác",
}: {
  message: string
  commit: () => Promise<unknown> | void
  onUndo: () => void
  undoneMessage?: string
}) {
  let settled = false
  const entry: Pending = {
    timer: null,
    run: () => {
      if (settled) return
      settled = true
      if (entry.timer) clearTimeout(entry.timer)
      pending.delete(entry)
      void commit()
    },
  }
  entry.timer = setTimeout(entry.run, UNDO_WINDOW_MS)
  pending.add(entry)
  toast.success(message, {
    duration: UNDO_WINDOW_MS,
    action: {
      label: UNDO_LABEL,
      onClick: () => {
        if (settled) return
        settled = true
        if (entry.timer) clearTimeout(entry.timer)
        pending.delete(entry)
        onUndo()
        toast(undoneMessage)
      },
    },
  })
}

/**
 * Thao tác ĐÃ có đường lùi (đổi trạng thái, kéo thẻ, gỡ kênh có thể bật lại): làm ngay,
 * toast 5 giây kèm "Hoàn tác" gọi thao tác ngược.
 */
export function toastWithUndo({ message, onUndo }: { message: string; onUndo: () => void }) {
  let used = false
  toast.success(message, {
    duration: UNDO_WINDOW_MS,
    action: {
      label: UNDO_LABEL,
      onClick: () => {
        if (used) return
        used = true
        onUndo()
      },
    },
  })
}
