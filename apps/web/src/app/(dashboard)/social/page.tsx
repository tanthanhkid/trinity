import { Suspense } from "react"
import { LoadingBlock } from "@/components/ui/loading-block"
import { SocialScreen } from "./_components/social-screen"

/** Đăng đa kênh — màn dùng `useSearchParams()` (tab, kết quả OAuth) ⇒ bọc Suspense. */
export default function SocialPage() {
  return (
    <Suspense fallback={<LoadingBlock count={4} label="Đang tải Đăng đa kênh…" />}>
      <SocialScreen />
    </Suspense>
  )
}
