"use client"

import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import apiClient from "@/lib/api-client"
import { Card, CardContent } from "@/components/ui/card"

interface PlanUsageSummary {
  plan: string
  plan_label: string
  max_users: number | null
  active_users: number
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100))
  const hot = limit !== null && pct >= 90
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className={hot ? "font-medium text-destructive" : "text-muted-foreground"}>
          {used.toLocaleString("vi-VN")} / {limit === null ? "không giới hạn" : limit.toLocaleString("vi-VN")}
        </span>
      </div>
      {limit !== null && (
        <div
          className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={label}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={`h-full rounded-full ${hot ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

/** Cài đặt > Tính năng: gói hiện tại + số người dùng. Gói không có hạn mức AI — Trinity không tự chạy AI. Chỉ admin (BE kiểm `settings.features`). */
export function SettingsPlanUsage() {
  const { data, isLoading, isError } = useQuery<PlanUsageSummary>({
    queryKey: ["settings", "usage"],
    queryFn: async () => (await apiClient.get<PlanUsageSummary>("/settings/usage")).data,
    staleTime: 30_000,
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Đang tải gói dịch vụ...
      </div>
    )
  }
  if (isError || !data?.plan) return null

  return (
    <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]" data-testid="plan-usage">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-sm text-muted-foreground">Gói dịch vụ</p>
            <p className="text-lg font-semibold">{data.plan_label}</p>
          </div>
        </div>
        <div className="space-y-3">
          <Meter label="Người dùng đang hoạt động" used={data.active_users} limit={data.max_users} />
        </div>
        <p className="text-xs text-muted-foreground">
          Gói do Trinity quản lý, quản trị viên chỉ xem. Muốn đổi gói, liên hệ Trinity. Tính năng ngoài gói sẽ không bật được ở bảng bên dưới.
          AI dùng qua trợ lý AI của bạn (ChatGPT, Claude, Gemini…) và tính theo gói AI của chính bạn.
        </p>
      </CardContent>
    </Card>
  )
}
