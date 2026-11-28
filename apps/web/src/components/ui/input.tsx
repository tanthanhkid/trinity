import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"
import { DS_V2_ENABLED } from "@/lib/design-system-flags"

/**
 * Dáng ô nhập «Ánh xanh» (docs/design/anh-xanh.md): nền trắng, viền #8A8D96 (≥ 3:1), bo 8,
 * cao 40 desktop / 48 điện thoại, chữ 14 / 16 (điện thoại — iOS không tự phóng to),
 * focus viền xanh + quầng 3px, lỗi viền đỏ. Dùng chung cho `<textarea>` / ô tự dựng.
 */
export const AX_INPUT_CLASS =
  "rounded-[var(--ax-radius-field)] h-10 max-sm:h-12 pointer-coarse:h-12 border-ax-field-border bg-ax-surface px-3 text-sm max-sm:text-base text-ax-ink shadow-none placeholder:text-[var(--ax-placeholder)] hover:border-[var(--ax-field-border-hover)] focus-visible:border-ax-primary focus-visible:ring-0 focus-visible:shadow-[var(--ax-field-focus)] aria-invalid:border-ax-danger aria-invalid:ring-0"

function Input({
  className,
  type,
  variant = "default",
  ...props
}: React.ComponentProps<"input"> & {
  /** `"ax"` = dáng «Ánh xanh»; mặc định giữ nguyên dáng cũ. */
  variant?: "default" | "ax"
}) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-variant={variant === "ax" ? "ax" : undefined}
      className={cn(
        "h-9 max-sm:h-11 pointer-coarse:h-11 w-full min-w-0 border border-input bg-card px-3 py-1 text-base shadow-[var(--shadow-field)] transition-[color,background-color,border-color,box-shadow] duration-150 ease-out outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        // ds-v2: bo ~8px (rounded-sm = --radius-sm) thay rounded-lg (~13px);
        // cờ tắt giữ rounded-lg.
        DS_V2_ENABLED ? "rounded-sm" : "rounded-lg",
        variant === "ax" && AX_INPUT_CLASS,
        className
      )}
      {...props}
    />
  )
}

export { Input }
