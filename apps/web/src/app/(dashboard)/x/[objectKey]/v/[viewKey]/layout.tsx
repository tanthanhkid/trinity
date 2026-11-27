import type { ReactNode } from "react"

/** Trang giữ chỗ `_` cho bản xuất tĩnh — xem `contacts/[id]/layout.tsx`. */
export function generateStaticParams() {
  return [{ viewKey: "_" }]
}

export default function ViewKeyLayout({ children }: { children: ReactNode }) {
  return children
}
