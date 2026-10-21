"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { AlertTriangle, CheckCircle2, Loader2, MessagesSquare, PauseCircle, Plus, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Switch } from "@/components/ui/switch"
import { usePermissions } from "@/lib/rbac"
import { useAuthStore } from "@/store/auth"
import { FacebookChatLinks } from "./facebook-chat-links"
import { FacebookFlows } from "./facebook-flows"
import { FacebookBroadcasts } from "./facebook-broadcasts"
import { FacebookComments } from "./facebook-comments"
import { OptionSelect } from "./option-select"
import { TOKEN_STATUS_LABELS, useFacebookPageMutations, useFacebookPages, useFacebookStatus, type FacebookPageView } from "./use-facebook"
import { useAssignableUsers, useContactSourceOptions } from "./use-webhooks"
import { apiErrorMessage, type SimpleOption } from "./webhook-types"

const POSTING_LABELS = { on: "đã nối", removed: "đã gỡ", null: "chưa nối" } as const

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("vi-VN") : null)

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex flex-wrap gap-x-2 text-xs"><span className="text-muted-foreground">{k}</span><code className="break-all rounded bg-muted px-1">{v}</code></div>
}

function SetupHelp({ s }: { s: NonNullable<ReturnType<typeof useFacebookStatus>["data"]> }) {
  const missing = [
    !s.app_id_set && "FACEBOOK_APP_ID",
    !s.app_secret_set && "FACEBOOK_APP_SECRET",
    !s.base_url_set && "INTEGRATIONS_PUBLIC_BASE_URL",
    !s.verify_token_set && "FACEBOOK_WEBHOOK_VERIFY_TOKEN",
    !s.secret_key_configured && "INTEGRATIONS_SECRET_KEY",
  ].filter(Boolean) as string[]
  return (
    <Card>
      <CardContent className="space-y-2 py-4 text-sm">
        {missing.length > 0 && (
          <p className="flex items-start gap-2 text-amber-700"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>Máy chủ chưa cấu hình: {missing.map((m) => <code key={m} className="mr-1 rounded bg-muted px-1">{m}</code>)}</span></p>
        )}
        <p className="text-xs text-muted-foreground">Trong Meta for Developers (ứng dụng Facebook của công ty), khai các giá trị sau:</p>
        {s.webhook_url && <Row k="Callback URL của Webhooks (Page):" v={s.webhook_url} />}
        {s.oauth_redirect_uri && <Row k="Valid OAuth Redirect URI:" v={s.oauth_redirect_uri} />}
        <p className="text-xs text-muted-foreground">Đăng ký trường webhook <code>messages</code>, <code>messaging_postbacks</code>, <code>messaging_referrals</code> (link/QR mở chat), <code>leadgen</code>{s.comment_automation && <>, <code>feed</code></>}. Quyền cần: <code>{s.scopes.join(", ")}</code> (chế độ Live cần Meta duyệt App Review).</p>
      </CardContent>
    </Card>
  )
}

function PageCard({ p, assignees, sources, canTransfer }: { p: FacebookPageView; assignees: SimpleOption[]; sources: SimpleOption[]; canTransfer: boolean }) {
  const m = useFacebookPageMutations()
  const [confirm, setConfirm] = useState(false)
  const opts = (l: SimpleOption[]) => l.map((o) => ({ value: String(o.id), label: o.label }))
  const bad = p.token_status === "invalid" || p.token_status === "expired"
  const patch = (body: { default_assignee_id?: number; contact_source_id?: number; is_active?: boolean }) =>
    m.update.mutate({ id: p.id, ...body }, { onSuccess: () => toast.success("Đã lưu"), onError: (e) => toast.error(apiErrorMessage(e, "Không lưu được")) })
  return (
    <Card className={p.is_active ? undefined : "opacity-75"}>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate font-medium"><MessagesSquare className="size-4 shrink-0 text-blue-600" />{p.name}</p>
            <p className="text-xs text-muted-foreground">ID {p.page_id}</p>
          </div>
          <Switch checked={p.is_active} disabled={p.disconnected} onCheckedChange={(v) => patch({ is_active: v })} aria-label="Bật/tắt nhận tin của Fanpage" />
        </div>
        <p className="text-xs text-muted-foreground" data-testid="fb-page-posting">Đăng bài: {POSTING_LABELS[p.posting ?? "null"]}</p>
        {/* Page đã tắt: không nhận tin/lead nữa, dù token còn hạn — không hiện như đang kết nối bình thường. */}
        {p.disconnected ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="fb-page-disconnected">
            <PauseCircle className="size-3.5" />Đã ngắt — kết nối lại để bật
          </p>
        ) : !p.is_active ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="fb-page-off">
            <PauseCircle className="size-3.5" />Đã tắt: không nhận tin nhắn, bình luận và lead từ Fanpage này. Bật công tắc để nhận lại.
          </p>
        ) : (
        <p className={bad ? "flex items-center gap-1.5 text-xs text-red-600" : "flex items-center gap-1.5 text-xs text-muted-foreground"}>
          {bad ? <ShieldAlert className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
          {TOKEN_STATUS_LABELS[p.token_status]}
          {p.token_checked_at && ` · kiểm ${fmtDate(p.token_checked_at)}`}
          {p.data_access_expires_at && ` · quyền dữ liệu đến ${fmtDate(p.data_access_expires_at)}`}
        </p>
        )}
        {p.is_active && !p.subscribed && <p className="text-xs text-amber-700">Fanpage này chưa nhận tin nhắn về Trinity. Bấm &quot;Kiểm tra token&quot; để thử lại; vẫn báo thì bấm &quot;Kết nối Fanpage&quot; và cấp đủ quyền quản lý Page.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <OptionSelect label="Người nhận khách (Messenger, Lead Ads)" value={String(p.default_assignee_id)} options={opts(assignees)} onChange={(v) => patch({ default_assignee_id: Number(v) })} placeholder="Chọn sale" className="h-9 w-full max-sm:h-11" disabled={!canTransfer && assignees.length <= 1} />
          <OptionSelect label="Nguồn khách" value={String(p.contact_source_id)} options={opts(sources)} onChange={(v) => patch({ contact_source_id: Number(v) })} placeholder="Chọn nguồn" className="h-9 w-full max-sm:h-11" />
        </div>
        <div className="flex flex-wrap gap-2">
          {!p.disconnected && <Button variant="outline" size="sm" disabled={m.check.isPending} onClick={() => m.check.mutate(p.id, { onSuccess: (r) => toast.success(TOKEN_STATUS_LABELS[r.token_status]), onError: (e) => toast.error(apiErrorMessage(e, "Không kiểm tra được")) })} className="max-sm:h-11">
            {m.check.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}Kiểm tra token
          </Button>}
          {!p.disconnected && <Button variant="outline" size="sm" onClick={() => setConfirm(true)} className="max-sm:h-11 text-red-600">Ngắt kết nối</Button>}
        </div>
        <ConfirmDialog open={confirm} onOpenChange={setConfirm} pending={m.remove.isPending} title={`Ngắt kết nối "${p.name}"?`} description="Huỷ đăng ký webhook, xoá token và tắt Page này. Hội thoại và khách đã tạo được giữ nguyên. Nối lại Facebook sau này sẽ không tự bật lại Page đã ngắt." confirmLabel="Ngắt kết nối" onConfirm={() => m.remove.mutate(p.id, { onSuccess: () => { setConfirm(false); toast.success("Đã ngắt kết nối") }, onError: (e) => toast.error(apiErrorMessage(e, "Không ngắt được")) })} />
      </CardContent>
    </Card>
  )
}

/** Cài đặt > Kết nối & AI > Fanpage Facebook: kết nối Page, nhận lead, hộp thư Messenger, bình luận tự động, link/QR mở chat. */
export function FacebookPanel() {
  const params = useSearchParams()
  const { can } = usePermissions()
  const me = useAuthStore((s) => s.user)
  const status = useFacebookStatus(true)
  const pages = useFacebookPages(true)
  const m = useFacebookPageMutations()
  const canTransfer = can("contacts.transfer")
  const roster = useAssignableUsers(canTransfer)
  const sources = useContactSourceOptions(true)
  const xem = params.get("xem")
  const [view, setView] = useState<"pages" | "comments" | "links" | "flows" | "broadcasts">(
    xem === "binh-luan" ? "comments" : xem === "link-chat" ? "links" : xem === "kich-ban" ? "flows" : xem === "gui-hang-loat" ? "broadcasts" : "pages",
  )
  const livePages = (pages.data ?? []).filter((p) => !p.disconnected)
  const assignees: SimpleOption[] = canTransfer ? (roster.data ?? []) : me ? [{ id: me.id, label: me.full_name }] : []

  const result = params.get("facebook")
  useEffect(() => {
    if (result === "connected") {
      const n = Number(params.get("posting") ?? 0)
      toast.success(`Đã kết nối ${params.get("pages") ?? ""} Fanpage` + (n > 0 ? `, ${n} Page dùng được cả để đăng bài` : ""))
    }
    else if (result === "cancelled") toast.message("Đã huỷ kết nối Facebook")
    else if (result === "error") toast.error("Kết nối Facebook thất bại — kiểm tra cấu hình ứng dụng rồi thử lại")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  function connect() {
    m.connect.mutate(undefined, { onSuccess: (url) => { window.location.href = url }, onError: (e) => toast.error(apiErrorMessage(e, "Không mở được hộp thoại Facebook")) })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant={view === "pages" ? "soft" : "outline"} aria-pressed={view === "pages"} onClick={() => setView("pages")}>Fanpage</Button>
        {/* Tin Messenger đọc và trả lời ở menu Hộp thư (một chỗ cho mọi kênh). */}
        <Link href="/inbox" className={buttonVariants({ variant: "outline" })}>Hộp thư</Link>
        <Button variant={view === "comments" ? "soft" : "outline"} aria-pressed={view === "comments"} onClick={() => setView("comments")}>Bình luận tự động</Button>
        <Button variant={view === "links" ? "soft" : "outline"} aria-pressed={view === "links"} onClick={() => setView("links")}>Link / QR mở chat</Button>
        <Button variant={view === "flows" ? "soft" : "outline"} aria-pressed={view === "flows"} onClick={() => setView("flows")}>Kịch bản nhắn tin</Button>
        <Button variant={view === "broadcasts" ? "soft" : "outline"} aria-pressed={view === "broadcasts"} onClick={() => setView("broadcasts")}>Gửi hàng loạt</Button>
      </div>

      {view === "links" && <FacebookChatLinks pages={livePages} sources={sources.data ?? []} highlight={Number(params.get("link")) || undefined} />}
      {view === "flows" && <FacebookFlows pages={livePages} highlight={Number(params.get("kich-ban")) || undefined} />}
      {view === "broadcasts" && <FacebookBroadcasts pages={livePages} sources={sources.data ?? []} highlight={Number(params.get("luot")) || undefined} />}
      {view === "comments" && <FacebookComments pages={livePages} enabled={!!status.data?.comment_automation} />}

      {view === "pages" && (
        <>
          <p className="text-sm text-muted-foreground">Kết nối Fanpage để nhận và trả lời tin Messenger ngay trong CRM. Mỗi người nhắn vào Page thành một khách hàng, tin nhắn ghi vào lịch sử chăm sóc (tin có SĐT trùng khách cũ thì ghi vào khách đó). Khách gửi form Lead Ads cũng tự thành khách hàng.</p>
          {status.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang kiểm tra cấu hình...</div>}
          {status.isError && <ErrorState compact title="Không đọc được cấu hình Facebook" error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />}
          {status.data && <SetupHelp s={status.data} />}
          <Button onClick={connect} disabled={!status.data?.configured || !status.data.secret_key_configured || m.connect.isPending} className="max-sm:h-11">
            {m.connect.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Plus className="mr-1 size-4" />}Kết nối Fanpage
          </Button>
          {pages.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>}
          {pages.isError && <ErrorState compact title="Không tải được danh sách Fanpage" error={pages.error} onRetry={() => void pages.refetch()} retrying={pages.isFetching} />}
          {pages.isSuccess && pages.data.length === 0 && <EmptyState icon={MessagesSquare} message='Chưa kết nối Fanpage nào. Bấm "Kết nối Fanpage" rồi chọn Page trong hộp thoại Facebook.' />}
          <div className="grid gap-3 lg:grid-cols-2">
            {pages.data?.map((p) => <PageCard key={p.id} p={p} assignees={assignees} sources={sources.data ?? []} canTransfer={canTransfer} />)}
          </div>
        </>
      )}
    </div>
  )
}
