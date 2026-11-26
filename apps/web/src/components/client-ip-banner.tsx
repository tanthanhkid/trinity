"use client"

import { ShieldAlert } from "lucide-react"
import { useClientIpAlert } from "@/hooks/use-client-ip-alert"

/**
 * Dải cảnh báo cho quản trị viên khi máy chủ không xác định được IP thật của người dùng (TRUSTED_PROXY chưa khớp cách
 * triển khai): kiểm IP văn phòng khi đăng nhập và chấm công đang tạm cho qua. Hiện ở mọi trang tới khi sửa xong.
 */
export function ClientIpBanner() {
  const { data } = useClientIpAlert()
  if (!data?.warning) return null
  return (
    <div
      role="alert"
      data-testid="client-ip-banner"
      className="mx-5 mt-3 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200 max-sm:mx-4"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{data.warning}</p>
    </div>
  )
}
