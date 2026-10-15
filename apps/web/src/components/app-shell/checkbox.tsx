"use client"

/* Fork RIÊNG của `components/ui/checkbox.tsx` (KHÔNG dùng chung) — lý do:
 * `accent-[#198754]` là hex literal, KHÔNG đi qua token nào nên
 * `[data-ui="app"]` không remap được, và `accent-color` là màu ô tick của
 * input native (thấy rõ ở mọi hàng Danh bạ). Sửa `components/ui/checkbox.tsx`
 * (primitive shadcn dùng chung nhiều nơi khác) sẽ ảnh hưởng các nơi đó — đừng
 * "refactor cho DRY" gộp 2 file lại. */

import * as React from "react"
import { cn } from "@/lib/utils"

interface ShellCheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  onCheckedChange?: (checked: boolean) => void
}

const ShellCheckbox = React.forwardRef<HTMLInputElement, ShellCheckboxProps>(
  ({ className, onCheckedChange, onChange, ...props }, ref) => {
    return (
      <input
        type="checkbox"
        ref={ref}
        className={cn(
          "h-4 w-4 shrink-0 rounded border border-input accent-[var(--color-app-primary)] cursor-pointer",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        onChange={(e) => {
          onChange?.(e)
          onCheckedChange?.(e.target.checked)
        }}
        {...props}
      />
    )
  },
)
ShellCheckbox.displayName = "ShellCheckbox"

export { ShellCheckbox }
