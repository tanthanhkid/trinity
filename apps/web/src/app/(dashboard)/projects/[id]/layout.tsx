import type { ReactNode } from "react"

/**
 * Bản xuất tĩnh (`pnpm build:export`) cần `generateStaticParams` cho mọi đoạn động: xuất MỘT trang giữ chỗ `_`, Rust trả nó
 * cho mọi id (R004, phương án A). Để ở layout vì trang là client component không export được hàm này. Bản `standalone` vẫn
 * dựng theo yêu cầu cho giá trị khác (không đặt `dynamicParams = false`; chỉ `true` mới bị `output: export` từ chối).
 */
export function generateStaticParams() {
  return [{ id: "_" }]
}

export default function ProjectIdLayout({ children }: { children: ReactNode }) {
  return children
}
