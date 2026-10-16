"use client"

import { useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { AlertTriangle, Loader2, PlugZap } from "lucide-react"
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
  INTEGRATION_SECTIONS,
  flagEnvName,
  isSectionEnabled,
  type IntegrationSection,
} from "./integrations/integrations-meta"

/**
 * Cài đặt > Kết nối & AI: khung 5 mục (Fanpage Facebook  chạy độc lập cờ webhook/MCP) — Webhook ra + Webhook vào, Kết nối AI và Nhật ký tích hợp. Mục nào hiện theo QUYỀN; mục nào chạy được
 * theo CỜ máy chủ (`GET /integrations/status`). FE chỉ ẩn/hiện — BE mới là cổng thật.
 */
export function SettingsIntegrations() {
  const { can, canAny } = usePermissions()
  const { features } = useOrgFeatures()
  const visible = INTEGRATION_SECTIONS.filter((s) => canAny(...s.anyOf) && (!s.feature || features[s.feature] !== false))
  // Quay về từ Google OAuth (`?google=...`) => mở thẳng mục Google Sheets.
  // `?muc=<mục>` (vd `ai` từ nút "Kết nối AI" ở Trang chủ, `facebook` từ link AI gửi) => mở thẳng mục đó; mục không có quyền thì rơi về mục đầu như cũ.
  const params = useSearchParams()
  const fromGoogle = params.get("google") !== null
  // Không có `?muc=` ⇒ mở trang Tổng quan (mỗi kênh một dòng). `muc` lạ/không có quyền ⇒ cũng về Tổng quan.
  const [active, setActive] = useState<IntegrationSection | "overview">(fromGoogle ? "google-sheets" : ((params.get("muc") || "overview") as IntegrationSection | "overview"))
  const status = useIntegrationsStatus(visible.length > 0)
  const navRef = useRef<HTMLElement>(null)

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
    navRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" })
  }
  const tabs: ReadonlyArray<{ value: IntegrationSection | "overview"; label: string }> = [{ value: "overview", label: "Tổng quan" }, ...visible]

  return (
    <div className="space-y-4">
      {/* Tab gạch chân, cuộn ngang trên điện thoại — thay hàng nút viên thuốc (dễ nhầm với nút hành động). */}
      <nav ref={navRef} aria-label="Mục kết nối" className="-mx-1 overflow-x-auto border-b border-border [mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex min-w-max gap-1 px-1">
          {tabs.map((s) => {
            const on = overview ? s.value === "overview" : s.value === current.value
            return (
              <button
                key={s.value}
                type="button"
                aria-pressed={on}
                aria-current={on ? "page" : undefined}
                onClick={() => open(s.value)}
                className={cn(
                  "relative h-10 rounded-md px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-out outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 max-sm:h-11",
                  "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:transition-opacity after:duration-150",
                  on ? "text-foreground after:bg-foreground after:opacity-100" : "text-muted-foreground after:opacity-0 hover:text-foreground",
                )}
              >
                {s.label}
              </button>
            )
          })}
        </div>
      </nav>

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
  )
}
