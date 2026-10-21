"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Loader2, Plus, QrCode, Wallet } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CurrencyInput } from "@/components/ui/currency-input"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { ConnectionGroup, ConnectionLogo, ConnectionRow, StatusPill, type ConnectionTone } from "@/components/ui/connection-row"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { usePermissions } from "@/lib/rbac"
import { SecretRevealDialog, CopyButton } from "../secret-reveal-dialog"
import { apiErrorMessage } from "../webhook-types"
import {
  useCancelPayment, useConnectors, useCreatePayment, useDisconnect, useDisconnectSepay, usePayments, useSaveGateway, useSaveSepay,
  type ConnectorStatus, type GatewayProvider, type Payment, type SaveGatewayInput, type SaveSepayInput,
} from "./use-payments"
import { formatDateTimeShort, formatVnd } from "@/lib/format"

const vnd = (n: number) => formatVnd(n)
const when = (iso: string) => formatDateTimeShort(iso)
/** Tên ngân hàng SePay/VietQR hay dùng — gợi ý, khách vẫn gõ tên khác được. */
const BANKS = ["MBBank", "Vietcombank", "ACB", "TPBank", "Techcombank", "VietinBank", "BIDV", "VPBank", "Sacombank", "HDBank", "OCB", "MSB", "VIB", "SHB", "KienLongBank"]
const STATUS: Record<Payment["status"], { tone: ConnectionTone; label: string }> = {
  pending: { tone: "soon", label: "Chờ thanh toán" },
  paid: { tone: "connected", label: "Đã thanh toán" },
  cancelled: { tone: "off", label: "Đã huỷ" },
  expired: { tone: "warning", label: "Quá hạn" },
}

/** Form tài khoản nhận tiền SePay — dùng cho cả kết nối lần đầu và sửa. */
function SepayDialog({ open, onClose, current, onSaved }: {
  open: boolean
  onClose: () => void
  current: ConnectorStatus["settings"]
  onSaved: (apiKey: string | null) => void
}) {
  const save = useSaveSepay()
  const [f, setF] = useState<SaveSepayInput>({
    account_number: current?.account_number ?? "",
    bank: current?.bank ?? "",
    account_name: current?.account_name ?? "",
    code_prefix: current?.code_prefix ?? "TRN",
  })
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const out = await save.mutateAsync({ ...f, account_name: f.account_name || undefined })
      onSaved(out.api_key)
    } catch (err) {
      setError(apiErrorMessage(err, "Không lưu được cấu hình SePay"))
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{current ? "Sửa tài khoản nhận tiền" : "Kết nối SePay"}</DialogTitle>
            <DialogDescription>Tài khoản ngân hàng đã liên kết trong SePay. Trinity dùng nó để tạo mã QR và nhận báo tiền về.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="sepay-acc">Số tài khoản</FieldLabel>
              <Input id="sepay-acc" inputMode="numeric" autoComplete="off" value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="sepay-bank">Ngân hàng</FieldLabel>
              <Input id="sepay-bank" list="sepay-banks" placeholder="vd MBBank" value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} required />
              <datalist id="sepay-banks">{BANKS.map((b) => <option key={b} value={b} />)}</datalist>
              <FieldDescription>Viết như trong SePay: MBBank, Vietcombank, ACB, TPBank…</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="sepay-name">Tên chủ tài khoản (không bắt buộc)</FieldLabel>
              <Input id="sepay-name" value={f.account_name} onChange={(e) => setF({ ...f, account_name: e.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="sepay-prefix">Tiền tố mã thanh toán</FieldLabel>
              <Input id="sepay-prefix" maxLength={5} value={f.code_prefix} onChange={(e) => setF({ ...f, code_prefix: e.target.value.toUpperCase() })} />
              <FieldDescription>Mỗi yêu cầu thanh toán có một mã như {(f.code_prefix || "TRN").toUpperCase()}7K2QXM. Khai cùng tiền tố này ở mục &quot;Cấu hình mã thanh toán&quot; của SePay.</FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Huỷ</Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />} Lưu
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SepaySection({ conn, canManage }: { conn: ConnectorStatus; canManage: boolean }) {
  const [editing, setEditing] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<"rotate" | "disconnect" | null>(null)
  const save = useSaveSepay()
  const disconnect = useDisconnectSepay()
  const webhookUrl = typeof window === "undefined" ? conn.webhook_path : `${window.location.origin}${conn.webhook_path}`
  const s = conn.settings
  const state: { tone: ConnectionTone; label: string } = !conn.connected
    ? { tone: "off", label: "Chưa kết nối" }
    : conn.last_error
      ? { tone: "warning", label: "Có lỗi" }
      : conn.last_event_at
        ? { tone: "connected", label: "Đã kết nối" }
        : { tone: "warning", label: "Chờ giao dịch đầu tiên" }
  const detail = conn.connected && s
    ? [`${s.bank} · ${s.account_number}`, conn.last_event_at ? `tiền về gần nhất ${when(conn.last_event_at)}` : "chưa nhận giao dịch nào", conn.last_error].filter(Boolean).join(" · ")
    : "Tự khớp tiền chuyển khoản vào yêu cầu thanh toán, tạo mã QR"
  return (
    <>
      <ConnectionGroup label="Cổng thanh toán">
        <ConnectionRow
          testId="conn-sepay"
          logo={<ConnectionLogo brand="sepay" color="#1d4ed8" text="SP" />}
          title="SePay"
          description={detail}
          status={<StatusPill tone={state.tone}>{state.label}</StatusPill>}
          note="Chưa thử với tài khoản thật — đã thử bằng dữ liệu mẫu của SePay"
          action={
            canManage ? (
              conn.connected ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setEditing(true)}>Sửa</Button>
                  <Button variant="outline" onClick={() => setConfirm("rotate")}>Tạo khoá mới</Button>
                  <Button variant="outline" onClick={() => setConfirm("disconnect")}>Ngắt</Button>
                </div>
              ) : (
                <Button variant="outline" onClick={() => setEditing(true)} disabled={!conn.secret_key_configured}>Kết nối</Button>
              )
            ) : null
          }
        />
        {conn.connected && (
          <div className="flex flex-col gap-1 px-4 py-3 text-[13px] text-muted-foreground">
            <span>Địa chỉ webhook dán vào SePay (Tích hợp › WebHooks, kiểu chứng thực &quot;API Key&quot;):</span>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 text-foreground">{webhookUrl}</code>
              <CopyButton value={webhookUrl} label="Chép địa chỉ webhook" />
            </div>
          </div>
        )}
      </ConnectionGroup>
      {!conn.secret_key_configured && (
        <p className="px-1 text-[13px] text-muted-foreground">Máy chủ chưa đặt <code className="rounded bg-muted px-1">INTEGRATIONS_SECRET_KEY</code> nên chưa lưu được khoá. Quản trị hệ thống đặt biến này rồi khởi động lại.</p>
      )}
      {editing && (
        <SepayDialog
          open
          current={conn.connected ? s : null}
          onClose={() => setEditing(false)}
          onSaved={(k) => {
            setEditing(false)
            if (k) setApiKey(k)
            else toast.success("Đã lưu tài khoản nhận tiền")
          }}
        />
      )}
      <SecretRevealDialog
        open={apiKey !== null}
        onClose={() => setApiKey(null)}
        title="Dán vào SePay"
        description="Vào my.sepay.vn › Tích hợp › WebHooks › Thêm webhook: chọn sự kiện Có tiền vào, dán địa chỉ bên dưới, kiểu chứng thực API Key rồi dán khoá. Khoá chỉ hiện một lần."
        items={apiKey ? [{ label: "Địa chỉ webhook", value: webhookUrl }, { label: "API Key", value: apiKey }] : []}
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "rotate" ? "Tạo khoá webhook mới?" : "Ngắt kết nối SePay?"}
        description={confirm === "rotate"
          ? "Khoá cũ hết hiệu lực ngay. Bạn phải dán khoá mới vào SePay, nếu không Trinity sẽ không nhận được báo tiền về."
          : "Trinity sẽ thôi nhận báo tiền về và không tạo mã QR nữa. Các yêu cầu thanh toán cũ vẫn giữ."}
        confirmLabel={confirm === "rotate" ? "Tạo khoá mới" : "Ngắt kết nối"}
        tone={confirm === "rotate" ? "default" : "destructive"}
        pending={save.isPending || disconnect.isPending}
        onConfirm={async () => {
          try {
            if (confirm === "rotate" && s?.account_number && s.bank) {
              const out = await save.mutateAsync({ account_number: s.account_number, bank: s.bank, account_name: s.account_name, code_prefix: s.code_prefix, rotate_key: true })
              setApiKey(out.api_key)
            } else if (confirm === "disconnect") {
              await disconnect.mutateAsync()
              toast.success("Đã ngắt SePay")
            }
            setConfirm(null)
          } catch (err) {
            toast.error(apiErrorMessage(err, "Không thực hiện được"))
          }
        }}
      />
    </>
  )
}


const GATEWAY: Record<GatewayProvider, { title: string; color: string; text: string; desc: string; portal: string; fields: ReadonlyArray<{ key: keyof SaveGatewayInput; label: string; secret?: boolean; hint?: string }> }> = {
  vnpay: {
    title: "VNPay",
    color: "#e11d48",
    text: "VN",
    desc: "Link thanh toán thẻ ATM, Visa/Master, QR ngân hàng",
    portal: "Lấy ở email VNPay gửi khi đăng ký (môi trường thử: sandbox.vnpayment.vn).",
    fields: [
      { key: "tmn_code", label: "Mã website (vnp_TmnCode)" },
      { key: "hash_secret", label: "Chuỗi bí mật (vnp_HashSecret)", secret: true },
    ],
  },
  momo: {
    title: "MoMo",
    color: "#a50064",
    text: "M",
    desc: "Link thanh toán ví MoMo",
    portal: "Lấy ở business.momo.vn › Thông tin tích hợp.",
    fields: [
      { key: "partner_code", label: "Partner code" },
      { key: "access_key", label: "Access key", secret: true },
      { key: "secret_key", label: "Secret key", secret: true },
    ],
  },
}

/** Form khoá VNPay / MoMo — khách dán khoá do cổng cấp. Sửa mà để trống ô khoá ⇒ giữ khoá cũ. */
function GatewayDialog({ provider, current, onClose }: { provider: GatewayProvider; current: ConnectorStatus | undefined; onClose: () => void }) {
  const g = GATEWAY[provider]
  const save = useSaveGateway(provider)
  const editing = !!current?.connected
  const [f, setF] = useState<SaveGatewayInput>({
    sandbox: current?.settings?.sandbox ?? true,
    tmn_code: current?.settings?.tmn_code ?? "",
    partner_code: current?.settings?.partner_code ?? "",
  })
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await save.mutateAsync(f)
      toast.success(`Đã lưu ${g.title}`)
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, `Không lưu được cấu hình ${g.title}`))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{editing ? `Sửa ${g.title}` : `Kết nối ${g.title}`}</DialogTitle>
            <DialogDescription>{g.portal}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {g.fields.map((x) => (
              <Field key={x.key}>
                <FieldLabel htmlFor={`${provider}-${x.key}`}>{x.label}</FieldLabel>
                <Input
                  id={`${provider}-${x.key}`}
                  type={x.secret ? "password" : "text"}
                  autoComplete="off"
                  placeholder={x.secret && editing ? "Để trống = giữ khoá cũ" : undefined}
                  value={String(f[x.key] ?? "")}
                  onChange={(e) => setF({ ...f, [x.key]: e.target.value })}
                  required={!x.secret || !editing}
                />
              </Field>
            ))}
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor={`${provider}-sandbox`}>Môi trường thử (sandbox)</FieldLabel>
                <Switch id={`${provider}-sandbox`} checked={f.sandbox} onCheckedChange={(v) => setF({ ...f, sandbox: v })} aria-label="Môi trường thử" />
              </div>
              <FieldDescription>Bật khi dùng khoá thử. Tắt khi đã có khoá thật để nhận tiền thật.</FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Huỷ</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending && <Loader2 className="size-4 animate-spin" />} Lưu</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function GatewayRow({ provider, conn, canManage }: { provider: GatewayProvider; conn: ConnectorStatus | undefined; canManage: boolean }) {
  const g = GATEWAY[provider]
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const disconnect = useDisconnect(provider)
  const on = !!conn?.connected
  const ipnUrl = typeof window === "undefined" || !conn ? "" : `${window.location.origin}${conn.webhook_path}`
  const detail = on
    ? [conn?.settings?.sandbox ? "Môi trường thử" : "Đang nhận tiền thật", conn?.last_event_at ? `giao dịch gần nhất ${when(conn.last_event_at)}` : "chưa có giao dịch", conn?.last_error].filter(Boolean).join(" · ")
    : g.desc
  return (
    <>
      <ConnectionRow
        testId={`conn-${provider}`}
        logo={<ConnectionLogo brand={provider} color={g.color} text={g.text} />}
        title={g.title}
        description={detail}
        status={<StatusPill tone={!on ? "off" : conn?.last_error ? "warning" : "connected"}>{!on ? "Chưa kết nối" : conn?.last_error ? "Có lỗi" : "Đã kết nối"}</StatusPill>}
        note={provider === "momo" ? "Đã thử với môi trường thử của MoMo; chưa thử tài khoản thật" : "Đã thử trên sandbox VNPay (15/10/2026); chưa thử tài khoản thật"}
        action={canManage ? (
          on ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setEditing(true)}>Sửa</Button>
              <Button variant="outline" onClick={() => setConfirm(true)}>Ngắt</Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setEditing(true)} disabled={conn?.secret_key_configured === false}>Kết nối</Button>
          )
        ) : null}
      />
      {on && provider === "vnpay" && (
        <div className="flex flex-col gap-1 px-4 py-3 text-[13px] text-muted-foreground">
          <span>Gửi VNPay địa chỉ IPN này để khai cho mã website của bạn:</span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 text-foreground">{ipnUrl}</code>
            <CopyButton value={ipnUrl} label="Chép địa chỉ IPN" />
          </div>
        </div>
      )}
      {editing && <GatewayDialog provider={provider} current={conn} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Ngắt kết nối ${g.title}?`}
        description="Link thanh toán đã gửi khách sẽ không mở được nữa. Các yêu cầu thanh toán cũ vẫn giữ."
        confirmLabel="Ngắt kết nối"
        pending={disconnect.isPending}
        onConfirm={async () => {
          try { await disconnect.mutateAsync(); toast.success(`Đã ngắt ${g.title}`); setConfirm(false) } catch (err) { toast.error(apiErrorMessage(err, "Không ngắt được")) }
        }}
      />
    </>
  )
}

function PaymentDetail({ p, onClose }: { p: Payment; onClose: () => void }) {
  const cancel = useCancelPayment()
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{vnd(p.amount)}</DialogTitle>
          <DialogDescription>{p.description || "Yêu cầu thanh toán"} · <StatusPill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</StatusPill></DialogDescription>
        </DialogHeader>
        {p.status === "pending" && p.qr_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- ảnh QR từ qr.sepay.vn, không qua next/image
          <img src={p.qr_url} alt={`Mã QR chuyển ${vnd(p.amount)}, nội dung ${p.transfer_content}`} className="mx-auto aspect-square w-full max-w-64 rounded-lg ring-1 ring-border" />
        ) : p.status === "pending" ? (
          <p className="rounded-lg bg-muted/50 p-3 text-[13px] text-muted-foreground">Chưa kết nối SePay nên chưa có mã QR và chưa tự khớp tiền về. Khách vẫn chuyển khoản được với nội dung bên dưới.</p>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Nội dung CK</dt>
          <dd className="flex items-center justify-between gap-2 font-mono font-medium">{p.transfer_content}<CopyButton value={p.transfer_content} label="Chép nội dung" /></dd>
          {p.bank && (<><dt className="text-muted-foreground">Tài khoản</dt><dd>{p.bank.bank} · {p.bank.account_number}{p.bank.account_name ? ` · ${p.bank.account_name}` : ""}</dd></>)}
          {p.pay_links?.vnpay && (<><dt className="text-muted-foreground">Link VNPay</dt><dd className="flex justify-end"><CopyButton value={p.pay_links.vnpay} label="Chép link VNPay" /></dd></>)}
          {p.pay_links?.momo && (<><dt className="text-muted-foreground">Link MoMo</dt><dd className="flex justify-end"><CopyButton value={p.pay_links.momo} label="Chép link MoMo" /></dd></>)}
          {p.paid_at && (<><dt className="text-muted-foreground">Đã nhận</dt><dd>{vnd(p.paid_amount ?? p.amount)} lúc {when(p.paid_at)}{p.paid_via ? ` qua ${p.paid_via === "sepay" ? "chuyển khoản" : p.paid_via === "vnpay" ? "VNPay" : p.paid_via === "momo" ? "MoMo" : p.paid_via}` : ""}</dd></>)}
          {p.expires_at && p.status === "pending" && (<><dt className="text-muted-foreground">Hạn</dt><dd>{when(p.expires_at)}</dd></>)}
        </dl>
        <DialogFooter>
          {p.status === "pending" && (
            <Button variant="outline" disabled={cancel.isPending} onClick={async () => {
              try { await cancel.mutateAsync(p.id); toast.success("Đã huỷ yêu cầu"); onClose() } catch (err) { toast.error(apiErrorMessage(err, "Không huỷ được")) }
            }}>Huỷ yêu cầu</Button>
          )}
          <Button onClick={onClose}>Xong</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreatePaymentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Payment) => void }) {
  const create = useCreatePayment()
  const [amount, setAmount] = useState("")
  const [desc, setDesc] = useState("")
  const [hours, setHours] = useState("")
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const n = Number(amount)
    if (!n || n < 1000) return setError("Số tiền tối thiểu 1.000đ")
    try {
      onCreated(await create.mutateAsync({ amount: n, description: desc.trim() || undefined, expires_in_hours: hours ? Number(hours) : undefined }))
    } catch (err) {
      setError(apiErrorMessage(err, "Không tạo được yêu cầu"))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Tạo yêu cầu thanh toán</DialogTitle>
            <DialogDescription>Trinity tạo mã và QR chuyển khoản; tiền về là tự đánh dấu đã thanh toán.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field invalid={!!error}>
              <FieldLabel htmlFor="pay-amount">Số tiền (đ)</FieldLabel>
              <CurrencyInput id="pay-amount" value={amount} onValueChange={setAmount} autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="pay-desc">Ghi chú</FieldLabel>
              <Input id="pay-desc" maxLength={200} placeholder="vd Học phí tháng 11 — bé An" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="pay-exp">Hạn thanh toán</FieldLabel>
              <select id="pay-exp" value={hours} onChange={(e) => setHours(e.target.value)} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-[var(--shadow-field)] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 max-sm:h-11">
                <option value="">Không hạn</option>
                <option value="24">24 giờ</option>
                <option value="72">3 ngày</option>
                <option value="168">7 ngày</option>
              </select>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Huỷ</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending && <Loader2 className="size-4 animate-spin" />} Tạo mã</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PaymentsList({ canCreate }: { canCreate: boolean }) {
  const list = usePayments()
  const [creating, setCreating] = useState(false)
  const [shown, setShown] = useState<Payment | null>(null)
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-[13px] font-medium text-muted-foreground">Yêu cầu thanh toán</h3>
        {canCreate && <Button variant="outline" onClick={() => setCreating(true)}><Plus className="size-4" /> Tạo yêu cầu</Button>}
      </div>
      {list.isLoading ? (
        <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải…</div>
      ) : list.isError ? (
        <p role="alert" className="px-1 text-sm text-destructive">Không tải được danh sách. Vui lòng thử lại.</p>
      ) : !list.data?.length ? (
        <EmptyState icon={QrCode} title="Chưa có yêu cầu thanh toán" message="Tạo mã QR chuyển khoản cho khách; tiền về là Trinity tự đánh dấu đã trả." action={canCreate ? <Button variant="outline" onClick={() => setCreating(true)}>Tạo mã QR đầu tiên</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/8 shadow-[var(--shadow-card)]">
          {list.data.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => setShown(p)} className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none">
                <Wallet className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{vnd(p.amount)} · <span className="font-mono">{p.code}</span></span>
                  <span className="truncate text-[13px] text-muted-foreground">{p.description || "Không ghi chú"} · {when(p.created_at)}</span>
                </span>
                <StatusPill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</StatusPill>
              </button>
            </li>
          ))}
        </ul>
      )}
      {creating && <CreatePaymentDialog onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); setShown(p) }} />}
      {shown && <PaymentDetail p={list.data?.find((x) => x.id === shown.id) ?? shown} onClose={() => setShown(null)} />}
    </section>
  )
}

/** Cài đặt › Kết nối & AI › Thanh toán: cổng SePay + yêu cầu thanh toán tự khớp. */
export function PaymentsPanel() {
  const { can } = usePermissions()
  const canManage = can("integrations.webhooks")
  const connectors = useConnectors(canManage)
  const sepay = connectors.data?.find((c) => c.provider === "sepay")
  return (
    <div className="flex flex-col gap-6">
      {canManage && (connectors.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang kiểm tra kết nối…</div>
      ) : connectors.isError ? (
        <p role="alert" className="text-sm text-destructive">{apiErrorMessage(connectors.error, "Không đọc được trạng thái kết nối")}</p>
      ) : sepay ? (
        <>
          <SepaySection conn={sepay} canManage={canManage} />
          <ConnectionGroup label="Ví và thẻ">
            <GatewayRow provider="vnpay" conn={connectors.data?.find((c) => c.provider === "vnpay")} canManage={canManage} />
            <GatewayRow provider="momo" conn={connectors.data?.find((c) => c.provider === "momo")} canManage={canManage} />
          </ConnectionGroup>
        </>
      ) : null)}
      {can("deals.view") && <PaymentsList canCreate={can("deals.manage")} />}
    </div>
  )
}
