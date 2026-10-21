"use client"

import { useState } from "react"
import { ExternalLink, RefreshCw, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { StatusPill, type ConnectionTone } from "@/components/ui/connection-row"
import { cn } from "@/lib/utils"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { getApiErrorMessage } from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac/use-permissions"
import { isPostEditable, useSocialMutations, useSocialPosts, useSyncPublishedPosts, type SocialPost, type SocialTarget } from "@/hooks/use-social"
import { SocialPostEdit } from "./social-post-edit"
import { CalendarClock } from "lucide-react"
import { SocialMetricsLine } from "./social-metrics"
import { NetworkMark } from "./social-network-mark"
import { formatDateTime } from "@/lib/format"

const TONE: Record<"soft" | "success" | "destructive" | "secondary" | "outline", ConnectionTone> = {
  soft: "info", success: "connected", destructive: "danger", secondary: "off", outline: "off",
}

export const POST_STATUS: Record<SocialPost["status"], { label: string; variant: "soft" | "success" | "destructive" | "secondary" | "outline" }> = {
  scheduled: { label: "Đã hẹn giờ", variant: "soft" },
  publishing: { label: "Đang đăng", variant: "soft" },
  published: { label: "Đã đăng", variant: "success" },
  partial: { label: "Đăng một phần", variant: "destructive" },
  failed: { label: "Lỗi", variant: "destructive" },
  cancelled: { label: "Đã huỷ", variant: "secondary" },
}

const TARGET_STATUS: Record<SocialTarget["status"], { label: string; variant: "soft" | "success" | "destructive" | "secondary" }> = {
  queued: { label: "Chờ đăng", variant: "soft" },
  publishing: { label: "Đang đăng", variant: "soft" },
  published: { label: "Đã đăng", variant: "success" },
  failed: { label: "Lỗi", variant: "destructive" },
  cancelled: { label: "Đã huỷ", variant: "secondary" },
}

/** Bài đã bị xoá thẳng trên mạng (Trinity phát hiện khi kiểm/lấy số). */
const REMOVED_STATUS = { label: "Đã xoá trên mạng", variant: "secondary" } as const

/** Mạng không cho gỡ bài qua API — người dùng gỡ trong ứng dụng của mạng. */
const APP_ONLY_REMOVE: Partial<Record<SocialTarget["network"], string>> = { tiktok: "TikTok", instagram: "Instagram" }

const fmt = (iso: string) => formatDateTime(iso)

/** Bài đã đăng: mới nhất trước, trạng thái từng kênh, Huỷ / Thử lại / Gỡ khỏi mạng. */
export function SocialPostsList({ highlight, onCompose }: { highlight?: number; onCompose?: () => void }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useSocialPosts()
  useSyncPublishedPosts(Boolean(data?.data.some((p) => p.targets.some((t) => t.status === "published"))))
  const m = useSocialMutations()
  const { can } = usePermissions()
  const [removing, setRemoving] = useState<SocialTarget | null>(null)
  const [editing, setEditing] = useState<SocialPost | null>(null)

  const run = (p: Promise<unknown>, ok: string): Promise<boolean> =>
    p.then(() => (toast.success(ok), true)).catch((err) => (toast.error(getApiErrorMessage(err, "Không thực hiện được")), false))

  if (isLoading) return <LoadingBlock count={4} label="Đang tải danh sách bài…" />
  if (isError && !data) return <ErrorState title="Không tải được danh sách bài" error={error} onRetry={() => void refetch()} retrying={isFetching} />
  if (!data?.data.length) return <EmptyState icon={CalendarClock} title="Chưa có bài nào" message="Viết một lần, đăng cùng lúc lên mọi kênh đã liên kết." action={onCompose ? <Button variant="outline" onClick={onCompose}>Soạn bài đầu tiên</Button> : undefined} />

  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/8 shadow-[var(--shadow-card)]">
      {data.data.map((p) => {
        const published = p.targets.filter((t) => t.status === "published")
        // Mọi kênh đã đăng đều bị xoá thẳng trên mạng ⇒ bài không còn ở đâu nữa.
        const s = published.length > 0 && published.every((t) => t.metrics?.removed) && p.status === "published" ? REMOVED_STATUS : POST_STATUS[p.status]
        const cancellable = p.targets.some((t) => t.status === "queued" || t.status === "failed")
        const live = published.some((t) => !t.metrics?.removed)
        const editable = isPostEditable(p)
        return (
          <li key={p.id} id={`social-post-${p.id}`} className={cn("flex flex-col gap-2.5 px-4 py-3.5 sm:px-5", p.id === highlight && "bg-primary/[0.05] ring-2 ring-inset ring-primary/30")}>
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="line-clamp-2 whitespace-pre-wrap text-sm font-medium text-foreground">{p.content || "(Không có chữ)"}</p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                  <StatusPill tone={TONE[s.variant]}>{s.label}</StatusPill>
                  <span>{p.scheduled_at ? `Hẹn ${fmt(p.scheduled_at)}` : `Tạo ${fmt(p.created_at)}`}</span>
                  {p.source !== "web" && <span>· qua AI</span>}
                  {p.media.length > 0 && <span>· {p.media.length} tệp</span>}
                </div>
              </div>
              {(live || cancellable) && (
                <div className="flex shrink-0 gap-1.5">
                  {editable && (
                    <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                      Sửa
                    </Button>
                  )}
                  {live && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={m.refreshMetrics.isPending}
                      title="Lấy ngay lượt xem, cảm xúc, bình luận, chia sẻ (tự cập nhật mỗi 1–6 giờ)"
                      onClick={() => run(m.refreshMetrics.mutateAsync(p.id), "Đã cập nhật số liệu.")}
                    >
                      <RefreshCw className={m.refreshMetrics.isPending && m.refreshMetrics.variables === p.id ? "size-3.5 animate-spin" : "size-3.5"} /> Cập nhật số
                    </Button>
                  )}
                  {cancellable && (
                    <Button size="sm" variant="outline" disabled={m.cancel.isPending} onClick={() => run(m.cancel.mutateAsync(p.id), "Đã huỷ các kênh chưa đăng.")}>
                      Huỷ
                    </Button>
                  )}
                </div>
              )}
            </div>
            <ul className="flex flex-col gap-1.5">
              {p.targets.map((t) => {
                const gone = t.status === "published" && Boolean(t.metrics?.removed)
                const ts = gone ? REMOVED_STATUS : TARGET_STATUS[t.status]
                return (
                  <li key={t.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                    <NetworkMark network={t.network} size="sm" />
                    <span className="font-medium text-foreground">{t.account_name ?? `#${t.account_id}`}</span>
                    <StatusPill tone={TONE[ts.variant]}>{ts.label}</StatusPill>
                    {t.url && !gone && (
                      <a href={t.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                        Xem bài <ExternalLink className="size-3" />
                      </a>
                    )}
                    {t.status === "published" && t.metrics && <SocialMetricsLine metrics={t.metrics} network={t.network} />}
                    {t.status === "failed" ? (
                      // Khoảnh khắc hỏng: nói rõ kênh nào không đăng được + vì sao; nút "Đăng lại" ngay bên cạnh.
                      <span role="alert" className="w-full pl-6 text-xs text-destructive">
                        Không đăng được lên {t.account_name ?? "kênh này"}{t.last_error ? `: ${t.last_error}` : "."}
                      </span>
                    ) : t.last_error && <span className={cn("w-full pl-6 text-xs", t.status === "cancelled" ? "text-muted-foreground" : t.status === "published" ? "text-[var(--color-app-tag-amber-ink)]" : "text-destructive")}>{t.last_error}</span>}
                    <span className="ml-auto flex gap-1">
                      {t.status === "failed" && (
                        <Button size="sm" variant="outline" disabled={m.retry.isPending} onClick={() => run(m.retry.mutateAsync(t.id), "Đã đưa vào hàng đăng lại.")}>
                          <RotateCcw className="size-3.5" /> Đăng lại
                        </Button>
                      )}
                      {t.status === "published" && !gone && APP_ONLY_REMOVE[t.network] && <span className="text-xs text-muted-foreground">Gỡ trong ứng dụng {APP_ONLY_REMOVE[t.network]}</span>}
                      {t.status === "published" && !gone && !APP_ONLY_REMOVE[t.network] && can("social.manage") && (
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(t)}>
                          <Trash2 className="size-3.5" /> Gỡ khỏi mạng
                        </Button>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          </li>
        )
      })}
      </ul>
      {editing && <SocialPostEdit post={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Gỡ bài khỏi mạng xã hội?"
        description={<>Bài trên <b>{removing?.account_name}</b> sẽ bị xoá trên mạng xã hội. Không hoàn tác được.</>}
        confirmLabel="Gỡ bài"
        pending={m.removeRemote.isPending}
        onConfirm={async () => {
          // Lỗi thì giữ hộp mở để người dùng đọc thông báo và thử lại.
          if (removing && (await run(m.removeRemote.mutateAsync(removing.id), "Đã gỡ bài khỏi mạng."))) setRemoving(null)
        }}
      />
    </div>
  )
}
