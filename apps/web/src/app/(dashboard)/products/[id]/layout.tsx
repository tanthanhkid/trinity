import type { ReactNode } from "react"

/** Bản xuất tĩnh: một trang giữ chỗ `_`, Rust trả cho mọi id (cùng cách `contacts/[id]`). */
export function generateStaticParams() {
  return [{ id: "_" }]
}

export default function ProductIdLayout({ children }: { children: ReactNode }) {
  return children
}
