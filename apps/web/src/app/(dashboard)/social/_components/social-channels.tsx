"use client"

import { useState } from "react"
import { Link2, Loader2, Unlink } from "lucide-react"
import { toast } from "sonner"
import { StatusPill } from "@/components/ui/connection-row"
import { NetworkMark } from "./social-network-mark"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { getApiErrorMessage } from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac/use-permissions"
import { useSocialAccounts, useSocialMutations, useSocialNetworks, type SocialAccount, type SocialNetwork } from "@/hooks/use-social"

/** Kênh: liên kết từng mạng (OAuth), danh sách kênh đã liên kết, gỡ kênh. */
export function SocialChannels() {
  const { data: networks = [], isLoading } = useSocialNetworks()
  const { data: accounts = [] } = useSocialAccounts(true, true)
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

  if (isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải…</div>

  return (
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
                      {a.removed ? <StatusPill tone="soon">Đã gỡ</StatusPill> : a.status === "active" ? <StatusPill tone="connected">Hoạt động</StatusPill> : <StatusPill tone="danger">Cần liên kết lại</StatusPill>}
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
          if (removing) await m.disconnect.mutateAsync(removing.id).then(() => toast.success("Đã gỡ kênh.")).catch((err) => toast.error(getApiErrorMessage(err, "Không gỡ được kênh")))
          setRemoving(null)
        }}
      />
    </div>
  )
}
