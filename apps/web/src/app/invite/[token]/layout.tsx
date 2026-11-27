import type { ReactNode } from "react"

/** Trang giữ chỗ `_` cho bản xuất tĩnh — xem `contacts/[id]/layout.tsx`. */
export function generateStaticParams() {
  return [{ token: "_" }]
}

export default function InviteTokenLayout({ children }: { children: ReactNode }) {
  return children
}
