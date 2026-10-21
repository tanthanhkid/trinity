"use client"

import { useState } from "react"
import { Link2, Unlink } from "lucide-react"
import { toast } from "sonner"
import { StatusPill } from "@/components/ui/connection-row"
import { NetworkMark } from "./social-network-mark"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { getApiErrorMessage } from "@/lib/api-client"
import { toastWithUndo } from "@/lib/undo"
import { ReconnectNotice, STATUS_LABEL } from "@/components/ui/status-tag"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { usePermissions } from "@/lib/rbac/use-permissions"
import { useSocialAccounts, useSocialMutations, useSocialNetworks, type SocialAccount, type SocialNetwork } from "@/hooks/use-social"

/** Kênh: liên kết từng mạng (OAuth), danh sách kênh đã liên kết, gỡ kênh. */
export function SocialChannels() {
  const networksQ = useSocialNetworks()
  const accountsQ = useSocialAccounts(true, true)
  const { data: networks = [], isLoading } = networksQ
  const { data: accounts = [] } = accountsQ
  const m = useSocialMutations()
  const { can } = usePermissions()
  const manage = can("social.manage")
  const [removing, setRemoving] = useState<SocialAccount | null>(null)

  const connect = (n: SocialNetwork) =>
    m.connect.mutate(n, {
      onSuccess: (url) => window.location.assign(url),
      onError: (err) => toast.error(getApiErrorMessage(err, "Không mở được trang liên kết")),
    })

  const enable = (a: SocialAccount) =>
    m.enable.mutate(a.id, {
      onSuccess: () => toast.success("Đã bật lại kênh."),
      onError: (err) => toast.error(getApiErrorMessage(err, "Không bật lại được kênh")),
    })

  if (isLoading) return <LoadingBlock variant="cards" count={2} label="Đang tải kênh…" />
  // Lỗi tải ⇒ nói rõ + Thử lại; KHÔNG hiện lưới trống (người dùng tưởng chưa liên kết kênh nào).
  // Đang có dữ liệu cũ mà tải lại nền lỗi ⇒ giữ lưới + nút quản lý, chỉ báo một dòng phía trên.
  const failed = networksQ.isError ? networksQ : accountsQ.isError ? accountsQ : null
  const retryAll = () => { void networksQ.refetch(); void accountsQ.refetch() }
  const refreshing = networksQ.isFetching || accountsQ.isFetching
  if (failed && !failed.data) {
    return (
      <ErrorState
        title="Không tải được danh sách kênh"
        error={failed.error}
        onRetry={retryAll}
        retrying={refreshing}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
    {failed && (
      <ErrorState compact title="Không cập nhật được danh sách kênh — đang hiện bản trước" error={failed.error} onRetry={retryAll} retrying={refreshing} />
    )}
    <div className="grid gap-3 md:grid-cols-2">
      {networks.map((n) => {
        const mine = accounts.filter((a) => a.network === n.network)
        const activeCount = mine.filter((a) => !a.removed).length
        return (
          <Card key={n.network}>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center gap-2">
                <NetworkMark network={n.network} />
                <p className="font-medium">{n.label}</p>
                {!n.supported && <StatusPill tone="soon">Sắp có</StatusPill>}
                {n.supported && manage && (
                  <Button size="sm" variant="outline" className="ml-auto" disabled={!n.configured || m.connect.isPending} onClick={() => connect(n.network)}>
                    <Link2 className="size-3.5" /> {activeCount ? "Liên kết thêm / lại" : "Liên kết"}
                  </Button>
                )}
              </div>
              {n.supported && !n.configured && (
                <p className="text-xs text-muted-foreground">
                  Máy chủ chưa cấu hình {n.label}: cần đặt {n.env.join(", ")}
                  {n.redirect_uri && <> và đăng ký URL chuyển hướng <code className="break-all">{n.redirect_uri}</code> trong ứng dụng của mạng</>}.
                </p>
              )}
              {mine.length > 0 && (
                <ul className="divide-y divide-border rounded-lg text-sm ring-1 ring-border">
                  {mine.map((a) => (
                    <li key={a.id} className={`flex min-h-11 items-center gap-2 px-3 py-1.5${a.removed ? " opacity-60" : ""}`} data-testid={a.removed ? "social-account-removed" : undefined}>
                      <span className="truncate">{a.name}</span>
                      {a.removed ? <StatusPill tone="soon">Đã gỡ</StatusPill> : a.status === "active" ? <StatusPill tone="connected">Hoạt động</StatusPill> : <StatusPill tone="warning">{STATUS_LABEL.reauth}</StatusPill>}
                      {a.network === "facebook" && (
                        <span className="text-xs text-muted-foreground">Nhận tin: {a.inbox === "on" ? "đã nối" : a.inbox === "off" ? "tắt" : "chưa nối"}</span>
                      )}
                      {manage && a.removed && (
                        <Button size="sm" variant="outline" className="ml-auto" disabled={m.enable.isPending} onClick={() => enable(a)}>
                          Bật lại
                        </Button>
                      )}
                      {manage && !a.removed && (
                        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setRemoving(a)} aria-label={`Gỡ ${a.name}`}>
                          <Unlink className="size-3.5" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {/* Kênh mất quyền: nói rõ + nút Kết nối lại ngay tại thẻ mạng (mở lại luồng liên kết của mạng đó). */}
              {mine
                .filter((a) => !a.removed && a.status !== "active")
                .map((a) => (
                  <ReconnectNotice
                    key={`reauth-${a.id}`}
                    channel={`${n.label} ${a.name}`}
                    reason="Quyền đăng bài đã hết hạn hoặc bị thu hồi — bài hẹn lên kênh này sẽ không đăng được."
                    onReconnect={manage && n.configured ? () => connect(n.network) : undefined}
                    reconnecting={m.connect.isPending}
                  />
                ))}
            </CardContent>
          </Card>
        )
      })}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Gỡ kênh?"
        description={<>Trinity xoá quyền đăng lên <b>{removing?.name}</b>. Bài chưa đăng xong trên kênh này bị huỷ; bài đã đăng vẫn còn trên mạng.</>}
        confirmLabel="Gỡ kênh"
        pending={m.disconnect.isPending}
        onConfirm={async () => {
          const a = removing
          if (a) {
            await m.disconnect
              .mutateAsync(a.id)
              // Gỡ nhầm ⇒ Hoàn tác = bật lại kênh (bài chưa đăng đã bị huỷ thì phải hẹn lại — nói thật trong câu báo).
              .then(() => toastWithUndo({
                message: `Đã gỡ kênh ${a.name}.`,
                onUndo: () => m.enable.mutate(a.id, {
                  onSuccess: () => toast.success(`Đã bật lại kênh ${a.name}. Bài chưa đăng lúc gỡ đã bị huỷ — hẹn lại nếu cần.`),
                  onError: (err) => toast.error(getApiErrorMessage(err, "Không bật lại được kênh")),
                }),
              }))
              .catch((err) => toast.error(getApiErrorMessage(err, "Không gỡ được kênh")))
          }
          setRemoving(null)
        }}
      />
    </div>
    </div>
  )
}
