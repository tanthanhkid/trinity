"use client"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface EmployeeCellProps {
  fullName?: string | null
  email?: string | null
  className?: string
}

/**
 * Hiển thị tên nhân viên trong bảng (danh bạ, hồ sơ…). Hover để xem email.
 * Fallback khi thiếu data: tên → email → "—". Tooltip chỉ hiện khi có email.
 */
export function EmployeeCell({ fullName, email, className }: EmployeeCellProps) {
  const name = fullName?.trim() || null
  const mail = email?.trim() || null
  const display = name || mail || "—"

  if (!mail) {
    return <span className={cn("truncate", className)}>{display}</span>
  }

  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className={cn("truncate cursor-default", className)}>
              {display}
            </span>
          }
        />
        <TooltipContent side="top">{mail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
