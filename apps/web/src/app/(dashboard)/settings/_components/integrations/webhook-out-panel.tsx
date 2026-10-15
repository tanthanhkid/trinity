"use client"

import { useState } from "react"
import { AlertTriangle, Loader2, Plus, Webhook } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { usePermissions } from "@/lib/rbac"
import { SettingsSectionActions } from "../settings-section-header"
import { SecretRevealDialog } from "./secret-reveal-dialog"
import { useEndpointMutations, useWebhookEndpoints, useWebhookEvents } from "./use-webhooks"
import { WebhookDeliveries } from "./webhook-deliveries"
import { WebhookEndpointCard } from "./webhook-endpoint-card"
import { WebhookEndpointDialog, type EndpointFormValues } from "./webhook-endpoint-dialog"
import { WebhookVerifyDocs } from "./webhook-verify-docs"
import { apiErrorMessage, type WebhookEndpoint } from "./webhook-types"

type Confirm = { kind: "delete" | "rotate"; ep: WebhookEndpoint } | null

/**
 * Cài đặt > Kết nối & AI > Webhook ra. `keyReady=false` (máy chủ thiếu INTEGRATIONS_SECRET_KEY) ⇒ không tạo/gửi thử
 * được: banner nói rõ, KHÔNG để người dùng bấm rồi nhận lỗi khó hiểu. BE là cổng thật; FE chỉ ẩn/hiện.
 */
export function WebhookOutPanel({ keyReady }: { keyReady: boolean }) {
  const { can } = usePermissions()
  const endpoints = useWebhookEndpoints(true)
  const events = useWebhookEvents(true)
  const m = useEndpointMutations()
  const [dialog, setDialog] = useState<{ open: boolean; ep: WebhookEndpoint | null }>({ open: false, ep: null })
  const [formError, setFormError] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ title: string; secret: string } | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [deliveryEp, setDeliveryEp] = useState("all")

  const list = endpoints.data ?? []
  const busy = m.update.isPending || m.test.isPending

  function submit(v: EndpointFormValues) {
    setFormError(null)
    const done = () => setDialog({ open: false, ep: null })
    if (dialog.ep) {
      m.update.mutate({ id: dialog.ep.id, ...v }, { onSuccess: () => { done(); toast.success("Đã lưu endpoint") }, onError: (e) => setFormError(apiErrorMessage(e, "Không lưu được endpoint")) })
      return
    }
    m.create.mutate(v, {
      onSuccess: (res) => { done(); setReveal({ title: `Secret của "${res.name}"`, secret: res.secret }) },
      onError: (e) => setFormError(apiErrorMessage(e, "Không tạo được endpoint")),
    })
  }

  function test(ep: WebhookEndpoint) {
    m.test.mutate(ep.id, {
      onSuccess: (r) => (r.ok ? toast.success(`Gửi thử thành công (HTTP ${r.status_code}, ${r.duration_ms} ms)`) : toast.error(`Gửi thử thất bại: ${r.status_code ? `HTTP ${r.status_code}` : (r.error ?? "lỗi mạng")}`)),
      onError: (e) => toast.error(apiErrorMessage(e, "Không gửi thử được")),
    })
  }

  function runConfirm() {
    if (!confirm) return
    const { kind, ep } = confirm
    if (kind === "delete") {
      m.remove.mutate(ep.id, { onSuccess: () => { setConfirm(null); toast.success("Đã xoá endpoint") }, onError: (e) => toast.error(apiErrorMessage(e, "Không xoá được")) })
    } else {
      m.rotate.mutate(ep.id, {
        onSuccess: (res) => { setConfirm(null); setReveal({ title: `Secret mới của "${ep.name}"`, secret: res.secret }) },
        onError: (e) => toast.error(apiErrorMessage(e, "Không tạo lại được secret")),
      })
    }
  }

  return (
    <div className="space-y-4">
      {can("integrations.webhooks") && (
        <SettingsSectionActions mobile="fab">
          <Button disabled={!keyReady} onClick={() => { setFormError(null); setDialog({ open: true, ep: null }) }} className={MOBILE_FAB_CLASS}>
            <Plus className="mr-1 size-4" /> Thêm endpoint
          </Button>
        </SettingsSectionActions>
      )}

      <p className="text-sm text-muted-foreground">
        Bắn sự kiện (khách mới, đổi giai đoạn, deal chốt, đơn POS…) sang hệ thống khác, có chữ ký HMAC và tự thử lại. Payload tính theo quyền của người tạo endpoint.
      </p>

      {!keyReady && (
        <Card><CardContent className="flex items-start gap-2 py-4 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>Máy chủ chưa có khoá mã hoá <code className="rounded bg-muted px-1">INTEGRATIONS_SECRET_KEY</code> (32 byte base64) nên chưa tạo hoặc gửi được webhook. Quản trị hệ thống cần đặt khoá rồi khởi động lại dịch vụ.</span>
        </CardContent></Card>
      )}

      {(endpoints.isError || events.isError) && (
        <Card><CardContent className="flex items-center gap-2 py-4 text-sm text-red-600"><AlertTriangle className="size-4" /> Không tải được danh sách webhook. Vui lòng thử lại.</CardContent></Card>
      )}
      {endpoints.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>}
      {endpoints.isSuccess && list.length === 0 && (
        <EmptyState icon={Webhook} title="Chưa có endpoint nào" message="Thêm một địa chỉ nhận để Trinity báo sự kiện (khách mới, deal đổi trạng thái…) sang hệ thống khác." action={<Button variant="outline" disabled={!keyReady} onClick={() => { setFormError(null); setDialog({ open: true, ep: null }) }}><Plus className="size-4" /> Thêm địa chỉ nhận</Button>} />
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {list.map((ep) => (
          <WebhookEndpointCard
            key={ep.id}
            ep={ep}
            busy={busy}
            keyReady={keyReady}
            actions={{
              onToggle: (e, active) => m.update.mutate({ id: e.id, is_active: active }, { onError: (err) => toast.error(apiErrorMessage(err, "Không đổi được trạng thái")) }),
              onTest: test,
              onEdit: (e) => { setFormError(null); setDialog({ open: true, ep: e }) },
              onRotate: (e) => setConfirm({ kind: "rotate", ep: e }),
              onDelete: (e) => setConfirm({ kind: "delete", ep: e }),
              onShowDeliveries: (e) => setDeliveryEp(String(e.id)),
            }}
          />
        ))}
      </div>

      <WebhookVerifyDocs />
      <WebhookDeliveries endpoints={list} endpointId={deliveryEp} onEndpointChange={setDeliveryEp} />

      <WebhookEndpointDialog
        open={dialog.open}
        onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))}
        endpoint={dialog.ep}
        events={events.data ?? []}
        pending={m.create.isPending || m.update.isPending}
        error={formError}
        canSeePhone={can("contacts.phone_full")}
        onSubmit={submit}
      />

      <SecretRevealDialog
        open={reveal !== null}
        onClose={() => { setReveal(null); m.create.reset(); m.rotate.reset() /* không giữ secret trong mutation cache */ }}
        title={reveal?.title ?? ""}
        description="Dùng secret này ở phía bên nhận để kiểm chữ ký X-Trinity-Signature."
        items={reveal ? [{ label: "Secret ký (whsec_…)", value: reveal.secret }] : []}
      />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === "delete" ? "Xoá endpoint?" : "Tạo lại secret?"}
        description={
          confirm?.kind === "delete"
            ? <>Xoá <strong>{confirm.ep.name}</strong> cùng toàn bộ lịch sử gửi. Hành động này không hoàn tác được.</>
            : <>Secret cũ của <strong>{confirm?.ep.name}</strong> hết hiệu lực ngay; bên nhận phải cập nhật secret mới, nếu không chữ ký sẽ không khớp.</>
        }
        confirmLabel={confirm?.kind === "delete" ? "Xoá endpoint" : "Tạo lại secret"}
        pending={m.remove.isPending || m.rotate.isPending}
        onConfirm={runConfirm}
      />
    </div>
  )
}
