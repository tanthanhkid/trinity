import { Suspense } from "react"
import { AiActionsScreen } from "./_components/ai-actions-screen"

/**
 * Hoạt động AI — nằm TRONG `(dashboard)` để dùng chung layout/cây provider (KHÔNG tạo route group
 * anh em). Không cần `PermissionGate`: BE chỉ trả hoạt động của CHÍNH người đăng nhập (`@AuthOnly` + lọc theo user);
 * quyền nghiệp vụ được kiểm lại ở BE lúc duyệt.
 */
export default function AiActionsPage() {
  // màn dùng `useSearchParams()` (mở thẳng đề xuất từ `?id=`) ⇒ phải bọc Suspense.
  return (
    <Suspense fallback={null}>
      <AiActionsScreen />
    </Suspense>
  )
}
