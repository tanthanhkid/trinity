import { Star } from "lucide-react"
import { StageChip } from "@/components/ui/stage-chip"

/** Trạng thái dùng chung card + trang: chip «Ánh xanh» (đang bán = xanh lá, ngừng = trung tính). */
export function ProductStatusBadge({ active }: { active: boolean }) {
  return active ? <StageChip tone="won" size="sm">Đang mở bán</StageChip> : <StageChip tone="neutral" size="sm">Ngừng bán</StageChip>
}

export function ProductFeaturedBadge() {
  return (
    <StageChip tone="new" size="sm">
      <Star aria-hidden className="size-3" /> Nổi bật
    </StageChip>
  )
}
