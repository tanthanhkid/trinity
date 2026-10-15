"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * Công tắc (switch) dùng chung.
 *
 * Một bản `<button role="switch">` tự viết riêng thường khi
 * TẮT dùng `bg-muted-foreground/30` (~1,5:1 trên thẻ trắng — núm trắng gần như vô
 * hình, không thấy công tắc). Bản dùng chung này đặt mặc định TẮT = `#8b919f`
 * (3,16:1 trên nền trắng, đạt WCAG 1.4.11 cho biên thành phần tương tác).
 *
 * `trackOnClassName`/`trackOffClassName`/`size` cho phép tuỳ biến màu + kích
 * thước ở call-site (vd một số chỗ giữ nguyên fuchsia-500/slate-300,
 * cỡ nhỏ hơn) mà KHÔNG đụng vào cấu trúc/accessibility của component — tránh
 * twMerge phải hoà giải 2 class nền xung đột theo trạng thái checked/unchecked.
 */

export interface SwitchProps {
  checked: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  id?: string
  className?: string
  thumbClassName?: string
  /** Màu nền khi BẬT. Mặc định màu thương hiệu của app. */
  trackOnClassName?: string
  /** Màu nền khi TẮT. Mặc định #8b919f — 3,16:1 trên nền trắng. */
  trackOffClassName?: string
  size?: "default" | "sm"
  "aria-label"?: string
  "aria-labelledby"?: string
}

const SWITCH_SIZE = {
  default: {
    track: "h-6 w-11",
    thumb: "size-5",
    on: "translate-x-5",
    off: "translate-x-0.5",
  },
  sm: {
    track: "h-5 w-9",
    thumb: "size-4",
    on: "translate-x-[18px]",
    off: "translate-x-0.5",
  },
} as const

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked,
    onCheckedChange,
    disabled,
    id,
    className,
    thumbClassName,
    trackOnClassName = "bg-[var(--color-app-primary)]",
    trackOffClassName = "bg-[#8b919f]",
    size = "default",
    ...ariaProps
  },
  ref,
) {
  const dim = SWITCH_SIZE[size]

  return (
    <button
      ref={ref}
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full transition-colors",
        // Mở rộng vùng chạm tới 44px trên điện thoại, không đổi bố cục.
        "max-sm:after:absolute max-sm:after:top-1/2 max-sm:after:left-1/2 max-sm:after:size-11 max-sm:after:-translate-x-1/2 max-sm:after:-translate-y-1/2 max-sm:after:content-[''] pointer-coarse:sm:after:absolute pointer-coarse:sm:after:top-1/2 pointer-coarse:sm:after:left-1/2 pointer-coarse:sm:after:size-11 pointer-coarse:sm:after:-translate-x-1/2 pointer-coarse:sm:after:-translate-y-1/2 pointer-coarse:sm:after:content-['']",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        dim.track,
        checked ? trackOnClassName : trackOffClassName,
        className,
      )}
      {...ariaProps}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none inline-block rounded-full bg-white shadow transform transition-transform",
          dim.thumb,
          checked ? dim.on : dim.off,
          thumbClassName,
        )}
      />
    </button>
  )
})
