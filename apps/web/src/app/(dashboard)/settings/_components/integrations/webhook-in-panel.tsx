"use client"

import { useState } from "react"
import { AlertTriangle, Inbox, Loader2, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { usePermissions } from "@/lib/rbac"
import { useAuthStore } from "@/store/auth"
import { SettingsSectionActions } from "../settings-section-header"
import { SecretRevealDialog, type RevealItem } from "./secret-reveal-dialog"
import { useAssignableUsers, useContactSourceOptions, useInboundSources, useSourceMutations } from "./use-webhooks"
import { WebhookSourceCard } from "./webhook-source-card"
import { WebhookSourceDialog, type SourceFormValues } from "./webhook-source-dialog"
import { apiErrorMessage, curlExample, inboundUrl, type InboundSource, type InboundSourceWithToken, type SimpleOption } from "./webhook-types"

const PLACEHOLDER = "/api/v1/hooks/in/<TOKEN — chỉ xem được lúc tạo / tạo lại>"

function revealItems(res: { path: string; signing_secret?: string; signed: boolean }): RevealItem[] {
  const url = inboundUrl(res.path)
  const items: RevealItem[] = [{ label: "URL nhận khách (có token)", value: url }]
  if (res.signing_secret) items.push({ label: "Signing secret (whsec_…)", value: res.signing_secret })
  items.push({ label: "Ví dụ gọi bằng curl", value: curlExample(url, res.signed), multiline: true })
  return items
}

/** Cài đặt > Kết nối & AI > Webhook vào. Tạo/sửa cần `contacts.create` (BE kiểm; FE ẩn nút để khỏi nhận 403). */
export function WebhookInPanel({ keyReady }: { keyReady: boolean }) {
  const { can } = usePermissions()
  const me = useAuthStore((s) => s.user)
  const canWrite = can("contacts.create")
  const sources = useInboundSources(true)
  const m = useSourceMutations()
  const canTransfer = can("contacts.transfer")
  const roster = useAssignableUsers(canWrite && canTransfer)
  const options = useContactSourceOptions(true)
  const [dialog, setDialog] = useState<{ open: boolean; s: InboundSource | null }>({ open: false, s: null })
  const [formError, setFormError] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ title: string; items: RevealItem[] } | null>(null)
  const [guide, setGuide] = useState<InboundSource | null>(null)
  const [confirm, setConfirm] = useState<{ kind: "delete" | "rotate"; s: InboundSource } | null>(null)

  // Không có contacts.transfer ⇒ BE chỉ cho chọn CHÍNH MÌNH.
  const assignees: SimpleOption[] = canTransfer
    ? (roster.data ?? [])
    : me ? [{ id: me.id, label: me.full_name }] : []
  const list = sources.data ?? []
  const assigneeName = (id: number) => assignees.find((a) => a.id === id)?.label ?? `User #${id}`
  const sourceLabel = (id: number) => options.data?.find((o) => o.id === id)?.label ?? `Nguồn #${id}`
  const done = () => setDialog({ open: false, s: null })

  function submit(v: SourceFormValues) {
    setFormError(null)
    const body = { name: v.name, default_assignee_id: Number(v.default_assignee_id), contact_source_id: Number(v.contact_source_id) }
    if (dialog.s) {
      const cur = dialog.s
      m.update.mutate({ id: cur.id, ...body, ...(v.signed !== cur.signed ? { signed: v.signed } : {}) }, {
        onSuccess: (res) => {
          done()
          if (res.signing_secret) setReveal({ title: `Signing secret mới của "${res.name}"`, items: [{ label: "Signing secret (whsec_…)", value: res.signing_secret }] })
          else toast.success("Đã lưu nguồn")
        },
        onError: (e) => setFormError(apiErrorMessage(e, "Không lưu được nguồn")),
      })
      return
    }
    m.create.mutate({ ...body, signed: v.signed }, {
      onSuccess: (res: InboundSourceWithToken) => { done(); setReveal({ title: `Nguồn "${res.name}" đã tạo`, items: revealItems(res) }) },
      onError: (e) => setFormError(apiErrorMessage(e, "Không tạo được nguồn")),
    })
  }

  function runConfirm() {
    if (!confirm) return
    const { kind, s } = confirm
    if (kind === "delete") {
      m.remove.mutate(s.id, { onSuccess: () => { setConfirm(null); toast.success("Đã xoá nguồn") }, onError: (e) => toast.error(apiErrorMessage(e, "Không xoá được")) })
    } else {
      m.rotateToken.mutate(s.id, {
        onSuccess: (res) => { setConfirm(null); setReveal({ title: `Token mới của "${s.name}"`, items: revealItems(res) }) },
        onError: (e) => toast.error(apiErrorMessage(e, "Không tạo lại được token")),
      })
    }
  }

  return (
    <div className="space-y-4">
      {canWrite && (
        <SettingsSectionActions mobile="fab">
          <Button disabled={!keyReady} onClick={() => { setFormError(null); setDialog({ open: true, s: null }) }} className={MOBILE_FAB_CLASS}>
            <Plus className="mr-1 size-4" /> Thêm nguồn
          </Button>
        </SettingsSectionActions>
      )}

      <p className="text-sm text-muted-foreground">
        Nhận khách hàng từ landing page, form, hệ thống khác qua một đường dẫn riêng có mã bí mật. Khách tạo ra thuộc sale nhận mặc định; trùng SĐT thì chỉ ghi thêm ghi chú vào khách cũ.
      </p>

      {!keyReady && (
        <Card><CardContent className="flex items-start gap-2 py-4 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>Máy chủ chưa có khoá mã hoá <code className="rounded bg-muted px-1">INTEGRATIONS_SECRET_KEY</code> nên chưa tạo được nguồn mới và nguồn có chữ ký sẽ không nhận được khách.</span>
        </CardContent></Card>
      )}
      {!canWrite && <p className="text-xs text-muted-foreground">Bạn chỉ xem được danh sách: tạo/sửa nguồn cần thêm quyền &quot;Thêm khách hàng&quot;.</p>}

      {sources.isError && <Card><CardContent className="flex items-center gap-2 py-4 text-sm text-red-600"><AlertTriangle className="size-4" /> Không tải được danh sách nguồn. Vui lòng thử lại.</CardContent></Card>}
      {sources.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>}
      {sources.isSuccess && list.length === 0 && <EmptyState icon={Inbox} action={<Button variant="outline" disabled={!keyReady} onClick={() => { setFormError(null); setDialog({ open: true, s: null }) }}><Plus className="size-4" /> Tạo đường dẫn nhận khách</Button>} message='Chưa có nguồn nào. Bấm "Thêm nguồn" để tạo đường dẫn nhận khách đầu tiên.' />}

      <div className="grid gap-3 lg:grid-cols-2">
        {list.map((s) => (
          <WebhookSourceCard
            key={s.id}
            s={s}
            assigneeName={assigneeName(s.default_assignee_id)}
            sourceLabel={sourceLabel(s.contact_source_id)}
            busy={m.update.isPending}
            canWrite={canWrite}
            actions={{
              onToggle: (x, active) => m.update.mutate({ id: x.id, is_active: active }, { onError: (e) => toast.error(apiErrorMessage(e, "Không đổi được trạng thái")) }),
              onEdit: (x) => { setFormError(null); setDialog({ open: true, s: x }) },
              onRotate: (x) => setConfirm({ kind: "rotate", s: x }),
              onDelete: (x) => setConfirm({ kind: "delete", s: x }),
              onGuide: setGuide,
            }}
          />
        ))}
      </div>

      <WebhookSourceDialog
        open={dialog.open}
        onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))}
        source={dialog.s}
        assignees={assignees}
        sources={options.data ?? []}
        pending={m.create.isPending || m.update.isPending}
        error={formError}
        onSubmit={submit}
      />

      <SecretRevealDialog open={reveal !== null} onClose={() => { setReveal(null); m.create.reset(); m.rotateToken.reset(); m.update.reset() /* không giữ token/secret trong mutation cache */ }} title={reveal?.title ?? ""} description="Gửi URL này cho bên đẩy khách vào. Mỗi nguồn có hạn mức 100 request/phút." items={reveal?.items ?? []} />

      <Dialog open={guide !== null} onOpenChange={(o) => !o && setGuide(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Cách gọi webhook vào</DialogTitle>
            <DialogDescription>Token chỉ hiện lúc tạo hoặc tạo lại. Quên token thì bấm &quot;Tạo lại token&quot; (URL cũ vô hiệu ngay).</DialogDescription>
          </DialogHeader>
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-all">{curlExample(inboundUrl(PLACEHOLDER), guide?.signed ?? false)}</pre>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>Bắt buộc <code>name</code>, <code>phone</code>; tuỳ chọn <code>email</code>, <code>note</code>, <code>source</code>, <code>external_id</code> (gửi lại an toàn), <code>extra</code>.</li>
            <li>201 tạo mới · 200 <code>duplicate</code> (trùng SĐT) · 200 <code>replayed</code> (trùng <code>external_id</code>) · 404 token sai · 429 quá 100 request/phút.</li>
            {guide?.signed && <li>Nguồn này yêu cầu chữ ký: <code>X-Trinity-Signature: t=&lt;unix&gt;,v1=HMAC-SHA256(signing secret, &quot;&lt;t&gt;.&lt;body thô&gt;&quot;)</code>.</li>}
          </ul>
          <DialogFooter><Button variant="outline" onClick={() => setGuide(null)} className="max-sm:h-11">Đóng</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === "delete" ? "Xoá nguồn?" : "Tạo lại token?"}
        description={
          confirm?.kind === "delete"
            ? <>Xoá <strong>{confirm.s.name}</strong>: URL nhận khách ngừng hoạt động ngay. Khách đã tạo không bị xoá.</>
            : <>URL cũ của <strong>{confirm?.s.name}</strong> vô hiệu ngay; bên đẩy khách phải dùng URL mới.</>
        }
        confirmLabel={confirm?.kind === "delete" ? "Xoá nguồn" : "Tạo lại token"}
        pending={m.remove.isPending || m.rotateToken.isPending}
        onConfirm={runConfirm}
      />
    </div>
  )
}
