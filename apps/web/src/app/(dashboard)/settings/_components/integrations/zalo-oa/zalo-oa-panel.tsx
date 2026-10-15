"use client"

import { useState } from "react"
import { AlertTriangle, CheckCircle2, Loader2, PlugZap } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { usePermissions } from "@/lib/rbac"
import { apiErrorMessage } from "../webhook-types"
import { useConnectZaloOa, useDisconnectZaloOa, useSendZns, useZaloOaStatus } from "./use-zalo-oa"

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("vi-VN") : "—")

function Missing({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="flex items-start gap-2 text-sm text-amber-700">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>Máy chủ chưa đặt: {items.map((i) => <code key={i} className="mr-1 rounded bg-muted px-1">{i}</code>)}</span>
    </div>
  )
}

function ZnsTest() {
  const send = useSendZns()
  const [phone, setPhone] = useState("")
  const [tpl, setTpl] = useState("")
  const [json, setJson] = useState('{"customer_name":"Khách"}')
  const submit = () => {
    let data: Record<string, string>
    try { data = JSON.parse(json) } catch { toast.error("Dữ liệu mẫu phải là JSON hợp lệ"); return }
    send.mutate({ phone, template_id: tpl, template_data: data }, {
      onSuccess: () => toast.success("Đã gửi ZNS"),
      onError: (e) => toast.error(apiErrorMessage(e, "Gửi ZNS thất bại")),
    })
  }
  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <h3 className="font-medium">Gửi thử ZNS</h3>
        <p className="text-sm text-muted-foreground">Dùng mẫu ZNS đã được Zalo duyệt. Điền dữ liệu các tham số của mẫu dạng JSON.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input placeholder="Số điện thoại (0912…)" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input placeholder="Mã mẫu ZNS (template_id)" value={tpl} onChange={(e) => setTpl(e.target.value)} />
        </div>
        <Input className="font-mono" value={json} onChange={(e) => setJson(e.target.value)} />
        <Button disabled={!phone || !tpl || send.isPending} onClick={submit}>
          {send.isPending && <Loader2 className="size-4 animate-spin" />} Gửi ZNS
        </Button>
      </CardContent>
    </Card>
  )
}

/** Cài đặt > Kết nối & AI > Zalo OA: kết nối/ngắt OA chính thức, trạng thái token, gửi thử ZNS. */
export function ZaloOaPanel() {
  const { can } = usePermissions()
  const status = useZaloOaStatus()
  const connect = useConnectZaloOa()
  const disconnect = useDisconnectZaloOa()
  const [confirm, setConfirm] = useState(false)
  const canManage = can("integrations.webhooks")
  const flash = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("zalo_oa")

  if (status.isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>
  if (status.isError || !status.data) return <Card><CardContent className="py-4 text-sm text-red-600">Không đọc được trạng thái Zalo OA (hoặc tính năng đang tắt).</CardContent></Card>
  const s = status.data
  const missing = [
    ...(s.configured ? [] : ["ZALO_OA_APP_ID", "ZALO_OA_APP_SECRET", "ZALO_OA_REDIRECT_URI"]),
    ...(s.webhook_secret_configured ? [] : ["ZALO_WEBHOOK_SECRET"]),
    ...(s.secret_key_configured ? [] : ["INTEGRATIONS_SECRET_KEY"]),
  ]
  const badge = s.status === "active" ? { text: "Đã kết nối", cls: "text-green-700" } : s.status === "needs_reauth" ? { text: "Cần kết nối lại", cls: "text-amber-700" } : { text: "Chưa kết nối", cls: "text-muted-foreground" }

  return (
    <div className="space-y-4">
      {flash === "connected" && <p className="flex items-center gap-2 text-sm text-green-700"><CheckCircle2 className="size-4" /> Đã kết nối Zalo OA.</p>}
      {flash === "error" && <p className="flex items-center gap-2 text-sm text-red-600"><AlertTriangle className="size-4" /> Kết nối Zalo OA không thành công, hãy thử lại.</p>}
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-medium"><PlugZap className="size-4" /> Zalo Official Account</h3>
            <span className={`text-sm font-medium ${badge.cls}`}>{badge.text}</span>
          </div>
          <Missing items={missing} />
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">OA id</dt><dd>{s.oa_id ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">Access token hết hạn</dt><dd>{fmt(s.access_expires_at)} (tự làm mới)</dd></div>
            <div><dt className="text-muted-foreground">Refresh token hết hạn</dt><dd>{fmt(s.refresh_expires_at)}</dd></div>
            {s.last_error && <div><dt className="text-muted-foreground">Lỗi gần nhất</dt><dd className="text-red-600">{s.last_error}</dd></div>}
          </dl>
          <div className="space-y-1 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            <div>Khai trên Zalo for Developers — Callback URL: <code>{s.redirect_uri ?? "(chưa đặt ZALO_OA_REDIRECT_URI)"}</code></div>
            <div>Webhook URL: <code>{`${typeof window === "undefined" ? "" : window.location.origin}${s.webhook_path}`}</code></div>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!s.configured || !s.secret_key_configured || connect.isPending}
                onClick={() => connect.mutate(undefined, { onSuccess: (url) => { window.location.href = url }, onError: (e) => toast.error(apiErrorMessage(e, "Không bắt đầu được kết nối")) })}
              >
                {connect.isPending && <Loader2 className="size-4 animate-spin" />} {s.status === "active" ? "Kết nối lại" : "Kết nối Zalo OA"}
              </Button>
              {s.status !== "disconnected" && <Button variant="outline" onClick={() => setConfirm(true)}>Ngắt kết nối</Button>}
            </div>
          )}
        </CardContent>
      </Card>
      {canManage && s.connected && <ZnsTest />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Ngắt kết nối Zalo OA?"
        description="Token đã lưu sẽ bị xoá; tin nhắn đã nhận vẫn được giữ. Bạn có thể kết nối lại bất cứ lúc nào."
        confirmLabel="Ngắt kết nối"
        onConfirm={() => disconnect.mutate(undefined, { onSuccess: () => setConfirm(false), onError: (e) => toast.error(apiErrorMessage(e, "Không ngắt được")) })}
      />
    </div>
  )
}
