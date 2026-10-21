"use client"

import { useEffect, useRef, useSyncExternalStore } from "react"
import { WifiOff } from "lucide-react"
import { toast } from "sonner"

function subscribe(cb: () => void) {
  window.addEventListener("online", cb)
  window.addEventListener("offline", cb)
  return () => {
    window.removeEventListener("online", cb)
    window.removeEventListener("offline", cb)
  }
}

/** `true` khi trình duyệt báo mất mạng. SSR và lần hydrate đầu coi như có mạng (cùng markup). */
export function useOffline(): boolean {
  return useSyncExternalStore(subscribe, () => !navigator.onLine, () => false)
}

/**
 * Dải báo mất mạng ở đầu vùng nội dung: nói rõ chuyện gì + điều gì xảy ra với thao tác đang làm.
 * React Query tự tạm dừng khi mất mạng và tự tải lại khi có mạng ⇒ có mạng lại chỉ cần báo một câu ngắn.
 */
export function OfflineBanner() {
  const offline = useOffline()
  const wasOffline = useRef(false)

  useEffect(() => {
    if (offline) {
      wasOffline.current = true
    } else if (wasOffline.current) {
      wasOffline.current = false
      toast.success("Đã có mạng lại — dữ liệu đang được cập nhật.")
    }
  }, [offline])

  if (!offline) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="flex items-center gap-2.5 border-b border-amber-300/60 bg-amber-50 px-5 py-2 text-[14px] text-amber-900 max-sm:px-4 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <WifiOff className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0">
        <span className="font-medium">Mất kết nối mạng.</span> Thay đổi lúc này chưa được lưu — kiểm tra Wi‑Fi/4G, Trinity sẽ tự tải lại khi có mạng.
      </p>
    </div>
  )
}
