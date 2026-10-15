"use client"

import type { ComponentType } from "react"
import { MoreHorizontal } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export interface RowMenuItem {
  label: string
  icon?: ComponentType<{ className?: string }>
  onClick: () => void
  /** Hành động nguy hiểm (Xoá…) — luôn đặt CUỐI menu, cách mục trước bằng đường kẻ. */
  destructive?: boolean
}

/**
 * Menu "⋯" (Thao tác khác) cho thẻ dòng trên điện thoại — thay cho cụm
 * icon Sửa/Khoá/Xoá sát nhau ở bảng desktop. Nút 44×44; mục `destructive` xuống cuối.
 * Hành động Xoá vẫn đi qua dialog xác nhận sẵn có của từng tab (menu chỉ mở dialog đó).
 * Dùng trong nhánh thẻ (`ShellResponsiveList cards`) nên chỉ hiện <640px.
 */
export function PayrollMobileRowMenu({
  items,
  className,
}: {
  items: RowMenuItem[]
  className?: string
}) {
  const normal = items.filter((i) => !i.destructive)
  const danger = items.filter((i) => i.destructive)
  if (items.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Thao tác khác"
        className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "max-sm:size-11", className)}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {normal.map((i) => (
          <DropdownMenuItem key={i.label} className="max-sm:min-h-11" onClick={i.onClick}>
            {i.icon && <i.icon className="size-4" />}
            {i.label}
          </DropdownMenuItem>
        ))}
        {normal.length > 0 && danger.length > 0 && <DropdownMenuSeparator />}
        {danger.map((i) => (
          <DropdownMenuItem
            key={i.label}
            className="text-destructive max-sm:min-h-11"
            onClick={i.onClick}
          >
            {i.icon && <i.icon className="size-4" />}
            {i.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
