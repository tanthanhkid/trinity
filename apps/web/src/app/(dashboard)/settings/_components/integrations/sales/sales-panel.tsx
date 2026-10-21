"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, RefreshCw, ShoppingBag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { ConnectionGroup, ConnectionLogo, ConnectionRow, StatusPill } from "@/components/ui/connection-row"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { usePermissions } from "@/lib/rbac"
import { cn } from "@/lib/utils"
import { apiErrorMessage } from "../webhook-types"
import type { ConnectorStatus } from "../payments/use-payments"
import {
  useDisconnectShop, useMarketConnect, useMarketDisconnect, useMarketSync, useSalesConnectors, useSalesRecords, useSaveShop, useSyncShop,
  type MarketProvider, type ShopProvider, type SyncResult,
} from "./use-sales"
import { formatDateTimeShort, formatVnd } from "@/lib/format"

const vnd = (n: number | null) => formatVnd(n)
const when = (iso: string) => formatDateTimeShort(iso)
const summary = (r: SyncResult) =>
  [r.added.customers != null ? `${r.added.customers} khách` : null, r.added.invoices != null ? `${r.added.invoices} hoá đơn` : null, r.added.orders != null ? `${r.added.orders} đơn` : null, r.added.products != null ? `${r.added.products} hàng hoá` : null, r.added.items != null ? `${r.added.items} hàng hoá` : null]
    .filter(Boolean).join(", ") + (r.more ? " — còn nữa, bấm Đồng bộ để lấy tiếp" : "")

/** Cấu hình từng phần mềm bán hàng: ô nhập, chỗ lấy khoá, nhãn. */
const SHOPS: Record<ShopProvider, {
  title: string; color: string; text: string; desc: string; help: string; secretKey: string; note: string
  fields: ReadonlyArray<{ key: string; label: string; placeholder?: string; hint?: string; secret?: boolean; settingsKey?: string }>
}> = {
  kiotviet: {
    title: "KiotViet", color: "#2563eb", text: "K", desc: "Khách, đơn, hoá đơn, hàng hoá từ máy bán hàng",
    help: "Lấy ở KiotViet: Thiết lập › Thiết lập kết nối API. Trinity tự đăng ký webhook và lấy dữ liệu 90 ngày gần nhất.",
    secretKey: "client_secret", note: "Chưa thử với tài khoản thật — đã thử bằng dữ liệu mẫu theo tài liệu KiotViet",
    fields: [
      { key: "retailer", label: "Tên gian hàng", placeholder: "vd cuahangabc", hint: "Phần trước .kiotviet.vn trong địa chỉ đăng nhập.", settingsKey: "retailer" },
      { key: "client_id", label: "Client ID", settingsKey: "client_id" },
      { key: "client_secret", label: "Mã bảo mật (Client Secret)", secret: true },
    ],
  },
  misa: {
    title: "MISA AMIS Kế toán", color: "#0369a1", text: "MI", desc: "Khách hàng (đối tượng) và hàng hoá từ phần mềm kế toán",
    help: "Lấy mã kết nối ở AMIS Kế toán: Thiết lập › Kết nối ứng dụng. MISA không gửi tự động — bấm Đồng bộ để lấy dữ liệu mới.",
    secretKey: "access_code", note: "Chưa thử với tài khoản thật — đã thử bằng dữ liệu mẫu",
    fields: [
      { key: "company_code", label: "Mã công ty", hint: "Mã công ty trong AMIS Kế toán.", settingsKey: "company_code" },
      { key: "access_code", label: "Mã kết nối", secret: true },
    ],
  },
  woocommerce: {
    title: "WooCommerce", color: "#7f54b3", text: "W", desc: "Khách, đơn, sản phẩm từ web bán hàng WordPress",
    help: "Tạo khoá ở WordPress: WooCommerce › Cài đặt › Nâng cao › REST API › Thêm khoá (quyền Đọc/Ghi). Trinity tự đăng ký webhook và lấy dữ liệu 90 ngày gần nhất.",
    secretKey: "consumer_secret", note: "Đã thử với cửa hàng WooCommerce thử (15/10/2026); chưa thử cửa hàng thật của khách",
    fields: [
      { key: "url", label: "Địa chỉ cửa hàng", placeholder: "https://shop.example.com", hint: "Phải là https.", settingsKey: "url" },
      { key: "consumer_key", label: "Consumer key", placeholder: "ck_…" },
      { key: "consumer_secret", label: "Consumer secret", placeholder: "cs_…", secret: true },
    ],
  },
  sapo: {
    title: "Sapo", color: "#0ea5e9", text: "S", desc: "Khách, đơn, hàng hoá từ cửa hàng Sapo",
    help: "Lấy ở Sapo: Ứng dụng › Ứng dụng riêng › Tạo ứng dụng (quyền đọc khách hàng, đơn hàng, sản phẩm). Trinity tự đăng ký webhook và lấy dữ liệu 90 ngày gần nhất.",
    secretKey: "secret", note: "Chưa thử với tài khoản thật — đã thử bằng dữ liệu mẫu",
    fields: [
      { key: "store", label: "Tên cửa hàng", placeholder: "vd cuahangabc", hint: "Phần trước .mysapo.net.", settingsKey: "store" },
      { key: "api_key", label: "API key" },
      { key: "secret", label: "Mật khẩu (API secret)", secret: true },
    ],
  },
}

function ShopDialog({ provider, current, onClose }: { provider: ShopProvider; current: Record<string, unknown> | null; onClose: () => void }) {
  const shop = SHOPS[provider]
  const save = useSaveShop(provider)
  const [f, setF] = useState<Record<string, string>>(Object.fromEntries(shop.fields.map((x) => [x.key, x.settingsKey && typeof current?.[x.settingsKey] === "string" ? String(current[x.settingsKey]) : ""])))
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const out = await save.mutateAsync({ ...f, [shop.secretKey]: f[shop.secretKey] || undefined })
      if ("error" in out.first_sync) toast.warning(`Đã kết nối, nhưng đồng bộ lần đầu lỗi: ${out.first_sync.error}`)
      else toast.success(`Đã kết nối ${shop.title} — lấy về ${summary(out.first_sync)}`)
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, `Không kết nối được ${shop.title}`))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{current ? `Sửa kết nối ${shop.title}` : `Kết nối ${shop.title}`}</DialogTitle>
            <DialogDescription>{shop.help}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {shop.fields.map((x) => (
              <Field key={x.key}>
                <FieldLabel htmlFor={`${provider}-${x.key}`}>{x.label}</FieldLabel>
                <Input
                  id={`${provider}-${x.key}`}
                  type={x.secret ? "password" : "text"}
                  autoComplete="off"
                  placeholder={x.secret && current ? "Để trống = giữ khoá cũ" : x.placeholder}
                  value={f[x.key] ?? ""}
                  onChange={(e) => setF({ ...f, [x.key]: e.target.value })}
                  required={!x.secret || !current}
                />
                {x.hint && <FieldDescription>{x.hint}</FieldDescription>}
              </Field>
            ))}
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Huỷ</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending && <Loader2 className="size-4 animate-spin" />} {save.isPending ? "Đang kiểm khoá…" : "Kết nối"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ShopRow({ provider, conn, canManage }: { provider: ShopProvider; conn: ConnectorStatus | undefined; canManage: boolean }) {
  const shop = SHOPS[provider]
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const sync = useSyncShop(provider)
  const disconnect = useDisconnectShop(provider)
  const on = !!conn?.connected
  const s = (conn?.settings ?? null) as (Record<string, unknown> & { counts?: Record<string, number>; last_sync_at?: string | null; webhook_error?: string | null }) | null
  const c = s?.counts ?? {}
  const label = typeof s?.url === "string" ? s.url.replace(/^https:\/\//, "") : typeof s?.company_code === "string" ? s.company_code : typeof s?.retailer === "string" ? s.retailer : typeof s?.store_name === "string" && s.store_name ? s.store_name : typeof s?.store === "string" ? s.store : null
  const parts = [c.items != null ? `${c.items} hàng` : null, c.customers != null ? `${c.customers} khách` : null, c.invoices != null ? `${c.invoices} hoá đơn` : null, c.orders != null ? `${c.orders} đơn` : null, c.products != null ? `${c.products} hàng` : null].filter(Boolean).join(" · ")
  const detail = on ? [label, parts || "chưa có dữ liệu", s?.last_sync_at ? `đồng bộ ${when(s.last_sync_at)}` : null].filter(Boolean).join(" · ") : shop.desc
  return (
    <>
      <ConnectionRow
        testId={`conn-${provider}`}
        logo={<ConnectionLogo brand={provider} color={shop.color} text={shop.text} />}
        title={shop.title}
        description={detail}
        status={<StatusPill tone={!on ? "off" : conn?.last_error ? "warning" : "connected"}>{!on ? "Chưa kết nối" : conn?.last_error ? "Có lỗi" : "Đã kết nối"}</StatusPill>}
        note={conn?.server_configured === false ? "Máy chủ chưa đặt MISA_APP_ID (mã ứng dụng đối tác MISA cấp) — quản trị hệ thống cần đặt rồi khởi động lại" : on && s?.webhook_error ? `Chưa nhận tự động: ${s.webhook_error}` : shop.note}
        action={canManage ? (
          on ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={sync.isPending} onClick={async () => {
                try { toast.success(`Đã đồng bộ: ${summary(await sync.mutateAsync())}`) } catch (err) { toast.error(apiErrorMessage(err, "Đồng bộ lỗi")) }
              }}>
                <RefreshCw className={cn("size-4", sync.isPending && "animate-spin")} /> Đồng bộ
              </Button>
              <Button variant="outline" onClick={() => setEditing(true)}>Sửa</Button>
              <Button variant="outline" onClick={() => setConfirm(true)}>Ngắt</Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setEditing(true)} disabled={conn?.secret_key_configured === false || conn?.server_configured === false}>Kết nối</Button>
          )
        ) : null}
      />
      {conn?.last_error && on && <p className="px-4 pb-3 text-[13px] text-[var(--color-app-tag-amber-ink)]">{conn.last_error}</p>}
      {editing && <ShopDialog provider={provider} current={on ? s : null} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Ngắt kết nối ${shop.title}?`}
        description="Trinity gỡ webhook và thôi đồng bộ. Khách, đơn đã lấy về vẫn giữ trong CRM."
        confirmLabel="Ngắt kết nối"
        pending={disconnect.isPending}
        onConfirm={async () => {
          try { await disconnect.mutateAsync(); toast.success(`Đã ngắt ${shop.title}`); setConfirm(false) } catch (err) { toast.error(apiErrorMessage(err, "Không ngắt được")) }
        }}
      />
    </>
  )
}

const MARKETS: Record<MarketProvider, { title: string; color: string; text: string; desc: string; env: string }> = {
  shopee: { title: "Shopee", color: "#ee4d2d", text: "Sh", desc: "Đơn hàng trên sàn Shopee", env: "SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY" },
  lazada: { title: "Lazada", color: "#0f146d", text: "L", desc: "Đơn hàng trên sàn Lazada", env: "LAZADA_APP_KEY / LAZADA_APP_SECRET" },
}

/** Sàn TMĐT: chủ shop cấp quyền trên trang của sàn (không dán khoá). Chat người mua: sàn chỉ mở cho đối tác được duyệt — chưa có. */
function MarketRow({ provider, conn, canManage }: { provider: MarketProvider; conn: ConnectorStatus | undefined; canManage: boolean }) {
  const m = MARKETS[provider]
  const connect = useMarketConnect(provider)
  const sync = useMarketSync(provider)
  const disconnect = useDisconnectMarket(provider)
  const [confirm, setConfirm] = useState(false)
  const on = !!conn?.connected
  const s = (conn?.settings ?? null) as { shop_id?: number; seller_id?: string; counts?: { orders?: number }; last_sync_at?: string | null } | null
  const detail = on ? [s?.shop_id ? `Shop ${s.shop_id}` : s?.seller_id ? `Seller ${s.seller_id}` : null, `${s?.counts?.orders ?? 0} đơn`, s?.last_sync_at ? `đồng bộ ${when(s.last_sync_at)}` : null].filter(Boolean).join(" · ") : m.desc
  const notConfigured = conn?.server_configured === false
  return (
    <>
      <ConnectionRow
        testId={`conn-${provider}`}
        logo={<ConnectionLogo brand={provider} color={m.color} text={m.text} />}
        title={m.title}
        description={detail}
        status={<StatusPill tone={notConfigured ? "off" : !on ? "off" : conn?.last_error ? "warning" : "connected"}>{notConfigured ? "Máy chủ chưa cấu hình" : !on ? "Chưa kết nối" : conn?.last_error ? "Có lỗi" : "Đã kết nối"}</StatusPill>}
        note={notConfigured ? `Cần app đối tác ${m.title} của Trinity (${m.env}) — chưa có shop thật để thử` : "Chưa có shop thật — đã thử bằng dữ liệu mẫu theo tài liệu Open Platform"}
        action={canManage ? (
          on ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={sync.isPending} onClick={async () => {
                try { toast.success(`Đã đồng bộ: ${summary(await sync.mutateAsync())}`) } catch (err) { toast.error(apiErrorMessage(err, "Đồng bộ lỗi")) }
              }}>
                <RefreshCw className={cn("size-4", sync.isPending && "animate-spin")} /> Đồng bộ
              </Button>
              <Button variant="outline" onClick={() => setConfirm(true)}>Ngắt</Button>
            </div>
          ) : (
            <Button variant="outline" disabled={notConfigured || connect.isPending} onClick={async () => {
              try { window.location.href = await connect.mutateAsync() } catch (err) { toast.error(apiErrorMessage(err, `Không mở được trang cấp quyền ${m.title}`)) }
            }}>{connect.isPending && <Loader2 className="size-4 animate-spin" />} Kết nối</Button>
          )
        ) : null}
      />
      {conn?.last_error && on && <p className="px-4 pb-3 text-[13px] text-[var(--color-app-tag-amber-ink)]">{conn.last_error}</p>}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Ngắt kết nối ${m.title}?`}
        description="Trinity thôi đồng bộ đơn. Đơn đã lấy về vẫn giữ trong CRM."
        confirmLabel="Ngắt kết nối"
        pending={disconnect.isPending}
        onConfirm={async () => {
          try { await disconnect.mutateAsync(); toast.success(`Đã ngắt ${m.title}`); setConfirm(false) } catch (err) { toast.error(apiErrorMessage(err, "Không ngắt được")) }
        }}
      />
    </>
  )
}
const useDisconnectMarket = useMarketDisconnect

function RecentInvoices() {
  const invoices = useSalesRecords("invoice")
  const orders = useSalesRecords("order")
  const inv = { isLoading: invoices.isLoading || orders.isLoading, isError: invoices.isError && orders.isError, data: [...(invoices.data ?? []), ...(orders.data ?? [])].sort((a, b) => (b.external_updated_at ?? "").localeCompare(a.external_updated_at ?? "")).slice(0, 30) }
  if (inv.isLoading) return <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải…</div>
  if (inv.isError) return <p role="alert" className="px-1 text-sm text-destructive">Không tải được hoá đơn.</p>
  if (!inv.data?.length) return <EmptyState icon={ShoppingBag} title="Chưa có đơn nào" message="Kết nối KiotViet hoặc Sapo để đơn, hoá đơn hiện ở đây và trong lịch sử từng khách." />
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/8 shadow-[var(--shadow-card)]">
      {inv.data.map((r) => (
        <li key={r.id} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
          <ShoppingBag className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{vnd(r.amount)} · <span className="font-mono">{r.code ?? r.external_id}</span> <span className="font-normal text-muted-foreground">· {SHOPS[r.provider as ShopProvider]?.title ?? r.provider}</span></span>
            <span className="truncate text-[13px] text-muted-foreground">
              {r.name || "Khách lẻ"}{r.data.items?.length ? ` · ${r.data.items.slice(0, 2).map((i) => `${i.name} ×${i.quantity}`).join(", ")}` : ""}{r.external_updated_at ? ` · ${when(r.external_updated_at)}` : ""}
            </span>
          </span>
          {r.contact_id ? <a href={`/contacts/${r.contact_id}`} className="shrink-0 text-[13px] font-medium text-primary hover:underline">Xem khách</a> : null}
          {r.status && <StatusPill tone={r.status === "removed" ? "off" : "soon"}>{r.status === "removed" ? "Đã xoá" : r.status}</StatusPill>}
        </li>
      ))}
    </ul>
  )
}

/** Cài đặt › Kết nối & AI › Bán hàng: phần mềm bán hàng (KiotViet…) + hoá đơn đã đồng bộ. */
export function SalesPanel() {
  const { can } = usePermissions()
  const canManage = can("integrations.webhooks")
  const conns = useSalesConnectors(canManage)
  const params = useSearchParams()
  // Sàn chuyển về sau khi cấp quyền: ?ket_noi=ok|loi&ly_do=…
  useEffect(() => {
    const r = params.get("ket_noi")
    if (r === "ok") toast.success("Đã kết nối shop. Trinity đang lấy đơn về.")
    else if (r === "loi") toast.error(params.get("ly_do") || "Cấp quyền không thành công.")
  }, [params])
  return (
    <div className="flex flex-col gap-6">
      {canManage && (conns.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang kiểm tra kết nối…</div>
      ) : conns.isError ? (
        <p role="alert" className="text-sm text-destructive">{apiErrorMessage(conns.error, "Không đọc được trạng thái kết nối")}</p>
      ) : (
        <ConnectionGroup label="Phần mềm bán hàng">
          <ShopRow provider="kiotviet" conn={conns.data?.find((x) => x.provider === "kiotviet")} canManage={canManage} />
          <ShopRow provider="sapo" conn={conns.data?.find((x) => x.provider === "sapo")} canManage={canManage} />
          <ShopRow provider="woocommerce" conn={conns.data?.find((x) => x.provider === "woocommerce")} canManage={canManage} />
        </ConnectionGroup>
      ))}
      {canManage && conns.data && (
        <ConnectionGroup label="Sàn thương mại điện tử">
          <MarketRow provider="shopee" conn={conns.data.find((x) => x.provider === "shopee")} canManage={canManage} />
          <MarketRow provider="lazada" conn={conns.data.find((x) => x.provider === "lazada")} canManage={canManage} />
        </ConnectionGroup>
      )}
      {canManage && conns.data && (
        <ConnectionGroup label="Phần mềm kế toán">
          <ShopRow provider="misa" conn={conns.data.find((x) => x.provider === "misa")} canManage={canManage} />
        </ConnectionGroup>
      )}
      {can("deals.view") && (
        <section className="flex flex-col gap-2">
          <h3 className="px-1 text-[13px] font-medium text-muted-foreground">Đơn và hoá đơn gần đây</h3>
          <RecentInvoices />
        </section>
      )}
    </div>
  )
}
