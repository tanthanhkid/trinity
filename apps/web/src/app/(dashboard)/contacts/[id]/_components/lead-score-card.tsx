"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { RefreshCcw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import apiClient from "@/lib/api-client"
import { formatDate } from "@/lib/format"
import { LeadScoreBadge, type LeadLabel } from "@/components/lead-score-badge"

export interface LeadReason {
  key: string
  label: string
  points: number
  max: number
}

interface LeadScoreCardProps {
  contactId: string
  score: number | null | undefined
  label: LeadLabel | null | undefined
  reasons: LeadReason[] | null | undefined
  scoredAt: string | null | undefined
}

/** Thẻ "Điểm lead" ở chi tiết khách: điểm, nhãn và vì sao ra điểm đó. Chưa chấm → không hiện. */
export function LeadScoreCard({ contactId, score, label, reasons, scoredAt }: LeadScoreCardProps) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  if (score === null || score === undefined) return null

  const recompute = async () => {
    setBusy(true)
    try {
      await apiClient.post(`/lead-scoring/contacts/${contactId}/recompute`)
      await qc.invalidateQueries({ queryKey: ["contact", contactId] })
      toast.success("Đã chấm lại điểm")
    } catch {
      toast.error("Không chấm lại được điểm lead")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="rounded-[var(--radius)] border border-[var(--border)] shadow-[var(--shadow-card)] ring-0" data-testid="lead-score-card">
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex shrink-0 flex-col items-start gap-1">
          <span className="text-sm font-medium text-muted-foreground">Điểm lead</span>
          <span className="text-4xl font-semibold tabular-nums leading-none">{score}<span className="text-base font-normal text-muted-foreground">/100</span></span>
          <LeadScoreBadge score={score} label={label} />
        </div>
        <div className="min-w-0 max-w-xl flex-1 space-y-1.5">
          {(reasons ?? []).map((r) => (
            <div key={r.key} className="grid grid-cols-[minmax(0,160px)_1fr_56px] items-center gap-2 text-sm">
              <span className="truncate text-muted-foreground">{r.label}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-[var(--color-app-primary-ink)]" style={{ width: `${r.max > 0 ? Math.min(100, (r.points / r.max) * 100) : 0}%` }} />
              </div>
              <span className="text-right tabular-nums">{r.points}/{r.max}</span>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1 text-sm text-muted-foreground">
            <span>{scoredAt ? `Chấm lúc ${formatDate(scoredAt)}` : ""}</span>
            <Button variant="ghost" size="sm" className="gap-1.5 text-sm" onClick={recompute} disabled={busy}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Chấm lại
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
