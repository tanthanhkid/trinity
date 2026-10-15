"use client"

import { useState } from "react"
import Link from "next/link"
import { AlertTriangle, Bot, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { formatDateTimeVn } from "@/lib/format"
import { usePermissions } from "@/lib/rbac"
import { useAiActionSettings, useAiActionsPendingCount, useUpdateAiActionSettings } from "@/hooks/ai-actions/use-ai-actions"
import { Switch } from "@/components/ui/switch"
import { AiConnectGuide } from "./ai-connect-guide"
import { useAiConnections, useRevokeAiConnection } from "./use-ai-connections"
import type { AiConnection } from "./integrations-meta"
import { apiErrorMessage } from "./webhook-types"

const SCOPE_LABELS: Record<string, string> = { "crm.read": "Đọc", "crm.write": "Thay đổi dữ liệu (theo quyền của bạn)" }
/** Chỉ có `crm.read` ⇒ "Chỉ đọc"; có thêm `crm.write` ⇒ "Đọc" + "Thay đổi dữ liệu (theo quyền của bạn)". */
const scopeLabel = (s: string, all: string[]): string => (s === "crm.read" && !all.includes("crm.write") ? "Chỉ đọc" : (SCOPE_LABELS[s] ?? s))

/** Claude/ChatGPT không báo khi bị ngắt bên họ ⇒ chỉ khẳng định "đang hoạt động" khi có dùng trong 1 giờ (access token sống 1 giờ). */
const ACTIVE_WINDOW_MS = 60 * 60 * 1000
const isActive = (c: AiConnection): boolean => {
  const t = Date.parse(c.last_used_at ?? c.connected_at ?? "")
  return Number.isFinite(t) && Date.now() - t <= ACTIVE_WINDOW_MS
}

/**
 * Cài đặt > Kết nối & AI > Kết nối AI: hướng dẫn nối ChatGPT/Claude + danh sách ứng dụng ĐÃ cấp quyền + thu hồi.
 * Người có `ai_admin` xem được của mọi người. FE chỉ ẩn/hiện — BE mới là cổng thật (thu hồi của người khác khi thiếu ai_admin ⇒ 404).
 */
export function AiConnectionsPanel({ mcpUrl, baseUrlConfigured }: { mcpUrl: string | null; baseUrlConfigured: boolean }) {
  const { can } = usePermissions()
  const isAdmin = can("integrations.ai_admin")
  const [all, setAll] = useState(false)
  const [confirm, setConfirm] = useState<AiConnection | null>(null)
  const ready = mcpUrl !== null
  const list = useAiConnections(all && isAdmin, ready)
  const revoke = useRevokeAiConnection()
  const pendingActions = useAiActionsPendingCount(ready).data ?? 0
  const approvalSetting = useAiActionSettings(ready)
  const updateApproval = useUpdateAiActionSettings()
  const requireApproval = approvalSetting.data?.require_approval === true
  const rows = list.data ?? []

  function runRevoke() {
    if (!confirm) return
    revoke.mutate(confirm.id, {
      onSuccess: () => { setConfirm(null); toast.success("Đã thu hồi quyền truy cập") },
      onError: (e) => toast.error(apiErrorMessage(e, "Không thu hồi được")),
    })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Nối tài khoản của bạn vào ChatGPT / Claude để hỏi đáp dữ liệu khách hàng theo ĐÚNG quyền của bạn (số điện thoại luôn bị che). Nếu bạn bật quyền
        &quot;Cho phép AI thay đổi dữ liệu&quot;, AI có thể tạo khách, ghi chú, đổi giai đoạn, tạo công việc, nhập dữ liệu… và thay đổi có hiệu lực ngay trong phạm vi quyền của bạn — mọi thao tác được ghi lại ở mục Hoạt động AI.
      </p>
      {ready && isAdmin && (
        <div className="flex items-start justify-between gap-3 rounded-[var(--radius)] border bg-card p-3" data-testid="require-approval-setting">
          <div className="min-w-0 space-y-0.5">
            <label htmlFor="ai-require-approval" className="text-sm font-semibold">Yêu cầu duyệt thay đổi do AI</label>
            <p className="text-xs text-muted-foreground">
              {requireApproval
                ? "Đang BẬT: AI chỉ tạo đề xuất; thay đổi chỉ có hiệu lực sau khi người dùng bấm Duyệt ở mục Hoạt động AI."
                : "Đang TẮT (mặc định): AI ghi thẳng theo quyền của người đã kết nối. Bật nếu muốn xem và duyệt từng thay đổi trước khi thực hiện."}
            </p>
          </div>
          <Switch
            id="ai-require-approval"
            checked={requireApproval}
            disabled={!approvalSetting.isSuccess || updateApproval.isPending}
            onCheckedChange={(v) => updateApproval.mutate(v, {
              onSuccess: () => toast.success(v ? "Đã bật yêu cầu duyệt thay đổi do AI" : "Đã tắt — AI ghi thẳng theo quyền người dùng"),
              onError: (e) => toast.error(apiErrorMessage(e, "Không lưu được cài đặt")),
            })}
          />
        </div>
      )}
      {ready && (
        <p className="text-sm">
          <Link href="/ai-actions" className="inline-flex min-h-11 items-center font-medium text-primary underline">
            {pendingActions > 0 ? `Có ${pendingActions} thay đổi của AI đang chờ bạn duyệt` : "Xem hoạt động của AI"}
          </Link>
        </p>
      )}
      <AiConnectGuide mcpUrl={mcpUrl} baseUrlConfigured={baseUrlConfigured} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Ứng dụng đã được cấp quyền</h3>
        {isAdmin && (
          <div className="flex gap-2" role="group" aria-label="Phạm vi danh sách">
            <Button size="sm" variant={all ? "outline" : "soft"} aria-pressed={!all} onClick={() => setAll(false)}>Của tôi</Button>
            <Button size="sm" variant={all ? "soft" : "outline"} aria-pressed={all} onClick={() => setAll(true)}>Mọi người</Button>
          </div>
        )}
      </div>

      {!ready && <p className="text-sm text-muted-foreground">Danh sách sẽ hiện khi máy chủ sẵn sàng.</p>}
      {ready && list.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>}
      {ready && list.isError && (
        <Card><CardContent className="flex items-center gap-2 py-4 text-sm text-red-600"><AlertTriangle className="size-4" /> Không tải được danh sách kết nối. Vui lòng thử lại.</CardContent></Card>
      )}
      {ready && list.isSuccess && rows.length === 0 && (
        <EmptyState icon={Bot} message={all ? "Chưa ai kết nối ứng dụng AI." : "Bạn chưa kết nối ứng dụng AI nào."} />
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((c) => (
          <Card key={c.id} className="rounded-2xl">
            <CardContent className="space-y-3 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    <span className="break-words">{c.client_name}</span>
                    {c.scopes.map((s) => (
                      <Badge key={s} variant={s === "crm.read" ? "success" : "secondary"}>{scopeLabel(s, c.scopes)}</Badge>
                    ))}
                    {isActive(c)
                      ? <Badge variant="success" data-testid="conn-active">Đang hoạt động</Badge>
                      : <Badge variant="outline" data-testid="conn-idle">Lâu không hoạt động</Badge>}
                  </p>
                  {!isActive(c) && <p className="mt-0.5 text-xs text-amber-700">Chưa thấy AI dùng gần đây. Nếu bạn đã ngắt bên AI, bấm Thu hồi để dọn quyền này.</p>}
                  {all && <p className="mt-0.5 text-xs text-muted-foreground">{c.user.full_name ?? "—"} · {c.user.email}</p>}
                </div>
                <Button variant="outline" size="sm" className="max-sm:h-11" aria-label={`Thu hồi ${c.client_name}`} onClick={() => setConfirm(c)}>Thu hồi</Button>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <dt>Kết nối từ</dt>
                <dd className="text-right">{c.connected_at ? formatDateTimeVn(c.connected_at) : "—"}</dd>
                <dt>Lần dùng cuối</dt>
                <dd className="text-right">{c.last_used_at ? formatDateTimeVn(c.last_used_at) : "Chưa dùng"}</dd>
                <dt>Tự hết hạn nếu không dùng</dt>
                <dd className="text-right">{formatDateTimeVn(c.refresh_expires_at)}</dd>
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => { if (!o) setConfirm(null) }}
        title="Thu hồi quyền truy cập"
        description={confirm && <>Ứng dụng <strong>{confirm.client_name}</strong>{all && confirm.user.email ? <> của <strong>{confirm.user.email}</strong></> : null} sẽ mất quyền truy cập NGAY. Muốn dùng lại phải kết nối và bấm Cho phép lại.</>}
        confirmLabel="Thu hồi quyền"
        pending={revoke.isPending}
        onConfirm={runRevoke}
      />
    </div>
  )
}
