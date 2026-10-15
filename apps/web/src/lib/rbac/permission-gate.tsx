"use client"

import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { PERMISSIONS, type Permission } from "@trinity/rbac"
import { useAuth } from "@/hooks/use-auth"
import { Forbidden } from "./forbidden"
import { usePermissions } from "./use-permissions"

export interface PermissionGateProps {
  /** Quyền BE yêu cầu cho các API của trang — thiếu thì KHÔNG mount `children`. */
  permission: Permission
  message?: string
  children: ReactNode
}

/**
 * Cổng quyền cấp trang: thiếu quyền → `<Forbidden />` và `children` KHÔNG được
 * mount, nên mọi hook gọi API bên trong không chạy (0 request 4xx). Đặt ở
 * component NGOÀI — không gọi hook có điều kiện bên trong trang. Chờ `/auth/me`
 * xong rồi mới kết luận "không có quyền" (tránh nháy Forbidden lúc hydrate).
 */
export function PermissionGate({ permission, message, children }: PermissionGateProps) {
  const { can } = usePermissions()
  const { isLoading } = useAuth()
  if (can(permission)) return <>{children}</>
  if (isLoading) {
    return (
      <div className="flex justify-center p-10">
        <Loader2 className="animate-spin" aria-label="Đang tải" />
      </div>
    )
  }
  // Nhãn tiếng Việt từ danh mục (vd "Xem công việc"), không lộ mã kỹ thuật `kanban.view`.
  return <Forbidden message={message ?? `Cần quyền “${PERMISSIONS[permission].label}”.`} />
}
