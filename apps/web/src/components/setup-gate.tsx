"use client"

import { useEffect, type ReactNode } from "react"
import { usePathname, useRouter } from "next/navigation"
import { useSetupStatus } from "@/hooks/use-setup-status"
import { useOrgFeatures } from "@/hooks/use-org-features"
import { useCustomNav } from "@/hooks/custom-objects/use-custom-objects"
import { usePermissions } from "@/lib/rbac"
import { isAllowedBeforeSetup, SETUP_HOME } from "@/lib/setup-routes"

/**
 * Cổng "chưa dựng quy trình thì chưa dùng được CRM". `chua_dung` + route ngoài Bắt đầu/Hoạt động AI/Cài đặt ⇒
 * chuyển về `/bat-dau` (children KHÔNG mount nên không phát request). `dang_dung`/`da_dung` ⇒ đi tiếp như cũ, trừ
 * `/dashboard` khi gói dựng đã TẮT Tổng quan ⇒ chuyển sang menu đầu tiên của gói (đăng nhập xong luôn rơi vào /dashboard).
 * (Người mới đi wizard bắt đầu ở layout trước khi tới đây.) Đang tải lần đầu ⇒ chờ (tránh nháy màn rỗng); lỗi ⇒ fail-open (`da_dung`).
 * Luôn là 1 element type cố định trong `<main>` — không đụng cây provider (§0B).
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { status, isLoading } = useSetupStatus()
  const { features, isResolved } = useOrgFeatures()
  const { can } = usePermissions()
  const dashboardOff = status !== "chua_dung" && pathname === "/dashboard" && isResolved && features.dashboard === false
  const { data: nav } = useCustomNav(dashboardOff && can("custom_records.view"))
  const blocked = status === "chua_dung" && !isAllowedBeforeSetup(pathname)
  const firstHref = nav?.[0] ? (nav[0].href ?? `/x/${nav[0].key}`) : SETUP_HOME
  const target = blocked ? SETUP_HOME : dashboardOff ? firstHref : null

  useEffect(() => {
    if (target) router.replace(target)
  }, [target, router])

  if (isLoading || target) {
    return <div role="status" aria-busy="true" className="p-10 text-center text-sm text-muted-foreground">Đang tải…</div>
  }
  return <>{children}</>
}
