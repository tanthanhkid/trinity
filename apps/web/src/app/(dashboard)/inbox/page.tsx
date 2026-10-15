import { Suspense } from "react"
import { InboxScreen } from "./_components/inbox-screen"

/**
 * Hộp thư (Zalo OA + Messenger) — mục riêng trên sidebar. Quyền theo từng kênh do `inboxChannels` quyết
 * (giống hai hộp thư trong Cài đặt > Kết nối & AI, đường cũ vẫn giữ); BE vẫn kiểm quyền từng API.
 * `useSearchParams()` (`?kenh=`) ⇒ bọc Suspense.
 */
export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxScreen />
    </Suspense>
  )
}
