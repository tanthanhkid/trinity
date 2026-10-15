import { Suspense } from "react"
import { SocialScreen } from "./_components/social-screen"

/** Đăng đa kênh — màn dùng `useSearchParams()` (tab, kết quả OAuth) ⇒ bọc Suspense. */
export default function SocialPage() {
  return (
    <Suspense fallback={null}>
      <SocialScreen />
    </Suspense>
  )
}
