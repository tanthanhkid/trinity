import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"
import { DS_V2_ENABLED } from "@/lib/design-system-flags"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 max-sm:h-11 pointer-coarse:h-11 w-full min-w-0 border border-input bg-card px-3 py-1 text-base shadow-[var(--shadow-field)] transition-[color,background-color,border-color,box-shadow] duration-150 ease-out outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        // ds-v2: bo ~8px (rounded-sm = --radius-sm) thay rounded-lg (~13px);
        // cờ tắt giữ rounded-lg.
        DS_V2_ENABLED ? "rounded-sm" : "rounded-lg",
        className
      )}
      {...props}
    />
  )
}

export { Input }
