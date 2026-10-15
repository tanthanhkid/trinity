/* Tiêu đề trang dùng chung (giao diện mới 10/2026): tiêu đề 22px + phụ đề ngang hàng
 * chân chữ + cụm nút bên phải — cùng dáng `ShellPageHeader`.
 *
 * Breadcrumb "Trinity CRM / …" KHÔNG còn vẽ trong trang: thanh trên (topbar) đã có
 * breadcrumb, vẽ lần nữa là lặp. `current`/`parent` giữ trong props để không phải sửa
 * chỗ gọi.
 */

import type { ReactNode } from "react"

interface ShellPageHeadProps {
  /** Nhãn breadcrumb (không còn vẽ — topbar đã có). */
  current: string
  parent?: { label: string; href: string }
  /** ReactNode để cho phép nhét badge số lượng ngay cạnh tiêu đề. */
  title: ReactNode
  subtitle?: string
  /** Cụm nút/badge bên phải. */
  tools?: ReactNode
}

export function ShellPageHead({ title, subtitle, tools }: ShellPageHeadProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <h1 className="flex flex-wrap items-center gap-2 text-[22px] font-semibold leading-tight tracking-tight text-foreground">
          {title}
        </h1>
        {subtitle && <p className="text-[15px] text-muted-foreground">{subtitle}</p>}
      </div>
      {tools && <div className="ml-auto flex flex-wrap items-center gap-2">{tools}</div>}
    </div>
  )
}
