"use client"

import { ShieldAlert } from "lucide-react"
import { useChannelAlerts } from "@/hooks/use-channel-guard"

/**
 * Dải cảnh báo kênh gửi ra ngoài: kênh bị Trinity tạm khoá, gửi tự động tạm dừng (Facebook báo chặn/spam),
 * hoặc sắp/đã hết hạn mức của gói. Chỉ hiện khi chạy nhiều công ty và có cảnh báo; không có thì không chiếm chỗ.
 */
export function ChannelGuardBanner() {
  const { data } = useChannelAlerts()
  if (!data?.enforced || data.warnings.length === 0) return null
  const hard = data.locked || data.paused
  return (
    <div
      role="alert"
      data-testid="channel-guard-banner"
      className={`mx-5 mt-3 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm max-sm:mx-4 ${hard ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"}`}
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-0.5">
        {data.warnings.map((w) => (
          <p key={w}>{w}</p>
        ))}
      </div>
    </div>
  )
}
