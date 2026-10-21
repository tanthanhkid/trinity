"use client"

import type { ReactNode } from "react"
import { AlertTriangle, Blocks, Bot, FileSpreadsheet, History, Webhook } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BrandKey } from "@/lib/brand-logos"
import { ConnectionGroup, ConnectionLogo, ConnectionRow, StatusPill, type ConnectionTone } from "@/components/ui/connection-row"
import { STATUS_LABEL } from "@/components/ui/status-tag"
import { useFacebookPages, useFacebookStatus } from "./use-facebook"
import { useZaloOaStatus } from "./zalo-oa/use-zalo-oa"
import { useGoogleStatus } from "./use-google-sheets"
import { useAiConnections } from "./use-ai-connections"
import { useInboundSources, useWebhookEndpoints } from "./use-webhooks"
import { useConnectors } from "./payments/use-payments"
import { useSalesConnectors } from "./sales/use-sales"
import type { IntegrationSection, IntegrationsStatus } from "./integrations-meta"

type Open = (s: IntegrationSection) => void
const httpStatus = (e: unknown) => (e as { response?: { status?: number } } | null)?.response?.status
interface RowState {
  tone: ConnectionTone
  label: string
  detail?: string
}

/** Mức đã thử thật — khớp `docs/integrations/status.md` của repo. */
const TESTED: Partial<Record<IntegrationSection, string>> = {
  facebook: "Đã thử với tài khoản thật (13/10/2026)",
  "zalo-oa": "Nhận tin đã thử thật (15/10/2026); trả lời + đọc hồ sơ cần OA gói Tier (chưa thử)",
  payments: "Chưa thử với tài khoản thật — đã thử bằng dữ liệu mẫu của SePay",
  "ban-hang": "Chưa thử với tài khoản thật — đã thử bằng dữ liệu mẫu",
}

function Row({ section, open, logo, title, description, state, connectLabel = "Kết nối" }: {
  section: IntegrationSection
  open: Open
  logo: ReactNode
  title: string
  description: string
  state: RowState | null
  connectLabel?: string
}) {
  const connected = state?.tone === "connected" || state?.tone === "warning"
  // Máy chủ chưa cấu hình / tính năng tắt ⇒ mở mục để xem hướng dẫn, không mời "Kết nối" khi chưa kết nối được.
  const blocked = state?.tone === "off" && state.label !== "Chưa kết nối" && state.label !== "Chưa có"
  return (
    <ConnectionRow
      testId={`conn-${section}`}
      logo={logo}
      title={title}
      description={state?.detail ? `${description} · ${state.detail}` : description}
      status={state ? <StatusPill tone={state.tone}>{state.label}</StatusPill> : <StatusPill tone="off">Đang kiểm tra…</StatusPill>}
      note={TESTED[section]}
      action={
        <Button variant="outline" onClick={() => open(section)}>
          {connected ? "Quản lý" : blocked ? "Xem cách bật" : connectLabel}
        </Button>
      }
    />
  )
}

function FacebookRow({ open }: { open: Open }) {
  const status = useFacebookStatus(true)
  const pages = useFacebookPages(status.data?.configured === true)
  let state: RowState | null = null
  if (status.isError) state = { tone: "warning", label: "Không đọc được trạng thái" }
  else if (status.data && !status.data.configured) state = { tone: "off", label: "Máy chủ chưa cấu hình" }
  else if (pages.data) {
    const active = pages.data.filter((p) => p.is_active)
    const broken = active.filter((p) => p.token_status === "expired" || p.token_status === "invalid")
    state = active.length === 0
      ? { tone: "off", label: "Chưa kết nối" }
      : broken.length > 0
        ? { tone: "warning", label: STATUS_LABEL.reauth, detail: `${active.length} Fanpage` }
        : { tone: "connected", label: "Đã kết nối", detail: active.length === 1 ? active[0].name : `${active.length} Fanpage` }
  }
  return <Row section="facebook" open={open} logo={<ConnectionLogo brand="facebook" color="#1877F2" text="f" />} title="Fanpage Facebook" description="Tin nhắn Messenger, bình luận, gửi hàng loạt" state={state} />
}

function ZaloRow({ open }: { open: Open }) {
  const s = useZaloOaStatus()
  let state: RowState | null = null
  // 403 = tính năng Zalo OA của tổ chức đang tắt / ngoài gói — không phải lỗi.
  if (s.isError) state = httpStatus(s.error) === 403 ? { tone: "off", label: "Tính năng đang tắt" } : { tone: "warning", label: "Không đọc được trạng thái" }
  else if (s.data) {
    state = !s.data.configured
      ? { tone: "off", label: "Máy chủ chưa cấu hình" }
      : s.data.connected && s.data.status === "active"
        ? { tone: "connected", label: "Đã kết nối" }
        : s.data.status === "needs_reauth"
          ? { tone: "warning", label: STATUS_LABEL.reauth }
          : { tone: "off", label: "Chưa kết nối" }
  }
  return <Row section="zalo-oa" open={open} logo={<ConnectionLogo brand="zalo" color="#0068FF" text="Z" />} title="Zalo Official Account" description="Hộp thư Zalo OA và thông báo ZNS" state={state} />
}

function GoogleRow({ open }: { open: Open }) {
  const s = useGoogleStatus()
  let state: RowState | null = null
  if (s.isError) state = { tone: "warning", label: "Không đọc được trạng thái" }
  else if (s.data) {
    const c = s.data.connection
    state = !s.data.configured
      ? { tone: "off", label: "Máy chủ chưa cấu hình" }
      : c && c.status === "active"
        ? { tone: "connected", label: "Đã kết nối", detail: c.email ?? undefined }
        : c
          ? { tone: "warning", label: STATUS_LABEL.reauth }
          : { tone: "off", label: "Chưa kết nối" }
  }
  return <Row section="google-sheets" open={open} logo={<ConnectionLogo brand="google_sheets" color="#0F9D58" icon={<FileSpreadsheet />} />} title="Google Sheets" description="Đồng bộ khách từ bảng tính" state={state} />
}

function AiRow({ open, enabled }: { open: Open; enabled: boolean | undefined }) {
  const s = useAiConnections(false, enabled === true)
  let state: RowState | null = null
  if (enabled === false) state = { tone: "off", label: "Chưa bật trên máy chủ" }
  else if (enabled === undefined) state = null
  else if (s.isError) state = { tone: "warning", label: "Không đọc được trạng thái" }
  else if (s.data) state = s.data.length ? { tone: "connected", label: `${s.data.length} trợ lý đã kết nối` } : { tone: "off", label: "Chưa kết nối" }
  return <Row section="ai" open={open} logo={<ConnectionLogo color="#17181c" icon={<Bot />} />} title="Trợ lý AI" description="ChatGPT, Claude, Gemini… làm việc thay bạn trong Trinity" state={state} />
}

function WebhookOutRow({ open, enabled }: { open: Open; enabled: boolean | undefined }) {
  const s = useWebhookEndpoints(enabled === true)
  let state: RowState | null = null
  if (enabled === false) state = { tone: "off", label: "Chưa bật trên máy chủ" }
  else if (enabled === undefined) state = null
  else if (s.isError) state = { tone: "warning", label: "Không đọc được trạng thái" }
  else if (s.data) state = s.data.length ? { tone: "connected", label: `${s.data.length} địa chỉ nhận` } : { tone: "off", label: "Chưa có" }
  return <Row section="webhook-out" open={open} logo={<ConnectionLogo color="#6d28d9" icon={<Webhook />} />} title="Webhook ra" description="Báo sự kiện (khách mới, deal…) sang hệ thống khác" state={state} connectLabel="Thêm" />
}

function WebhookInRow({ open, enabled }: { open: Open; enabled: boolean | undefined }) {
  const s = useInboundSources(enabled === true)
  let state: RowState | null = null
  if (enabled === false) state = { tone: "off", label: "Chưa bật trên máy chủ" }
  else if (enabled === undefined) state = null
  else if (s.isError) state = { tone: "warning", label: "Không đọc được trạng thái" }
  else if (s.data) state = s.data.length ? { tone: "connected", label: `${s.data.length} nguồn` } : { tone: "off", label: "Chưa có" }
  return <Row section="webhook-in" open={open} logo={<ConnectionLogo color="#0e7490" icon={<Webhook />} />} title="Webhook vào" description="Nhận khách từ form web, landing page, Zapier" state={state} connectLabel="Thêm" />
}

function SepayRow({ open }: { open: Open }) {
  const c = useConnectors()
  const sepay = c.data?.find((x) => x.provider === "sepay")
  let state: RowState | null = null
  // 403 = tính năng Thanh toán của tổ chức đang tắt — không phải lỗi.
  if (c.isError) state = httpStatus(c.error) === 403 ? { tone: "off", label: "Tính năng đang tắt" } : { tone: "warning", label: "Không đọc được trạng thái" }
  else if (sepay) {
    state = !sepay.connected
      ? { tone: "off", label: "Chưa kết nối" }
      : sepay.last_error
        ? { tone: "warning", label: "Có lỗi" }
        : { tone: "connected", label: "Đã kết nối", detail: sepay.settings?.bank ? `${sepay.settings.bank} · ${sepay.settings.account_number}` : undefined }
  }
  return <Row section="payments" open={open} logo={<ConnectionLogo brand="sepay" color="#1d4ed8" text="SP" />} title="SePay" description="Tự khớp tiền chuyển khoản, tạo mã QR thanh toán" state={state} />
}

function GatewayOverviewRow({ open, provider, title, color, text, description }: { open: Open; provider: "vnpay" | "momo"; title: string; color: string; text: string; description: string }) {
  const c = useConnectors()
  const conn = c.data?.find((x) => x.provider === provider)
  let state: RowState | null = null
  if (c.isError) state = httpStatus(c.error) === 403 ? { tone: "off", label: "Tính năng đang tắt" } : { tone: "warning", label: "Không đọc được trạng thái" }
  else if (c.data) {
    state = !conn?.connected
      ? { tone: "off", label: "Chưa kết nối" }
      : conn.last_error
        ? { tone: "warning", label: "Có lỗi" }
        : { tone: "connected", label: "Đã kết nối", detail: conn.settings?.sandbox ? "môi trường thử" : undefined }
  }
  return (
    <ConnectionRow
      testId={`conn-${provider}`}
      logo={<ConnectionLogo brand={provider} color={color} text={text} />}
      title={title}
      description={state?.detail ? `${description} · ${state.detail}` : description}
      status={state ? <StatusPill tone={state.tone}>{state.label}</StatusPill> : <StatusPill tone="off">Đang kiểm tra…</StatusPill>}
      note={provider === "momo" ? "Đã thử với môi trường thử của MoMo; chưa thử tài khoản thật" : "Đã thử trên sandbox VNPay (15/10/2026); chưa thử tài khoản thật"}
      action={<Button variant="outline" onClick={() => open("payments")}>{state?.tone === "connected" || state?.tone === "warning" ? "Quản lý" : "Kết nối"}</Button>}
    />
  )
}

function ShopOverviewRow({ open, provider, title, color, text, description }: { open: Open; provider: "kiotviet" | "sapo" | "misa" | "woocommerce" | "shopee" | "lazada"; title: string; color: string; text: string; description: string }) {
  const c = useSalesConnectors()
  const conn = c.data?.find((x) => x.provider === provider)
  let state: RowState | null = null
  if (c.isError) state = httpStatus(c.error) === 403 ? { tone: "off", label: "Tính năng đang tắt" } : { tone: "warning", label: "Không đọc được trạng thái" }
  else if (c.data && conn?.server_configured === false) state = { tone: "off", label: "Máy chủ chưa cấu hình" }
  else if (c.data) state = !conn?.connected ? { tone: "off", label: "Chưa kết nối" } : conn.last_error ? { tone: "warning", label: "Có lỗi" } : { tone: "connected", label: "Đã kết nối", detail: typeof conn.settings?.retailer === "string" ? conn.settings.retailer : typeof conn.settings?.store === "string" ? conn.settings.store : typeof conn.settings?.url === "string" ? conn.settings.url.replace(/^https:\/\//, "") : undefined }
  return <Row section="ban-hang" open={open} logo={<ConnectionLogo brand={provider} color={color} text={text} />} title={title} description={description} state={state} />
}

/** Connector đang làm — hiện để khách biết sắp có, nhãn rõ chưa thử với tài khoản thật. */
const COMING: ReadonlyArray<{ name: string; desc: string; color: string; text: string; brand?: BrandKey }> = [
  { name: "iPOS", desc: "Khách, đơn từ máy bán hàng F&B", color: "#ea580c", text: "iP", brand: "ipos" },
]

/**
 * Tổng quan Kết nối & AI: mỗi kênh một dòng (logo · tên · trạng thái · nút). Chỉ hiện dòng của mục người dùng
 * được thấy (`visible`); bấm nút mở thẳng mục đó.
 */
export function IntegrationsOverview({ visible, status, statusError, open, auditVisible, canPayConnect = false }: {
  visible: ReadonlySet<IntegrationSection>
  /** Có quyền cấu hình connector (`integrations.webhooks`) — dòng SePay gọi `GET /connectors` cần quyền này. */
  canPayConnect?: boolean
  status: IntegrationsStatus | undefined
  statusError?: boolean
  open: Open
  auditVisible: boolean
}) {
  // undefined = chưa biết (đang tải / lỗi) — dòng hiện "Đang kiểm tra…", không kết luận "chưa bật".
  const hooks = status?.webhooks_enabled
  const mcp = status?.mcp_enabled
  const channels = visible.has("facebook") || visible.has("zalo-oa")
  const data = visible.has("google-sheets") || visible.has("webhook-out") || visible.has("webhook-in") || visible.has("extensions")
  return (
    <div className="flex flex-col gap-6">
      {statusError && (
        <p role="alert" className="flex items-center gap-2 rounded-lg bg-[var(--color-app-tag-amber-bg)] px-3 py-2 text-sm text-[var(--color-app-tag-amber-ink)]">
          <AlertTriangle className="size-4 shrink-0" aria-hidden /> Không đọc được trạng thái kết nối. Vui lòng thử lại.
        </p>
      )}
      {channels && (
        <ConnectionGroup label="Kênh trò chuyện với khách">
          {visible.has("facebook") && <FacebookRow open={open} />}
          {visible.has("zalo-oa") && <ZaloRow open={open} />}
        </ConnectionGroup>
      )}
      {visible.has("ai") && (
        <ConnectionGroup label="Trợ lý AI">
          <AiRow open={open} enabled={mcp} />
        </ConnectionGroup>
      )}
      {visible.has("payments") && canPayConnect && (
        <ConnectionGroup label="Thanh toán">
          <SepayRow open={open} />
          <GatewayOverviewRow open={open} provider="vnpay" title="VNPay" color="#e11d48" text="VN" description="Link thanh toán thẻ ATM, Visa/Master, QR ngân hàng" />
          <GatewayOverviewRow open={open} provider="momo" title="MoMo" color="#a50064" text="M" description="Link thanh toán ví MoMo" />
        </ConnectionGroup>
      )}
      {visible.has("ban-hang") && canPayConnect && (
        <ConnectionGroup label="Bán hàng">
          <ShopOverviewRow open={open} provider="kiotviet" title="KiotViet" color="#2563eb" text="K" description="Khách, đơn, hoá đơn, hàng hoá từ máy bán hàng" />
          <ShopOverviewRow open={open} provider="sapo" title="Sapo" color="#0ea5e9" text="S" description="Khách, đơn, hàng hoá từ cửa hàng Sapo" />
          <ShopOverviewRow open={open} provider="woocommerce" title="WooCommerce" color="#7f54b3" text="W" description="Khách, đơn, sản phẩm từ web bán hàng WordPress" />
          <ShopOverviewRow open={open} provider="shopee" title="Shopee" color="#ee4d2d" text="Sh" description="Đơn hàng trên sàn Shopee" />
          <ShopOverviewRow open={open} provider="lazada" title="Lazada" color="#0f146d" text="L" description="Đơn hàng trên sàn Lazada" />
          <ShopOverviewRow open={open} provider="misa" title="MISA AMIS Kế toán" color="#0369a1" text="MI" description="Khách hàng và hàng hoá từ phần mềm kế toán" />
        </ConnectionGroup>
      )}
      {data && (
        <ConnectionGroup label="Dữ liệu và tự động hoá">
          {visible.has("google-sheets") && <GoogleRow open={open} />}
          {visible.has("webhook-out") && <WebhookOutRow open={open} enabled={hooks} />}
          {visible.has("webhook-in") && <WebhookInRow open={open} enabled={hooks} />}
          {visible.has("extensions") && (
            <ConnectionRow
              testId="conn-extensions"
              logo={<ConnectionLogo color="#475569" icon={<Blocks />} />}
              title="Chương trình con"
              description="Tiện ích nhờ AI viết: đồng bộ, quy trình riêng, tích hợp mới"
              action={<Button variant="outline" onClick={() => open("extensions")}>Mở</Button>}
            />
          )}
          {auditVisible && (
            <ConnectionRow
              testId="conn-audit"
              logo={<ConnectionLogo color="#64748b" icon={<History />} />}
              title="Nhật ký tích hợp"
              description="Mọi lần AI và webhook đọc, ghi dữ liệu"
              action={<Button variant="outline" onClick={() => open("audit")}>Xem</Button>}
            />
          )}
        </ConnectionGroup>
      )}
      {(visible.has("webhook-out") || visible.has("facebook")) && (
        <ConnectionGroup label="Sắp có">
          {COMING.map((c) => (
            <ConnectionRow
              key={c.name}
              logo={<ConnectionLogo brand={c.brand} color={c.color} text={c.text} />}
              title={c.name}
              description={c.desc}
              status={<StatusPill tone="soon">Chờ đối tác</StatusPill>}
              note="Chưa công bố API — chờ hãng cấp tài liệu cho đối tác"
            />
          ))}
        </ConnectionGroup>
      )}
    </div>
  )
}
