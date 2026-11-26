"use client"

import { Card, CardContent } from "@/components/ui/card"
import { useChannelGuard } from "@/hooks/use-channel-guard"

function Row({ label, used, limit }: { label: string; used: number | null; limit: number }) {
  const pct = used === null ? 0 : Math.min(100, Math.round((used / limit) * 100))
  const hot = used !== null && pct >= 90
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className={hot ? "font-medium text-destructive" : "text-muted-foreground"}>
          {used === null ? `tối đa ${limit.toLocaleString("vi-VN")}` : `${used.toLocaleString("vi-VN")} / ${limit.toLocaleString("vi-VN")}`}
        </span>
      </div>
      {used !== null && (
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full ${hot ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

/** Cài đặt > Tính năng: hạn mức gửi tin/đăng bài của gói. Chỉ hiện khi chạy nhiều công ty. */
export function SettingsChannelLimits() {
  const { data } = useChannelGuard()
  if (!data?.enforced) return null
  const { limits, usage } = data
  return (
    <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]" data-testid="channel-limits">
      <CardContent className="space-y-4 p-5">
        <div>
          <p className="text-sm text-muted-foreground">Hạn mức gửi tin và đăng bài</p>
          <p className="text-xs text-muted-foreground">Mọi công ty dùng chung kết nối Facebook/Zalo của Trinity nên mỗi gói có hạn mức riêng để không ai làm ảnh hưởng người khác.</p>
        </div>
        <div className="space-y-3">
          <Row label="Tin gửi hàng loạt hôm nay (Messenger, ZNS Zalo)" used={usage.bulk_messages_today} limit={limits.bulkMessagesPerDay} />
          <Row label="Bài đăng và hẹn giờ hôm nay" used={usage.posts_today} limit={limits.postsPerDay} />
          <Row label="Trả lời bình luận tự động giờ này" used={usage.auto_comment_replies_this_hour} limit={limits.autoCommentRepliesPerHour} />
          <Row label="Người nhận mỗi chiến dịch gửi hàng loạt" used={null} limit={limits.recipientsPerCampaign} />
        </div>
        {data.warnings.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
