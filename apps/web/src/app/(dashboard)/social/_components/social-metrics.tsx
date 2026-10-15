import { Eye, MessageCircle, Share2, ThumbsUp, Trash2 } from "lucide-react"
import type { SocialMetrics, SocialNetwork } from "@/hooks/use-social"

const num = (n: number) => new Intl.NumberFormat("vi-VN").format(n)

/** Nhãn số theo mạng: Facebook "cảm xúc", YouTube "thích"; YouTube không có số chia sẻ. */
export function metricItems(m: SocialMetrics, network: SocialNetwork) {
  const items: Array<{ key: string; icon: typeof Eye; value: number; label: string }> = []
  if (m.views !== null) items.push({ key: "views", icon: Eye, value: m.views, label: "lượt xem" })
  if (m.reactions !== null) items.push({ key: "reactions", icon: ThumbsUp, value: m.reactions, label: network === "facebook" ? "cảm xúc" : "thích" })
  if (m.comments !== null) items.push({ key: "comments", icon: MessageCircle, value: m.comments, label: "bình luận" })
  if (m.shares !== null && network !== "youtube") items.push({ key: "shares", icon: Share2, value: m.shares, label: "chia sẻ" })
  return items
}

/** Một dòng số của bài trên một kênh. */
export function SocialMetricsLine({ metrics, network }: { metrics: SocialMetrics; network: SocialNetwork }) {
  const items = metricItems(metrics, network)
  if (!items.length && !metrics.removed) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="social-metrics">
      {metrics.removed && (
        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400" title="Bài không còn trên kênh; số (nếu có) là lần lấy cuối.">
          <Trash2 className="size-3.5" aria-hidden />
          Bài đã bị xoá trên kênh
        </span>
      )}
      {items.map(({ key, icon: Icon, value, label }) => (
        <span key={key} className="inline-flex items-center gap-1 tabular-nums" title={label}>
          <Icon className="size-3.5" aria-hidden />
          {num(value)} <span className="sr-only sm:not-sr-only">{label}</span>
        </span>
      ))}
    </span>
  )
}

export { num as formatCount }
