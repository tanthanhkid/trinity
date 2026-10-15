import { Badge } from "@/components/ui/badge"

export type LeadLabel = "hot" | "warm" | "cold"

export const LEAD_LABEL_TEXT: Record<LeadLabel, string> = { hot: "Nóng", warm: "Ấm", cold: "Lạnh" }

const LEAD_LABEL_CLASS: Record<LeadLabel, string> = {
  hot: "bg-red-50 text-red-700",
  warm: "bg-amber-50 text-amber-700",
  cold: "bg-sky-50 text-sky-700",
}

/** Huy hiệu điểm lead: "82 · Nóng". Chưa chấm → dấu gạch ngang. */
export function LeadScoreBadge({ score, label }: { score?: number | null; label?: LeadLabel | null }) {
  if (score === null || score === undefined || !label) {
    return <span className="block text-center text-muted-foreground text-sm" title="Chưa chấm điểm">—</span>
  }
  return (
    <Badge
      variant="secondary"
      className={`text-sm tabular-nums truncate max-w-full ${LEAD_LABEL_CLASS[label]}`}
      title={`Điểm ${score}/100 — ${LEAD_LABEL_TEXT[label]}`}
    >
      {score} · {LEAD_LABEL_TEXT[label]}
    </Badge>
  )
}
