"use client"

import { useEffect, useState } from "react"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { useSearchParams } from "next/navigation"
import { AlertTriangle, ChevronRight, Loader2, MessagesSquare, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { cn } from "@/lib/utils"
import { usePermissions } from "@/lib/rbac"
import { useAuthStore } from "@/store/auth"
import { FacebookChatLinks } from "./facebook-chat-links"
import { FacebookFlows } from "./facebook-flows"
import { FacebookBroadcasts } from "./facebook-broadcasts"
import { FacebookComments } from "./facebook-comments"
import { FacebookPageDesktop, FacebookPageMobile, useIsWide } from "./facebook-page-view"
import { STATE_LABEL, STATE_TONE, pageState } from "./facebook-page-state"
import { facebookResultMessage, goToFacebookDialog, useFacebookPageMutations, useFacebookPages, useFacebookStatus } from "./use-facebook"
import { useAssignableUsers, useContactSourceOptions } from "./use-webhooks"
import { apiErrorMessage, type SimpleOption } from "./webhook-types"

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex flex-wrap gap-x-2 text-xs"><span className="text-muted-foreground">{k}</span><code className="break-all rounded bg-muted px-1">{v}</code></div>
}

type FbStatus = NonNullable<ReturnType<typeof useFacebookStatus>["data"]>

/** Máy chủ đã đủ cấu hình để khách bấm Kết nối: không cần hiện app id, webhook hay quyền cho khách. */
export function facebookReady(s: FbStatus) {
  return s.configured && s.verify_token_set && s.secret_key_configured
}

function SetupHelp({ s, admin }: { s: FbStatus; admin: boolean }) {
  if (facebookReady(s)) return null
  // Khách (không phải quản trị) không cần thấy tên biến môi trường hay cách khai ứng dụng Meta.
  if (!admin) {
    return (
      <Card>
        <CardContent className="py-4 text-sm" data-testid="fb-not-ready">
          <p className="flex items-start gap-2 text-amber-700"><AlertTriangle className="mt-0.5 size-4 shrink-0" />Kết nối Facebook chưa sẵn sàng trên hệ thống này. Bạn liên hệ quản trị viên để được bật.</p>
        </CardContent>
      </Card>
    )
  }
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
        <p className="text-xs text-muted-foreground">Đăng ký trường webhook <code>messages</code>, <code>messaging_postbacks</code>, <code>messaging_referrals</code> (link/QR mở chat), <code>leadgen</code>{s.comment_automation && <>, <code>feed</code></>}. {s.login_for_business ? <>Quyền do cấu hình Facebook Login for Business quyết định (<code>FACEBOOK_LOGIN_CONFIG_ID</code>).</> : <>Quyền cần: <code>{s.scopes.join(", ")}</code>.</>} Chế độ Live cần Meta duyệt App Review.</p>
      </CardContent>
    </Card>
  )
}

/** Cài đặt > Kết nối & AI > Fanpage Facebook: kết nối Page, nhận lead, hộp thư Messenger, bình luận tự động, link/QR mở chat. */
export function FacebookPanel() {
  const params = useSearchParams()
  const { can } = usePermissions()
  const me = useAuthStore((s) => s.user)
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const status = useFacebookStatus(true)
  const pages = useFacebookPages(true)
  const m = useFacebookPageMutations()
  const canTransfer = can("contacts.transfer")
  const roster = useAssignableUsers(canTransfer)
  const sources = useContactSourceOptions(true)
  const xem = params.get("xem")
  const wide = useIsWide()
  const [selId, setSelId] = useState<number | null>(null)
  const [view, setView] = useState<"pages" | "comments" | "links" | "flows" | "broadcasts">(
    xem === "binh-luan" ? "comments" : xem === "link-chat" ? "links" : xem === "kich-ban" ? "flows" : xem === "gui-hang-loat" ? "broadcasts" : "pages",
  )
  const livePages = (pages.data ?? []).filter((p) => !p.disconnected)
  const assignees: SimpleOption[] = canTransfer ? (roster.data ?? []) : me ? [{ id: me.id, label: me.full_name }] : []

  const result = params.get("facebook")
  const reason = params.get("reason")
  useEffect(() => {
    if (result === "connected") {
      const n = Number(params.get("pages") ?? 0)
      const posting = Number(params.get("posting") ?? 0)
      const failed = Number(params.get("failed") ?? 0)
      toast.success(`Đã kết nối ${n} Page` + (posting > 0 ? `, ${posting} Page dùng được cả để đăng bài` : ""))
      if (failed > 0) toast.error(`${failed} Page chưa kết nối được (có thể đã thuộc công ty khác hoặc thiếu quyền). Bạn thử lại sau.`)
    } else {
      const m = facebookResultMessage(result, reason)
      if (m) (m.kind === "info" ? toast.message : toast.error)(m.text)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  function connect() {
    m.connect.mutate(undefined, { onSuccess: goToFacebookDialog, onError: (e) => toast.error(apiErrorMessage(e, "Không mở được hộp thoại Facebook")) })
  }

  const allPages = pages.data ?? []
  const selected = allPages.find((p) => p.id === selId) ?? allPages[0]
  const VIEWS: Array<{ key: typeof view; label: string }> = [
    { key: "pages", label: "Fanpage" },
    { key: "comments", label: "Bình luận tự động" },
    { key: "links", label: "Link / QR mở chat" },
    { key: "flows", label: "Kịch bản nhắn tin" },
    { key: "broadcasts", label: "Gửi hàng loạt" },
  ]
  // Tin Messenger đọc và trả lời ở menu Hộp thư (một chỗ cho mọi kênh).
  const subNav = (
    <nav aria-label="Công cụ Fanpage" className="flex gap-2 overflow-x-auto pb-1">
      {VIEWS.slice(0, 1).map((v) => <Button key={v.key} variant="ax-ghost" size="ax" aria-pressed={view === v.key} onClick={() => setView(v.key)} className={cn("shrink-0", view === v.key && "bg-ax-primary-soft text-ax-primary-ink")}>{v.label}</Button>)}
      <Link href="/inbox" className={cn(buttonVariants({ variant: "ax-ghost", size: "ax" }), "shrink-0")}>Hộp thư</Link>
      {VIEWS.slice(1).map((v) => <Button key={v.key} variant="ax-ghost" size="ax" aria-pressed={view === v.key} onClick={() => setView(v.key)} className={cn("shrink-0", view === v.key && "bg-ax-primary-soft text-ax-primary-ink")}>{v.label}</Button>)}
    </nav>
  )
  const detailProps = selected && { page: selected, assignees, sources: sources.data ?? [], canPickAssignee: canTransfer || assignees.length > 1, onReconnect: connect, reconnecting: m.connect.isPending }
  const connectDisabled = !status.data?.configured || !status.data.secret_key_configured || m.connect.isPending
  const mobilePages = !wide && view === "pages"

  return (
    <div className="space-y-4">
      {!mobilePages && (
        <header className="space-y-3">
          <div className="flex items-center gap-2 text-[13px] text-ax-ink-2">
            <Link href="/connections" className="hover:underline">Kết nối</Link><span aria-hidden>/</span><span>Kênh khách</span><span aria-hidden>/</span><span className="text-ax-ink">Fanpage Facebook</span>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="ax-text-title">Fanpage Facebook</h1>
              <p className="mt-1 text-sm text-ax-ink-2">Tin nhắn Messenger và Lead Ads của từng Page về thành khách trong Trinity.</p>
            </div>
            {view === "pages" && <Button variant="ax-secondary" size="ax" onClick={connect} disabled={connectDisabled}>{m.connect.isPending && <Loader2 className="size-4 animate-spin" />}Thêm Fanpage</Button>}
          </div>
        </header>
      )}
      {!mobilePages && subNav}

      {view === "links" && <FacebookChatLinks pages={livePages} sources={sources.data ?? []} highlight={Number(params.get("link")) || undefined} />}
      {view === "flows" && <FacebookFlows pages={livePages} highlight={Number(params.get("kich-ban")) || undefined} />}
      {view === "broadcasts" && <FacebookBroadcasts pages={livePages} sources={sources.data ?? []} highlight={Number(params.get("luot")) || undefined} />}
      {view === "comments" && <FacebookComments pages={livePages} enabled={!!status.data?.comment_automation} />}

      {view === "pages" && (
        <>
          {status.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang kiểm tra cấu hình...</div>}
          {status.isError && <ErrorState compact title="Không đọc được cấu hình Facebook" error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />}
          {status.data && <SetupHelp s={status.data} admin={isAdmin} />}
          {pages.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>}
          {pages.isError && <ErrorState compact title="Không tải được danh sách Fanpage" error={pages.error} onRetry={() => void pages.refetch()} retrying={pages.isFetching} />}
          {pages.isSuccess && allPages.length === 0 && (
            <EmptyState variant="ax" icon={MessagesSquare} title="Chưa kết nối Fanpage nào" message='Bấm "Kết nối Fanpage" rồi chọn Page trong hộp thoại Facebook. Mỗi người nhắn vào Page thành một khách hàng; khách gửi form Lead Ads cũng tự thành khách hàng.'
              action={<Button variant="ax-primary" size="ax" onClick={connect} disabled={connectDisabled}>{m.connect.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}Kết nối Fanpage</Button>} />
          )}
          {allPages.length > 0 && wide && (
            <div role="tablist" aria-label="Fanpage đã kết nối" className="flex flex-wrap gap-2">
              {allPages.map((p) => {
                const st = pageState(p)
                const on = p.id === selected?.id
                const dot = { ok: "bg-ax-success", bad: "bg-ax-danger", off: "bg-ax-ink-3", warn: "bg-ax-warn" }[STATE_TONE[st]]
                return (
                  <button key={p.id} type="button" role="tab" aria-selected={on} onClick={() => setSelId(p.id)} className={cn("flex min-h-11 cursor-pointer items-center gap-2.5 rounded-ax-field border pr-4 pl-3.5 text-sm font-semibold text-ax-ink outline-none focus-visible:shadow-[var(--ax-focus-ring)]", on ? "border-ax-primary bg-ax-primary-soft" : "border-ax-line bg-ax-surface hover:bg-ax-hover")}>
                    <span aria-hidden className={cn("size-[9px] rounded-full", dot)} />{p.name}<span className="text-[12px] font-medium text-ax-ink-2">{STATE_LABEL[st]}</span>
                  </button>
                )
              })}
            </div>
          )}
          {detailProps && wide && <FacebookPageDesktop key={detailProps.page.id} {...detailProps} />}
          {detailProps && !wide && (
            <>
              {allPages.length > 1 && (
                <div role="tablist" aria-label="Fanpage đã kết nối" className="-mb-2 flex gap-2 overflow-x-auto px-4 pt-3">
                  {allPages.map((p) => <button key={p.id} type="button" role="tab" aria-selected={p.id === selected?.id} onClick={() => setSelId(p.id)} className={cn("min-h-11 shrink-0 cursor-pointer rounded-full border px-4 text-sm font-semibold", p.id === selected?.id ? "border-ax-primary bg-ax-primary-soft text-ax-primary-ink" : "border-ax-line bg-ax-surface text-ax-ink")}>{p.name}</button>)}
                </div>
              )}
              <FacebookPageMobile key={detailProps.page.id} {...detailProps} backHref="/connections" />
              <div className="mx-4 rounded-ax-card bg-ax-surface px-4 shadow-ax-card">
                {VIEWS.slice(1).map((v, i) => (
                  <button key={v.key} type="button" onClick={() => setView(v.key)} className={cn("flex min-h-14 w-full cursor-pointer items-center text-left text-[15px] font-semibold outline-none focus-visible:shadow-[var(--ax-focus-ring)]", i > 0 && "border-t border-ax-divider")}><span className="flex-1">{v.label}</span><ChevronRight className="size-4 text-ax-ink-3" aria-hidden /></button>
                ))}
                <Link href="/inbox" className="flex min-h-14 w-full items-center border-t border-ax-divider text-[15px] font-semibold"><span className="flex-1">Hộp thư</span><ChevronRight className="size-4 text-ax-ink-3" aria-hidden /></Link>
                {/* Thiết kế điện thoại không vẽ «Thêm Fanpage» — giữ chức năng nối thêm Page ở cuối danh sách công cụ. */}
                <button type="button" onClick={connect} disabled={connectDisabled} className="flex min-h-14 w-full cursor-pointer items-center gap-2 border-t border-ax-divider text-left text-[15px] font-semibold text-ax-primary-ink outline-none focus-visible:shadow-[var(--ax-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60">
                  {m.connect.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}<span className="flex-1">Thêm Fanpage</span>
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
