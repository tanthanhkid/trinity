import type { ReactNode } from "react"

/** Trang giữ chỗ `_` cho bản xuất tĩnh — xem `contacts/[id]/layout.tsx`. */
export function generateStaticParams() {
  return [{ objectKey: "_" }]
}

export default function ObjectKeyLayout({ children }: { children: ReactNode }) {
  return children
}
