"use client"

import { useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle, ArrowLeft, LayoutGrid, Loader2, PlugZap } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { usePermissions } from "@/lib/rbac"
import { useOrgFeatures } from "@/hooks/use-org-features"
import { GoogleSheetsPanel } from "./integrations/google-sheets-panel"
import { AiConnectionsPanel } from "./integrations/ai-connections-panel"
import { IntegrationAuditLogs } from "./integrations/integration-audit-logs"
import { ZaloOaPanel } from "./integrations/zalo-oa/zalo-oa-panel"
import { PaymentsPanel } from "./integrations/payments/payments-panel"
import { SalesPanel } from "./integrations/sales/sales-panel"
import { StorePanel } from "./integrations/store/store-panel"
import { ExtensionsScreen } from "@/components/extensions/extensions-screen"
import { FacebookPanel } from "./integrations/facebook-panel"
import { WebhookInPanel } from "./integrations/webhook-in-panel"
import { WebhookOutPanel } from "./integrations/webhook-out-panel"
import { useIntegrationsStatus } from "./integrations/use-integrations"
import { IntegrationsOverview } from "./integrations/integrations-overview"
import { cn } from "@/lib/utils"
import {
  INTEGRATION_GROUPS,
  INTEGRATION_SECTIONS,
  flagEnvName,
  isSectionEnabled,
  type IntegrationSection,
} from "./integrations/integrations-meta"

/** Tham số quay về từ OAuth (Facebook / Google / Zalo / phần mềm bán hàng) ⇒ mục cần mở. */
export function sectionFromParams(params: URLSearchParams): IntegrationSection | "overview" {
  const muc = params.get("muc")
  if (muc) return muc as IntegrationSection
  if (params.get("google") !== null) return "google-sheets"
  if (params.get("facebook") !== null) return "facebook"
  if (params.get("zalo_oa") !== null) return "zalo-oa"
  if (params.get("ket_noi") !== null) return "ban-hang"
  return "overview"
}

/**
 * Trang Kết nối (`/connections`, menu chính): cột trái nhóm theo loại (Trợ lý AI · Kênh khách · Thanh toán · Bán hàng ·
 * Dữ liệu & tự động · Nhật ký), mặc định là lưới thẻ có logo + trạng thái; bấm một mục mở chi tiết mục đó. Mục nào hiện theo
 * QUYỀN + công tắc tính năng; chạy được hay không theo CỜ máy chủ (`GET /integrations/status`). FE chỉ ẩn/hiện, BE mới là cổng thật.
 * Mục đang mở nằm trên URL (`?muc=`) để link sâu và nút Back chạy đúng.
 */
export function SettingsIntegrations() {
  const { can, canAny } = usePermissions()
  const { features } = useOrgFeatures()
  const visible = INTEGRATION_SECTIONS.filter((s) => canAny(...s.anyOf) && (!s.feature || features[s.feature] !== false))
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  // Mục đang mở theo URL (?muc= hoặc tham số quay về OAuth); URL đổi (link menu, Back/Forward) ⇒ đồng bộ lại.
  const query = params.toString()
  const [active, setActive] = useState<IntegrationSection | "overview">(() => sectionFromParams(new URLSearchParams(query)))
  const [seenQuery, setSeenQuery] = useState(query)
  if (seenQuery !== query) {
    setSeenQuery(query)
    setActive(sectionFromParams(new URLSearchParams(query)))
  }
  const status = useIntegrationsStatus(visible.length > 0)

  if (visible.length === 0) {
    return <EmptyState icon={PlugZap} message="Bạn chưa có quyền xem mục này." />
  }
  const found = visible.find((s) => s.value === active)
  const overview = !found
  const current = found ?? visible[0]
  const standalone = overview || current.value === "facebook" || current.value === "google-sheets" || current.value === "extensions" || current.value === "payments" || current.value === "ban-hang" || current.value === "ban-online"
  const enabled = !overview && isSectionEnabled(current.flag, status.data)
  const open = (s: IntegrationSection | "overview") => {
    setActive(s)
    // Người dùng đổi mục ⇒ thêm một mục lịch sử (Back quay lại mục trước); bỏ tham số quay về OAuth đã đọc.
    router.push(s === "overview" ? pathname : `${pathname}?muc=${s}`, { scroll: false })
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" })
  }
  const groups = INTEGRATION_GROUPS.map((g) => ({ ...g, items: visible.filter((s) => s.group === g.key) })).filter((g) => g.items.length > 0)
  const navButton = (value: IntegrationSection | "overview", label: string, on: boolean, icon?: React.ReactNode) => (
    <button
      key={value}
      type="button"
      aria-current={on ? "page" : undefined}
      onClick={() => open(value)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 max-md:min-h-11",
        on ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <div className="grid gap-5 md:grid-cols-[208px_minmax(0,1fr)]">
      {/* Cột trái nhóm theo loại. Điện thoại: chỉ hiện ở trang tổng (vào một mục thì có nút quay lại). */}
      <nav aria-label="Mục kết nối" className={cn("space-y-4 md:sticky md:top-4 md:self-start", !overview && "max-md:hidden")}>
        {navButton("overview", "Tất cả kết nối", overview, <LayoutGrid className="size-4 shrink-0" aria-hidden />)}
        {groups.map((g) => (
          <div key={g.key} className="space-y-0.5">
            <p className="px-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">{g.label}</p>
            {g.items.map((s) => navButton(s.value, s.label, !overview && s.value === current.value))}
          </div>
        ))}
      </nav>

      <div className="min-w-0 space-y-4">
      {!overview && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => open("overview")} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground md:hidden max-md:min-h-11">
            <ArrowLeft className="size-4" aria-hidden /> Tất cả kết nối
          </button>
          <h2 className="text-base font-semibold max-md:hidden">{current.label}</h2>
        </div>
      )}

      {overview && (
        <IntegrationsOverview
          visible={new Set(visible.map((s) => s.value))}
          status={status.data}
          statusError={status.isError}
          open={open}
          auditVisible={visible.some((s) => s.value === "audit") && can("integrations.ai_admin")}
          canPayConnect={can("integrations.webhooks")}
        />
      )}
      {!overview && current.value === "facebook" && <FacebookPanel />}
      {!overview && current.value === "google-sheets" && <GoogleSheetsPanel />}
      {!overview && current.value === "extensions" && <ExtensionsScreen />}
      {!overview && current.value === "payments" && <PaymentsPanel />}
      {!overview && current.value === "ban-hang" && <SalesPanel />}
      {!overview && current.value === "ban-online" && <StorePanel />}

      {!standalone && status.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Đang kiểm tra trạng thái kết nối...
        </div>
      )}

      {!standalone && status.isError && (
        <Card>
          <CardContent className="flex items-center gap-2 py-4 text-sm text-red-600">
            <AlertTriangle className="size-4" /> Không đọc được trạng thái kết nối. Vui lòng thử lại.
          </CardContent>
        </Card>
      )}

      {!standalone && status.data && !enabled && (
        <Card>
          <CardContent className="flex items-start gap-2 py-4 text-sm text-amber-700">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              Kênh này chưa được bật trên máy chủ. Quản trị hệ thống cần bật cờ{" "}
              <code className="rounded bg-muted px-1">{flagEnvName(current.flag)}</code> rồi khởi động lại dịch vụ (trên Vercel: đặt biến trong Project Settings → Environment Variables rồi deploy lại).
            </span>
          </CardContent>
        </Card>
      )}

      {status.data && enabled && !overview && current.value === "audit" && can("integrations.ai_admin") && (
        <IntegrationAuditLogs enabled />
      )}

      {status.data && enabled && !overview && current.value === "webhook-out" && <WebhookOutPanel keyReady={status.data.secret_key_configured !== false} />}
      {status.data && enabled && !overview && current.value === "webhook-in" && <WebhookInPanel keyReady={status.data.secret_key_configured !== false} />}

      {status.data && enabled && !overview && current.value === "zalo-oa" && <ZaloOaPanel />}

      {status.data && enabled && !overview && current.value === "ai" && (
        <AiConnectionsPanel mcpUrl={status.data.mcp_url ?? null} baseUrlConfigured={status.data.mcp_base_url_configured !== false} />
      )}
      </div>
    </div>
  )
}
