"use client"

import { useState } from "react"
import { BarChart3, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { HomeStats } from "@/app/(dashboard)/dashboard/_components/home-stats"
import { useSocialStats } from "@/hooks/use-social"
import { SocialMetricsLine, formatCount } from "./social-metrics"
import { formatCount as formatCountUnit, formatDateTime } from "@/lib/format"

const RANGES = [7, 30, 90] as const
const NETWORK_LABEL = { facebook: "Facebook", instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok", google_business: "Google Business" } as const
const fmt = (iso: string) => formatDateTime(iso)

/** Thống kê bài đã đăng: tổng số, theo kênh, bài tương tác cao nhất. Số tự cập nhật mỗi 1–6 giờ. */
export function SocialStats({ onOpen }: { onOpen: (postId: number) => void }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30)
  const { data, isLoading, isError, error, refetch, isFetching } = useSocialStats(days)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((d) => (
          <Button key={d} size="sm" variant={d === days ? "default" : "outline"} onClick={() => setDays(d)}>
            {d} ngày
          </Button>
        ))}
        {data?.updated_at && <span className="ml-auto text-xs text-muted-foreground">Số cập nhật lúc {fmt(data.updated_at)}</span>}
      </div>

      {isError && !data && <ErrorState title="Không tải được thống kê" error={error} onRetry={() => void refetch()} retrying={isFetching} />}
      {/* Số cũ vẫn hiện nhưng nói rõ là chưa cập nhật được (không trình bày số cũ như số mới). */}
      {isError && data && <ErrorState compact title="Không cập nhật được thống kê — đang hiện số lần trước" error={error} onRetry={() => void refetch()} retrying={isFetching} />}
      {isLoading && <LoadingBlock variant="cards" count={2} label="Đang tải thống kê…" />}
      {data && data.totals.published === 0 && <EmptyState icon={BarChart3} message={`Chưa có bài nào lên mạng trong ${days} ngày qua.`} />}

      {data && data.totals.published > 0 && (
        <>
          <HomeStats
            items={[
              { key: "posts", label: "Bài đã đăng", value: formatCount(data.totals.posts), note: `${formatCount(data.totals.published)} lượt lên kênh` },
              { key: "views", label: "Lượt xem", value: data.totals.views === null ? "—" : formatCount(data.totals.views), note: data.totals.views === null ? "Kênh chưa cung cấp" : "Video Facebook, YouTube" },
              { key: "reactions", label: "Cảm xúc / thích", value: formatCount(data.totals.reactions) },
              { key: "comments", label: "Bình luận · chia sẻ", value: `${formatCount(data.totals.comments)} · ${formatCount(data.totals.shares)}` },
            ]}
          />

          <Card>
            <CardContent className="p-4">
              <h3 className="mb-2 text-sm font-semibold">Theo kênh</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1.5 font-medium">Kênh</th>
                      <th className="py-1.5 text-right font-medium">Bài</th>
                      <th className="py-1.5 text-right font-medium">Lượt xem</th>
                      <th className="py-1.5 text-right font-medium">Cảm xúc / thích</th>
                      <th className="py-1.5 text-right font-medium">Bình luận</th>
                      <th className="py-1.5 text-right font-medium">Chia sẻ</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {data.by_account.map((a) => {
                      // Kênh chưa lấy được số lần nào: "—" thay vì 0 cho khỏi hiểu nhầm là không ai tương tác.
                      const n = (v: number | null, hide = false) => (hide || v === null || a.with_metrics === 0 ? "—" : formatCount(v))
                      return (
                        <tr key={a.account_id} className="border-t">
                          <td className="py-1.5">
                            {a.account_name ?? `#${a.account_id}`} <span className="text-xs text-muted-foreground">· {NETWORK_LABEL[a.network]}</span>
                            {a.with_metrics === 0 && <span className="block text-xs text-muted-foreground">Chưa lấy được số</span>}
                          </td>
                          <td className="py-1.5 text-right">{formatCount(a.published)}</td>
                          <td className="py-1.5 text-right">{n(a.views)}</td>
                          <td className="py-1.5 text-right">{n(a.reactions)}</td>
                          <td className="py-1.5 text-right">{n(a.comments)}</td>
                          <td className="py-1.5 text-right">{n(a.shares, a.network === "youtube")}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-2 p-4">
              <h3 className="text-sm font-semibold">Bài tương tác cao nhất</h3>
              {data.top.length === 0 && <p className="text-sm text-muted-foreground">Chưa lấy được số của bài nào — số sẽ có trong vòng một giờ sau khi bài lên mạng.</p>}
              <ol className="space-y-2">
                {data.top.map((t, i) => (
                  <li key={t.target_id} className="flex gap-3 border-t pt-2 first:border-t-0 first:pt-0">
                    <span className="w-5 shrink-0 text-right text-sm font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <button type="button" onClick={() => onOpen(t.post_id)} className="line-clamp-2 text-left text-sm hover:underline">
                        {t.content || "(không có chữ)"}
                      </button>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {t.account_name ?? NETWORK_LABEL[t.network]}
                          {t.published_at && ` · ${fmt(t.published_at)}`}
                        </span>
                        {t.metrics && <SocialMetricsLine metrics={t.metrics} network={t.network} />}
                        {t.url && (
                          <a href={t.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                            Xem bài <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
              {data.without_metrics > 0 && <p className="text-xs text-muted-foreground">{formatCountUnit(data.without_metrics, "lượt đăng")} chưa có số (vừa đăng hoặc kênh chưa cho lấy).</p>}
              {(data.removed ?? 0) > 0 && <p className="text-xs text-muted-foreground">{formatCountUnit(data.removed ?? 0, "lượt đăng")} đã bị xoá trên kênh (giữ số lần lấy cuối, nếu có).</p>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
