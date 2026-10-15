import type { ComponentType, ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Khối tiêu đề trang dùng chung — cùng dáng thanh trên của màn Khách hàng / Công việc
 * (giao diện mới 10/2026): tiêu đề 22px đậm vừa, badge số liệu cạnh tiêu đề, mô tả
 * 14px chữ phụ, cụm nút bên phải tự xuống dòng ở màn hẹp.
 *
 * Prop `icon` giữ để không phải sửa chỗ gọi, nhưng KHÔNG còn vẽ ô icon vuông: bản demo
 * không có ô icon ở đầu trang (breadcrumb + sidebar đã cho biết đang ở đâu).
 */
export function ShellPageHeader({
  title,
  badge,
  description,
  actions,
  className,
}: {
  title: ReactNode
  icon?: ComponentType<{ className?: string }>
  badge?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-foreground">
            {title}
          </h1>
          {badge}
        </div>
        {description && (
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
