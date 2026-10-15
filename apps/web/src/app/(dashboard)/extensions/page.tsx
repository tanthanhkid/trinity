import { Suspense } from "react"
import { Code2 } from "lucide-react"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { ExtensionsScreen } from "@/components/extensions/extensions-screen"

/**
 * Chương trình con — nằm TRONG `(dashboard)` (không tạo route group anh em). Không cần PermissionGate: BE chặn bằng
 * `extensions.view` / `extensions.approve` và cờ tính năng (404). Đích của thông báo "trợ lý AI gửi chương trình con chờ duyệt" (`?id=`).
 */
export default function ExtensionsPage() {
  // màn dùng `useSearchParams()` ⇒ phải bọc Suspense.
  return (
    <div className="space-y-4">
      <ShellPageHeader title="Chương trình con" icon={Code2} description="Tính năng nhỏ do trợ lý AI viết, chạy tách riêng sau khi bạn duyệt." />
      <Suspense fallback={null}>
        <ExtensionsScreen />
      </Suspense>
    </div>
  )
}
