"use client"

import type { ReactNode } from "react"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { usePathname } from "next/navigation"
import { ToggleLeft } from "lucide-react"
import { isOrgFeatureOn, ORG_FEATURES } from "@trinity/rbac"
import { useOrgFeatures } from "@/hooks/use-org-features"
import { featureForPath } from "@/lib/org-feature-routes"
import { usePermissions } from "@/lib/rbac"

/**
 * Chặn VÀO THẲNG URL của module đang bị tắt: hiện màn "Tính năng
 * đang tắt" thay vì trang — `children` KHÔNG được mount nên không phát request.
 * Đặt trong `<main>` của `(dashboard)/layout.tsx`; luôn là 1 element type CỐ
 * ĐỊNH nên không đổi cây provider. Đang tải → render children
 * như thường (fail-open, xem `useOrgFeatures`). Lỗi mạng vẫn fail-open (`isLoading` false).
 */
export function FeatureRouteGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { features } = useOrgFeatures()
  const { can } = usePermissions()
  const feature = featureForPath(pathname)
  if (!feature || isOrgFeatureOn(features, feature)) return <>{children}</>

  // Nhãn lấy theo module đang chặn.
  const label = ORG_FEATURES[feature].label
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-10 text-center text-muted-foreground">
      <ToggleLeft className="size-8 text-amber-500" />
      <p className="font-medium text-foreground">Tính năng “{label}” đang tắt</p>
      <p className="text-sm">Tổ chức đã tắt tính năng này nên không ai truy cập được.</p>
      {can("settings.features") && (
        <Link href="/settings?tab=features" className="text-sm font-medium text-primary underline">
          Bật lại ở Cài đặt &gt; Tính năng
        </Link>
      )}
    </div>
  )
}
