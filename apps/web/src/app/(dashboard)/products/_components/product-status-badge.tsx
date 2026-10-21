import { Star } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { StatusTag } from "@/components/ui/status-tag"

/** Trạng thái dùng chung card + modal — mẫu chung `StatusTag` (đang chạy = xanh, tắt = xám). */
export function ProductStatusBadge({ active }: { active: boolean }) {
  return active ? <StatusTag kind="running">Đang mở bán</StatusTag> : <StatusTag kind="off">Ngừng bán</StatusTag>
}

export function ProductFeaturedBadge() {
  return (
    <Badge className="gap-1 border-[var(--color-app-primary)] bg-transparent text-[var(--color-app-primary-ink)]">
      <Star className="size-3" /> Nổi bật
    </Badge>
  )
}
