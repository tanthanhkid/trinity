"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, Loader2, Store as StoreIcon } from "lucide-react"
import apiClient from "@/lib/api-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { EmptyState } from "@/components/ui/empty-state"
import { ConnectionGroup, StatusPill, type ConnectionTone } from "@/components/ui/connection-row"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { useProducts } from "@/hooks/products/use-products"
import { usePermissions } from "@/lib/rbac"
import { cn } from "@/lib/utils"
import { CopyButton } from "../secret-reveal-dialog"
import { apiErrorMessage } from "../webhook-types"
import { formatDateTimeShort, formatVnd } from "@/lib/format"

export interface StoreSettings {
  slug: string; name: string; tagline: string | null; theme: "toi-gian" | "am-ap" | "soi-dong"; accent: string
  cover_url: string | null; logo_url: string | null
  phone: string | null; address: string | null; cod: boolean; bank_transfer: boolean; published: boolean; product_ids: number[]
}
export interface StoreOrder {
  id: number; code: string; status: string; customer_name: string; customer_phone: string; customer_address: string | null
  items: Array<{ name: string; quantity: number; price: number }>; total: number; payment_method: string; contact_id: number | null; created_at: string
}

const THEMES: ReadonlyArray<{ value: StoreSettings["theme"]; label: string; bg: string; ink: string }> = [
  { value: "toi-gian", label: "Tối giản", bg: "#fafafa", ink: "#16181d" },
  { value: "am-ap", label: "Ấm áp", bg: "#fbf6ef", ink: "#3b2a1a" },
  { value: "soi-dong", label: "Sôi động", bg: "#f4f1ff", ink: "#15121f" },
]
const STATUS: Record<string, { label: string; tone: ConnectionTone }> = {
  new: { label: "Mới", tone: "info" }, confirmed: { label: "Đã xác nhận", tone: "soon" }, paid: { label: "Đã thanh toán", tone: "connected" },
  shipped: { label: "Đang giao", tone: "soon" }, done: { label: "Hoàn tất", tone: "connected" }, cancelled: { label: "Đã huỷ", tone: "off" },
}
const vnd = (n: number) => formatVnd(n)
const when = (iso: string) => formatDateTimeShort(iso)

function StoreSettingsForm({ initial }: { initial: StoreSettings }) {
  const qc = useQueryClient()
  const [f, setF] = useState<StoreSettings>(initial)
  const [error, setError] = useState<string | null>(null)
  const products = useProducts({ is_active: true })
  const save = useMutation({
    mutationFn: async (b: StoreSettings) => (await apiClient.put<StoreSettings>("/store/settings", b)).data,
    onSuccess: (d) => { qc.setQueryData(["store", "settings"], d); toast.success(d.published ? "Đã lưu — trang đang mở bán" : "Đã lưu") },
  })
  const url = typeof window === "undefined" || !f.slug ? "" : `${window.location.origin}/s/${f.slug}`
  const sellable = (products.data ?? []).filter((p) => p.price != null)
  const toggle = (id: number) => setF({ ...f, product_ids: f.product_ids.includes(id) ? f.product_ids.filter((x) => x !== id) : [...f.product_ids, id] })
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try { await save.mutateAsync(f) } catch (err) { setError(apiErrorMessage(err, "Không lưu được")) }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <ConnectionGroup label="Trang của bạn">
        <div className="flex flex-col gap-5 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <StatusPill tone={initial.published ? "connected" : "off"}>{initial.published ? "Đang mở bán" : "Chưa mở bán"}</StatusPill>
              {initial.published && url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">Xem trang <ExternalLink className="size-3.5" /></a>}
            </div>
            <label className="flex items-center gap-2 text-sm font-medium">Mở bán <Switch checked={f.published} onCheckedChange={(v) => setF({ ...f, published: v })} aria-label="Mở bán" /></label>
          </div>
          <FieldGroup>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="st-name">Tên cửa hàng</FieldLabel>
                <Input id="st-name" maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="st-slug">Địa chỉ trang</FieldLabel>
                <Input id="st-slug" maxLength={40} placeholder="cua-hang-abc" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} />
                <FieldDescription className="flex flex-wrap items-center gap-2">{url ? <><span className="break-all">{url}</span><CopyButton value={url} label="Chép địa chỉ trang" /></> : "Chữ thường không dấu, số, gạch ngang."}</FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="st-tag">Câu giới thiệu</FieldLabel>
              <Input id="st-tag" maxLength={120} placeholder="vd Bánh nhà làm, giao trong ngày" value={f.tagline ?? ""} onChange={(e) => setF({ ...f, tagline: e.target.value })} />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="st-phone">Số điện thoại cửa hàng</FieldLabel>
                <Input id="st-phone" maxLength={20} value={f.phone ?? ""} onChange={(e) => setF({ ...f, phone: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="st-addr">Địa chỉ cửa hàng</FieldLabel>
                <Input id="st-addr" maxLength={200} value={f.address ?? ""} onChange={(e) => setF({ ...f, address: e.target.value })} />
              </Field>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="st-cover">Ảnh bìa (đường dẫn https)</FieldLabel>
                <Input id="st-cover" maxLength={500} placeholder="https://…" value={f.cover_url ?? ""} onChange={(e) => setF({ ...f, cover_url: e.target.value })} />
                <FieldDescription>Ảnh ngang, khoảng 1600×600. Để trống = nền màu chủ đạo.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="st-logo">Logo (đường dẫn https)</FieldLabel>
                <Input id="st-logo" maxLength={500} placeholder="https://…" value={f.logo_url ?? ""} onChange={(e) => setF({ ...f, logo_url: e.target.value })} />
              </Field>
            </div>
            <Field>
              <FieldLabel>Giao diện</FieldLabel>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Giao diện">
                {THEMES.map((th) => (
                  <button key={th.value} type="button" role="radio" aria-checked={f.theme === th.value} onClick={() => setF({ ...f, theme: th.value })}
                    className={cn("flex h-20 flex-col justify-between rounded-lg p-2.5 text-left text-[13px] font-medium ring-1 transition-shadow duration-150", f.theme === th.value ? "ring-2 ring-primary" : "ring-border hover:ring-foreground/30")}
                    style={{ background: th.bg, color: th.ink }}>
                    <span>{th.label}</span>
                    <span className="h-2 w-10 rounded-full" style={{ background: f.accent }} />
                  </button>
                ))}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="st-accent">Màu chủ đạo</FieldLabel>
              <div className="flex items-center gap-2"><input id="st-accent" type="color" value={f.accent} onChange={(e) => setF({ ...f, accent: e.target.value })} className="h-9 w-14 cursor-pointer rounded-md border border-input" /><span className="font-mono text-[13px] text-muted-foreground">{f.accent}</span></div>
            </Field>
            <Field>
              <FieldLabel>Cách thanh toán</FieldLabel>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.cod} onChange={() => setF({ ...f, cod: !f.cod })} /> Trả tiền khi nhận hàng (COD)</label>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.bank_transfer} onChange={() => setF({ ...f, bank_transfer: !f.bank_transfer })} /> Chuyển khoản QR — tự khớp tiền về (cần kết nối SePay)</label>
            </Field>
          </FieldGroup>
        </div>
      </ConnectionGroup>

      <ConnectionGroup label={`Sản phẩm trên trang (${f.product_ids.length})`}>
        {products.isLoading ? <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải…</div>
          : sellable.length === 0 ? <p className="p-4 text-[13px] text-muted-foreground">Chưa có sản phẩm nào có giá. Thêm ở menu Sản phẩm rồi quay lại chọn.</p>
          : sellable.map((p) => (
            <label key={p.id} className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2 text-sm">
              <Checkbox checked={f.product_ids.includes(p.id)} onChange={() => toggle(p.id)} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="tabular-nums text-muted-foreground">{vnd(Number(p.price))}</span>
            </label>
          ))}
      </ConnectionGroup>

      {error && <FieldError>{error}</FieldError>}
      <div className="flex justify-end"><Button type="submit" disabled={save.isPending} className="max-sm:w-full">{save.isPending && <Loader2 className="size-4 animate-spin" />} Lưu</Button></div>
    </form>
  )
}

function StoreOrders() {
  const qc = useQueryClient()
  const { can } = usePermissions()
  const orders = useQuery<StoreOrder[]>({ queryKey: ["store", "orders"], queryFn: async () => (await apiClient.get<StoreOrder[]>("/store/orders")).data, refetchInterval: 20_000 })
  const update = useMutation({
    mutationFn: async (b: { id: number; status: string }) => (await apiClient.patch(`/store/orders/${b.id}`, { status: b.status })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["store", "orders"] }),
  })
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-[13px] font-medium text-muted-foreground">Đơn từ trang bán hàng</h3>
      {orders.isLoading ? <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải…</div>
        : orders.isError ? <p role="alert" className="px-1 text-sm text-destructive">Không tải được đơn.</p>
        : !orders.data?.length ? <EmptyState icon={StoreIcon} title="Chưa có đơn nào" message="Mở bán và gửi địa chỉ trang cho khách — đơn mới hiện ở đây và trong lịch sử khách." />
        : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/8 shadow-[var(--shadow-card)]">
            {orders.data.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{vnd(o.total)} · <span className="font-mono">{o.code}</span> <span className="font-normal text-muted-foreground">· {o.payment_method === "cod" ? "COD" : "chuyển khoản"}</span></span>
                  <span className="truncate text-[13px] text-muted-foreground">{o.customer_name} · {o.customer_phone}{o.customer_address ? ` · ${o.customer_address}` : ""} · {o.items.map((i) => `${i.name} ×${i.quantity}`).join(", ")} · {when(o.created_at)}</span>
                </span>
                {o.contact_id ? <a href={`/contacts/${o.contact_id}`} className="text-[13px] font-medium text-primary hover:underline">Xem khách</a> : null}
                {can("deals.manage") ? (
                  <select aria-label={`Trạng thái đơn ${o.code}`} value={o.status} disabled={update.isPending} onChange={(e) => update.mutate({ id: o.id, status: e.target.value }, { onError: (err) => toast.error(apiErrorMessage(err, "Không đổi được trạng thái")) })}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-[13px] max-sm:h-11">
                    {Object.entries(STATUS).map(([v, s]) => <option key={v} value={v}>{s.label}</option>)}
                  </select>
                ) : <StatusPill tone={STATUS[o.status]?.tone ?? "off"}>{STATUS[o.status]?.label ?? o.status}</StatusPill>}
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

/** Cài đặt › Kết nối & AI › Trang bán hàng. */
export function StorePanel() {
  const { can } = usePermissions()
  const settings = useQuery<StoreSettings>({ queryKey: ["store", "settings"], enabled: can("pos.manage"), queryFn: async () => (await apiClient.get<StoreSettings>("/store/settings")).data })
  return (
    <div className="flex flex-col gap-6">
      {can("pos.manage") && (settings.isLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải…</div>
        : settings.isError ? <p role="alert" className="text-sm text-destructive">{apiErrorMessage(settings.error, "Không đọc được cấu hình trang")}</p>
        : settings.data ? <StoreSettingsForm key={JSON.stringify(settings.data)} initial={settings.data} /> : null)}
      {can("deals.view") && <StoreOrders />}
    </div>
  )
}
