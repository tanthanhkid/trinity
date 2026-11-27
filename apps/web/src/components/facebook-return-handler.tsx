"use client"

import { useEffect } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { FB_KEYS, FB_RETURN_KEY, facebookResultMessage } from "@/app/(dashboard)/settings/_components/integrations/use-facebook"

/**
 * Facebook quay về `/connections?facebook=...` sau hộp thoại đăng nhập. Nếu bấm kết nối ở màn khác (vd. bước bắt đầu), đưa khách
 * về đúng màn đó và báo kết quả ("Đã kết nối N Page" hoặc lý do lỗi bằng tiếng Việt). Đang ở chính trang Kết nối thì để
 * FacebookPanel tự báo. Gắn ở layout nên chạy cả khi wizard chiếm màn hình.
 */
export function FacebookReturnHandler() {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const qc = useQueryClient()
  const result = params.get("facebook")
  useEffect(() => {
    if (!result) return
    let back: string | null = null
    try {
      back = sessionStorage.getItem(FB_RETURN_KEY)
      sessionStorage.removeItem(FB_RETURN_KEY)
    } catch {
      back = null
    }
    // Chỉ đường dẫn nội bộ, không phải URL ngoài.
    if (!back || !back.startsWith("/") || back.startsWith("//") || back.startsWith("/connections")) return
    if (result === "connected") toast.success(`Đã kết nối ${Number(params.get("pages") ?? 0)} Page`)
    else {
      const m = facebookResultMessage(result, params.get("reason"))
      if (m) (m.kind === "info" ? toast.message : toast.error)(m.text)
    }
    void qc.invalidateQueries({ queryKey: FB_KEYS.pages })
    void qc.invalidateQueries({ queryKey: ["setup", "wizard"] })
    router.replace(back)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, pathname])
  return null
}
