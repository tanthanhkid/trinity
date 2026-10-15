'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button-variants'
import { cn } from '@/lib/utils'
import { useOrgFeature } from '@/hooks/use-org-features'
import { PERMISSIONS, usePermissions, type Permission } from '@/lib/rbac'

/** Mọi quyền `reports.*` trong danh mục — có BẤT KỲ quyền nào là còn cửa vào Báo cáo. */
const REPORT_PERMISSIONS = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => p.startsWith('reports.'))

/**
 * Cửa THỨ HAI vào Báo cáo, không đi qua `isItemVisible` nên phải tự mirror luật của
 * menu: có ÍT NHẤT MỘT quyền `reports.*`. Không rò dữ
 * liệu nếu thiếu (tab `/reports` vẫn gate theo quyền từng tab).
 */
export function useCanSeeReportsCenter(): boolean {
  const { canAny } = usePermissions()
  // Tắt tính năng Báo cáo → cửa thứ hai này cũng đóng.
  const reportsOn = useOrgFeature('reports')
  return reportsOn && canAny(...REPORT_PERMISSIONS)
}

/** Nút điều hướng (outline) "Trung tâm báo cáo →". `<Link>` trần vì Base-UI Button không có asChild. */
export function DashboardReportsButton() {
  const canSee = useCanSeeReportsCenter()
  if (!canSee) return null
  return (
    <Link
      href="/reports"
      className={cn(buttonVariants({ variant: 'outline' }), 'gap-2 rounded-xl sm:h-9 max-sm:min-h-11')}
    >
      Trung tâm báo cáo
      <ArrowRight className="size-4" aria-hidden />
    </Link>
  )
}
