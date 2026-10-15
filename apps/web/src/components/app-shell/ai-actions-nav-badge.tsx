"use client"

import { useAiActionsPendingCount } from "@/hooks/ai-actions/use-ai-actions"

/**
 * Chấm số đề xuất từ AI đang chờ duyệt cạnh mục "Hoạt động AI". Lỗi / tính năng tắt (404) / 0 ⇒ không hiện gì.
 * Chỉ mount khi mục menu hiện (đã qua kiểm quyền `integrations.ai_connect`) nên không gọi API thừa.
 */
export function AiActionsNavBadge() {
  const { data } = useAiActionsPendingCount()
  if (!data) return null
  return (
    <i className="app-nav-tag" data-tone="hot" role="status" aria-label={`${data} đề xuất từ AI đang chờ duyệt`}>
      {data > 99 ? "99+" : data}
    </i>
  )
}
