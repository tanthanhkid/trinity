import type { ReactNode } from "react"

/**
 * Bản xuất tĩnh (`pnpm build:export`) cần `generateStaticParams` cho mọi đoạn động: xuất MỘT trang giữ chỗ `_`, Rust trả nó
 * cho mọi id (như contacts/[id]). Để ở layout vì trang là client component không export được hàm này.
 */
export function generateStaticParams() {
  return [{ id: "_" }]
}

export default function KanbanCardIdLayout({ children }: { children: ReactNode }) {
  return children
}
