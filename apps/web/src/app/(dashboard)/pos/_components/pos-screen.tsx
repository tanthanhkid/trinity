"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState } from "@/components/ui/empty-state"
import { ShellPageHead } from "@/components/app-shell/page-head"
import { QUICK_TAB, QUICK_TABS_LIST } from "@/components/app-shell/tabs"
import { useIsPhone } from "@/hooks/use-is-phone"
import { useAuth } from "@/hooks/use-auth"
import { usePosSettings, usePosShift } from "@/hooks/pos/use-pos"
import { usePermissions } from "@/lib/rbac"
import { vnd } from "@/lib/pos-format"
import { PosOrdersTab } from "./pos-orders-tab"
import { PosPrintProvider } from "./pos-receipt"
import { PosReportTab } from "./pos-report-tab"
import { PosSell } from "./pos-sell"
import { PosSettingsAreas, PosSettingsModifiers } from "./pos-settings-layout"
import { PosSettingsStore } from "./pos-settings-store"
import { PosOpenShiftCard } from "./pos-shift-cards"
import { PosShiftTab } from "./pos-shift-tab"

type TabKey = "sell" | "orders" | "shift" | "report" | "settings"

/** Màn POS: Bán hàng · Đơn hàng · Ca · Báo cáo (quản lý) · Cài đặt (quản lý). BE là nơi enforce quyền; FE chỉ ẩn/hiện. */
export function PosScreen() {
  const { isLoading: authLoading } = useAuth()
  const { can } = usePermissions()
  const settings = usePosSettings()
  const shift = usePosShift()
  const [tab, setTab] = useState<TabKey>("sell")
  const isPhone = useIsPhone()

  if (authLoading) return <div className="flex justify-center p-10"><Loader2 className="animate-spin" aria-label="Đang tải" /></div>
  if (!can("pos.sell")) return <EmptyState message="Bạn không có quyền dùng màn Bán hàng (POS)." />
  const manage = can("pos.manage")
  const open = shift.data?.shift ?? null

  return (
    <PosPrintProvider settings={settings.data}>
      <div className="space-y-3">
        {isPhone ? (
          // Điện thoại: bỏ breadcrumb + tên quán, rút pill ca — thao tác bán lên cao.
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-[20px] font-semibold tracking-tight text-foreground">Bán hàng tại quầy</h1>
            {open && <span className="rounded-full border border-[var(--border)] bg-card px-3 py-1 text-sm font-medium text-foreground">Ca mở · {vnd(open.opening_cash)}</span>}
          </div>
        ) : (
        <ShellPageHead
          current="Bán hàng (POS)" title="Bán hàng tại quầy" subtitle={settings.data?.store_name}
          tools={open ? <span className="rounded-full border border-[var(--border)] bg-card px-3 py-1 text-sm font-medium text-foreground">Ca đang mở · đầu ca {vnd(open.opening_cash)}</span> : undefined}
        />
        )}
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList variant="line" layout="wrap" aria-label="Chức năng POS" className={QUICK_TABS_LIST}>
            <TabsTrigger value="sell" className={QUICK_TAB}>Bán hàng</TabsTrigger>
            <TabsTrigger value="orders" className={QUICK_TAB}>Đơn hàng</TabsTrigger>
            <TabsTrigger value="shift" className={QUICK_TAB}>Ca</TabsTrigger>
            {manage && <TabsTrigger value="report" className={QUICK_TAB}>Báo cáo</TabsTrigger>}
            {manage && <TabsTrigger value="settings" className={QUICK_TAB}>Cài đặt</TabsTrigger>}
          </TabsList>
          <TabsContent value="sell">
            {shift.isLoading ? <LoadingBlock className="p-4" count={4} label="Đang tải ca…" />
              // Không đọc được ca ⇒ báo lỗi, KHÔNG mời "Mở ca" (có thể đang có ca mở thật).
              : shift.isError && !shift.data ? <ErrorState title="Không đọc được ca đang mở" error={shift.error} onRetry={() => void shift.refetch()} retrying={shift.isFetching} />
              : open ? <PosSell /> : <div className="py-6"><PosOpenShiftCard /></div>}
          </TabsContent>
          <TabsContent value="orders"><PosOrdersTab canManage={manage} /></TabsContent>
          <TabsContent value="shift"><PosShiftTab /></TabsContent>
          {manage && <TabsContent value="report"><PosReportTab /></TabsContent>}
          {manage && (
            <TabsContent value="settings" className="space-y-4">
              <PosSettingsStore /><PosSettingsAreas /><PosSettingsModifiers />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </PosPrintProvider>
  )
}
