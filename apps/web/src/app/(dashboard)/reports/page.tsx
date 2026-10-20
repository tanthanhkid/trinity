"use client"

import { Suspense, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { QUICK_TAB, QUICK_TABS_LIST } from "@/components/app-shell/tabs"
import { Forbidden, usePermissions } from "@/lib/rbac"
import { isOrgFeatureOn } from "@trinity/rbac"
import { useAuth } from "@/hooks/use-auth"
import { useOrgFeatures } from "@/hooks/use-org-features"
import {
  REPORT_TAB_GROUPS,
  DEFAULT_REPORT_TAB,
  type ReportTabGroup,
} from "./_components/report-tabs-config"
import { reportTabAllowed } from "./_components/report-tab-access"

function ReportsContent() {
  const { can, grants } = usePermissions()
  const { isLoading: authLoading } = useAuth()
  const { features } = useOrgFeatures()
  const searchParams = useSearchParams()
  const tabFromUrl = searchParams.get("tab")

  // Nhóm + tab hiển thị theo quyền — mỗi tab 1 quyền khai trong config
  const visibleGroups = useMemo<ReportTabGroup[]>(
    () =>
      REPORT_TAB_GROUPS.map((g) => ({
        ...g,
        tabs: g.tabs.filter(
          (t) => reportTabAllowed(t, can) && (!t.feature || isOrgFeatureOn(features, t.feature)),
        ),
      })).filter((g) => g.tabs.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `can` đọc grants từ store
    [grants, features],
  )

  const [tab, setTab] = useState<string>(
    () => tabFromUrl ?? DEFAULT_REPORT_TAB,
  )

  // Quyền hydrate muộn / ?tab= không thuộc quyền → nhảy về tab hợp lệ đầu tiên
  // (bail-out: KHÔNG setState khi tab hiện tại đã hợp lệ). Chưa có tab nào hiện
  // (quyền chưa tải xong): KHÔNG reset — để deep-link ?tab= không bị ghi đè.
  useEffect(() => {
    if (visibleGroups.length === 0) return
    const allVisible = visibleGroups.flatMap((g) => g.tabs)
    if (allVisible.some((t) => t.value === tab)) return
    setTab(
      allVisible.some((t) => t.value === DEFAULT_REPORT_TAB)
        ? DEFAULT_REPORT_TAB
        : allVisible[0].value,
    )
  }, [visibleGroups, tab])

  const activeGroup =
    visibleGroups.find((g) => g.tabs.some((t) => t.value === tab)) ??
    visibleGroups[0]

  // Chờ `/auth/me` xong rồi mới kết luận "không có quyền" (tránh nhá Forbidden
  // khi quyền chưa hydrate). Không có tab nào → KHÔNG render tab/gọi API nào.
  if (authLoading && visibleGroups.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">Đang tải báo cáo…</div>
  }
  if (visibleGroups.length === 0) {
    return <Forbidden message="Cần ít nhất một quyền xem báo cáo." />
  }

  return (
    <div className="space-y-4">
      <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-foreground">Trung tâm báo cáo</h1>

      <Tabs value={tab} onValueChange={(v) => setTab(v ?? tab)} className="space-y-4">
        {/* Hàng 1: nhóm chủ đề — tab nhanh kiểu giao diện mới (nền xám khi chọn, viền mảnh) */}
        <div
          role="group"
          aria-label="Nhóm báo cáo"
          className="flex flex-wrap gap-1 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden"
        >
          {visibleGroups.map((g) => {
            const isActive = g.key === activeGroup?.key
            return (
              <button
                key={g.key}
                type="button"
                aria-pressed={isActive}
                onClick={() => setTab(g.tabs[0].value)}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm font-medium transition max-sm:h-11 max-sm:min-h-11",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                  isActive
                    ? "bg-[var(--muted)] text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
                    : "text-muted-foreground hover:bg-[var(--muted)] hover:text-foreground",
                )}
              >
                {g.label}
                {/* Số báo cáo trong nhóm — chỉ hiện khi nhóm có nhiều hơn 1. Màu token đặc, KHÔNG pha alpha
                    (alpha là nguồn tụt tương phản nằm ngoài bảng token). */}
                {g.tabs.length > 1 && (
                  <span className="ml-1.5 tabular-nums text-muted-foreground">{g.tabs.length}</span>
                )}
              </button>
            )
          })}
        </div>

        {/* Hàng 2: tab con của nhóm đang chọn */}
        {activeGroup && activeGroup.tabs.length > 1 && (
          <TabsList variant="line" layout="wrap" className={QUICK_TABS_LIST}>
            {activeGroup.tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className={QUICK_TAB}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        )}

        {visibleGroups.flatMap((g) =>
          g.tabs.map((t) => (
            <TabsContent key={t.value} value={t.value}>
              <t.Component />
            </TabsContent>
          )),
        )}
      </Tabs>
    </div>
  )
}

export default function ReportsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-4 text-sm text-muted-foreground">Đang tải báo cáo…</div>
      }
    >
      <ReportsContent />
    </Suspense>
  )
}
