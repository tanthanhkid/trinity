import { Suspense } from "react"
import { BriefingsScreen } from "./_components/briefings-screen"

/** Bản tin sáng/chiều — nằm TRONG `(dashboard)`. BE chỉ trả bản tin của chính người đăng nhập. */
export default function BriefingsPage() {
  // màn dùng `useSearchParams()` (mở thẳng một bản tin từ `?id=` trong thông báo) ⇒ bọc Suspense.
  return (
    <Suspense fallback={null}>
      <BriefingsScreen />
    </Suspense>
  )
}
