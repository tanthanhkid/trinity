"use client"

import { useCallback, type CSSProperties } from "react"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { NotificationSocket } from "@/components/notification-socket"
import { ShellSidebar } from "@/components/app-shell/sidebar"
import { FeatureRouteGate } from "@/components/feature-route-gate"
import { SetupGate } from "@/components/setup-gate"
import { ShellTopbar } from "@/components/app-shell/topbar"
import { OnboardingWizard } from "@/components/onboarding-wizard/onboarding-wizard"
import { useWizard } from "@/hooks/use-onboarding-wizard"
import { useAppDocumentTheme, useAppNavMini } from "@/hooks/use-app-shell"
import { appFont } from "@/lib/app-font"

// Sidebar pinned trên desktop (>=768px): luôn mở mặc định, bỏ qua cookie
// `sidebar_state=false` cũ. Lý do: Header chỉ render `SidebarTrigger` trên
// mobile (`md:hidden`) — nếu desktop tôn trọng cookie collapsed thì user mất
// hoàn toàn UI để mở lại sidebar.
const MOBILE_BREAKPOINT = 768

function getSidebarDefaultOpen(): boolean {
  if (typeof window === "undefined") return true
  if (window.innerWidth >= MOBILE_BREAKPOINT) return true
  const match = document.cookie.match(/(?:^|;\s*)sidebar_state=([^;]+)/)
  if (!match) return true
  return match[1] === "true"
}

// Số đo sidebar theo demo giao diện mới — 232px mở rộng, 64px khi thu
// gọn còn icon. `components/ui/sidebar` đọc 2 biến này, mặc định 16rem/3rem.
const APP_SIDEBAR_STYLE = {
  "--sidebar-width": "232px",
  "--sidebar-width-icon": "64px",
} as CSSProperties

const MAIN_CLASS = "min-w-0 flex-1 overflow-auto px-5 pb-6 max-sm:px-4 max-sm:pb-28"

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // `data-ui="app"` + font đặt trên <html> (overlay Base-UI portal ra <body>).
  // Attribute này là PHẠM VI của các khối override trong `styles/app-tokens.css`
  // — gỡ nó đi là mất luôn phần vá tương phản WCAG, nên nó được gắn vô điều
  // kiện cho mọi trang trong nhóm `(dashboard)`.
  useAppDocumentTheme(appFont.variable)
  const { navMini, setNavMini } = useAppNavMini()
  const onOpenChange = useCallback((open: boolean) => setNavMini(!open), [setNavMini])
  // Wizard bắt đầu: chưa đi hết thì MỌI trang trong ứng dụng (kể cả URL gõ tay) chỉ hiện wizard toàn màn hình.
  // Đang tải ⇒ chờ (không nháy ứng dụng); lỗi ⇒ fail-open, vào ứng dụng như cũ.
  const wizard = useWizard()
  if (wizard.isLoading) {
    return <div role="status" aria-busy="true" className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">Đang tải…</div>
  }
  if (wizard.data?.enabled && !wizard.data.completed) return <OnboardingWizard wizard={wizard.data} />

  return (
    <SidebarProvider
      defaultOpen={getSidebarDefaultOpen()}
      // Thu gọn 186↔64px, nhớ qua localStorage (controlled).
      open={!navMini}
      onOpenChange={onOpenChange}
      style={APP_SIDEBAR_STYLE}
    >
      <ShellSidebar />
      <SidebarInset className="bg-background">
        <ShellTopbar />
        <main className={MAIN_CLASS}>
          <SetupGate>
            <FeatureRouteGate>{children}</FeatureRouteGate>
          </SetupGate>
        </main>
      </SidebarInset>
      <NotificationSocket />
    </SidebarProvider>
  )
}
