'use client'

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/hooks/use-auth'
import { useOrgFeatures } from '@/hooks/use-org-features'
import { isOrgFeatureOn } from '@trinity/rbac'
import { usePermissions } from '@/lib/rbac'
import { cn } from '@/lib/utils'
import { useCanSeeReportsCenter } from './dashboard-reports-button'
import { DASHBOARD_WIDGETS } from './widgets'

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-48" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    </div>
  )
}

/**
 * Thân trang Tổng quan: render từng widget trong `DASHBOARD_WIDGETS` mà người
 * dùng có quyền nguồn, rồi link "Xem báo cáo chi tiết" nếu có quyền vào Báo cáo.
 * Quyền chưa nạp xong (`/auth/me`) → skeleton, KHÔNG nháy trang trống.
 */
export function DashboardWidgets() {
  const { isLoading } = useAuth()
  const { can } = usePermissions()
  const canSeeReports = useCanSeeReportsCenter()
  const { features } = useOrgFeatures()
  if (isLoading) return <DashboardSkeleton />

  return (
    <div className="flex flex-col gap-6">
      {DASHBOARD_WIDGETS.filter(
        (w) => can(w.permission) && (!w.feature || isOrgFeatureOn(features, w.feature)),
      ).map(({ key, Component }) => (
        <Component key={key} />
      ))}
      {canSeeReports && (
        <div className="flex justify-end">
          <Link
            href="/reports"
            className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'gap-1 text-[14px] max-sm:min-h-11')}
          >
            Xem báo cáo chi tiết
            <ChevronRight className="size-4" />
          </Link>
        </div>
      )}
    </div>
  )
}
