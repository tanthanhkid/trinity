import { Suspense } from "react"
import type { Metadata } from "next"
import { Loader2 } from "lucide-react"
import { AuthorizeContent } from "./_components/authorize-content"

export const metadata: Metadata = {
  title: "Cho phép kết nối ứng dụng AI — Trinity CRM",
  // Trang chứa tham số uỷ quyền — không cho công cụ tìm kiếm lập chỉ mục, không gửi Referer đi nơi khác.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

/**
 * Trang đồng ý OAuth. Nằm NGOÀI `(dashboard)` (như `/login`): không cần cây provider của dashboard.
 * `useSearchParams()` bắt buộc bọc `<Suspense>`.
 */
export default function AuthorizePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Đang kiểm tra yêu cầu...
        </div>
      }
    >
      <AuthorizeContent />
    </Suspense>
  )
}
