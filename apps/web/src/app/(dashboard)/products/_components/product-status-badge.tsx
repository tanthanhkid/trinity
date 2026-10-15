import { Star } from "lucide-react"
import { Badge } from "@/components/ui/badge"

/** Badge trạng thái dùng chung card + modal: đang mở bán / ngừng bán. */
export function ProductStatusBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge className="bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]">
      <span aria-hidden className="size-1.5 rounded-full bg-[var(--color-app-primary)]" />
      Đang mở bán
    </Badge>
  ) : (
    <Badge className="bg-[var(--color-app-surface-3)] text-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground" />
      Ngừng bán
    </Badge>
  )
}

export function ProductFeaturedBadge() {
  return (
    <Badge className="gap-1 border-[var(--color-app-primary)] bg-transparent text-[var(--color-app-primary-ink)]">
      <Star className="size-3" /> Nổi bật
    </Badge>
  )
}
