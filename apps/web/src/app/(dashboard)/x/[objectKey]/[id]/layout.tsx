import type { ReactNode } from "react"

/** Trang giữ chỗ `_` cho bản xuất tĩnh — xem `contacts/[id]/layout.tsx`. */
export function generateStaticParams() {
  return [{ id: "_" }]
}

export default function RecordIdLayout({ children }: { children: ReactNode }) {
  return children
}
