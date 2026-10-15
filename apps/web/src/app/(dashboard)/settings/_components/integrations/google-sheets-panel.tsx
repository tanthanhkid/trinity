"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, Loader2, Plus, Sheet } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { usePermissions } from "@/lib/rbac"
import { GoogleSyncCard } from "./google-sync-card"
import { GoogleSyncDialog } from "./google-sync-dialog"
import { summarizeStats, type GoogleSync } from "./google-sheets-types"
import { useGoogleActions, useGoogleStatus, useGoogleSyncs, useGoogleTargets } from "./use-google-sheets"
import { useContactSourceOptions } from "./use-webhooks"
import { apiErrorMessage } from "./webhook-types"

const RETURN_MESSAGES: Record<string, [("success" | "error"), string]> = {
  connected: ["success", "Đã kết nối Google"],
  denied: ["error", "Bạn đã từ chối cấp quyền cho Google"],
  error: ["error", "Kết nối Google không thành công, vui lòng thử lại"],
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-2 py-4 text-sm text-amber-700">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>{children}</span>
      </CardContent>
    </Card>
  )
}

/** Cài đặt > Kết nối & AI > Google Sheets. Quyền tạo/sửa theo đích dữ liệu do BE kiểm; FE chỉ phản chiếu. */
export function GoogleSheetsPanel() {
  const { can } = usePermissions()
  const canWrite = can("integrations.webhooks")
  const status = useGoogleStatus()
  const connected = status.data?.connection?.status === "active"
  const ready = connected && status.data?.feature_enabled === true
  const syncs = useGoogleSyncs(ready)
  const targets = useGoogleTargets(ready)
  const sources = useContactSourceOptions(ready)
  const act = useGoogleActions()
  const [dialog, setDialog] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [del, setDel] = useState<GoogleSync | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [runningId, setRunningId] = useState<number | null>(null)
  const returned = useSearchParams().get("google")

  useEffect(() => {
    const m = returned ? RETURN_MESSAGES[returned] : undefined
    if (m) toast[m[0]](m[1])
  }, [returned])

  if (status.isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Đang kiểm tra kết nối Google…</div>
  if (status.isError || !status.data) return <Notice>Không đọc được trạng thái Google. Vui lòng thử lại.</Notice>
  const st = status.data
  if (!st.feature_enabled) return <Notice>Tính năng Google Sheets đang tắt cho tổ chức này (Cài đặt &gt; Tính năng).</Notice>
  if (!st.configured) return <Notice>Máy chủ chưa cấu hình Google. Quản trị hệ thống cần đặt <code className="rounded bg-muted px-1">GOOGLE_OAUTH_CLIENT_ID</code> và <code className="rounded bg-muted px-1">GOOGLE_OAUTH_CLIENT_SECRET</code> (và <code className="rounded bg-muted px-1">INTEGRATIONS_PUBLIC_BASE_URL</code>) rồi khởi động lại dịch vụ.</Notice>
  if (!st.secret_key_configured) return <Notice>Thiếu <code className="rounded bg-muted px-1">INTEGRATIONS_SECRET_KEY</code> — chưa thể lưu token Google an toàn.</Notice>

  function connect() {
    act.start.mutate(undefined, {
      onSuccess: (url) => { window.location.href = url },
      onError: (e) => toast.error(apiErrorMessage(e, "Không bắt đầu được kết nối Google")),
    })
  }

  function run(s: GoogleSync, backfill?: boolean) {
    setRunningId(s.id)
    act.run.mutate({ id: s.id, backfill }, {
      onSuccess: (r) => toast.success(summarizeStats(r, s.direction)),
      onError: (e) => toast.error(apiErrorMessage(e, "Chạy đồng bộ không thành công")),
      onSettled: () => setRunningId(null),
    })
  }

  const list = syncs.data ?? []
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0 space-y-0.5">
            <p className="flex items-center gap-2 text-sm font-medium"><Sheet className="size-4" />Tài khoản Google</p>
            {st.connection ? (
              <p className="text-sm text-muted-foreground">
                {st.connection.status === "active" ? `Đã kết nối${st.connection.email ? `: ${st.connection.email}` : ""}` : `Kết nối lỗi — ${st.connection.last_error ?? "cần kết nối lại"}`}
              </p>
            ) : <p className="text-sm text-muted-foreground">Chưa kết nối. Chỉ xin quyền Google Sheets và các file do CRM tạo — không đọc toàn bộ Drive.</p>}
          </div>
          {canWrite && (
            <div className="flex gap-2">
              {st.connection && <Button variant="outline" onClick={() => setDisconnecting(true)} className="max-sm:h-11">Ngắt kết nối</Button>}
              <Button onClick={connect} disabled={act.start.isPending} className="max-sm:h-11">
                {act.start.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}{st.connection ? "Kết nối lại" : "Kết nối Google"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {connected && (
        <>
          {canWrite && <div className="flex justify-end"><Button onClick={() => { setFormError(null); setDialog(true) }} className="max-sm:h-11"><Plus className="mr-1 size-4" />Thêm đồng bộ</Button></div>}
          {syncs.isError && <Notice>Không tải được danh sách đồng bộ.</Notice>}
          {syncs.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Đang tải…</div>}
          {syncs.data && list.length === 0 && <EmptyState icon={Sheet} action={canWrite ? <Button variant="outline" onClick={() => { setFormError(null); setDialog(true) }}><Plus className="size-4" /> Nối bảng tính</Button> : undefined} message="Chưa có đồng bộ nào. Thêm một cấu hình để nhập khách từ Sheet hoặc xuất dữ liệu mới ra Sheet." />}
          {list.map((s) => (
            <GoogleSyncCard key={s.id} s={s} canWrite={canWrite} running={runningId === s.id} actions={{
              onToggle: (x, active) => act.update.mutate({ id: x.id, is_active: active }, { onError: (e) => toast.error(apiErrorMessage(e, "Không cập nhật được")) }),
              onRun: run,
              onDelete: setDel,
            }} />
          ))}
        </>
      )}

      <GoogleSyncDialog
        open={dialog} onOpenChange={setDialog} targets={targets.data} sources={sources.data ?? []}
        inspect={(v) => act.inspect.mutateAsync(v)} inspecting={act.inspect.isPending}
        pending={act.create.isPending} error={formError}
        onSubmit={(v) => act.create.mutate(v, { onSuccess: () => { setDialog(false); toast.success("Đã tạo cấu hình đồng bộ") }, onError: (e) => setFormError(apiErrorMessage(e, "Không tạo được cấu hình")) })}
      />
      <ConfirmDialog
        open={del !== null} onOpenChange={(o) => !o && setDel(null)} title="Xoá cấu hình đồng bộ?"
        description={`Cấu hình "${del?.name ?? ""}" sẽ ngừng chạy. Dữ liệu đã nhập/xuất không bị xoá.`} confirmLabel="Xoá"
        onConfirm={() => { if (del) act.remove.mutate(del.id, { onSuccess: () => setDel(null), onError: (e) => toast.error(apiErrorMessage(e, "Không xoá được")) }) }}
      />
      <ConfirmDialog
        open={disconnecting} onOpenChange={setDisconnecting} title="Ngắt kết nối Google?"
        description="Token sẽ bị thu hồi và mọi cấu hình đồng bộ bị tạm tắt. Dữ liệu đã đồng bộ không bị xoá." confirmLabel="Ngắt kết nối"
        onConfirm={() => act.disconnect.mutate(undefined, { onSuccess: () => { setDisconnecting(false); toast.success("Đã ngắt kết nối") }, onError: (e) => toast.error(apiErrorMessage(e, "Không ngắt được")) })}
      />
    </div>
  )
}
