import * as React from "react"
import { CircleAlert } from "lucide-react"

import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"

/**
 * Nhóm trường kiểu shadcn Field: nhãn → 6px → ô → 6px → mô tả/lỗi; giữa hai trường 20px (`FieldGroup`).
 * Lỗi THAY chỗ mô tả (không đẩy thêm dòng); ô con tự nhận `aria-invalid` qua `data-invalid` của Field.
 */
function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("flex flex-col gap-5", className)} {...props} />
}

function Field({ className, invalid, ...props }: React.ComponentProps<"div"> & { invalid?: boolean }) {
  return (
    <div
      data-slot="field"
      data-invalid={invalid || undefined}
      className={cn(
        "group/field flex flex-col gap-1.5 data-[invalid=true]:[&_[data-slot=input]]:border-destructive data-[invalid=true]:[&_[data-slot=textarea]]:border-destructive data-[invalid=true]:[&_[data-slot=select-trigger]]:border-destructive",
        className,
      )}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" className={cn("group-data-[invalid=true]/field:text-destructive", className)} {...props} />
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="field-description" className={cn("text-[13px] leading-5 text-muted-foreground", className)} {...props} />
}

function FieldError({ className, children, ...props }: React.ComponentProps<"p">) {
  if (!children) return null
  return (
    <p data-slot="field-error" role="alert" className={cn("flex items-start gap-1.5 text-[13px] leading-5 text-destructive", className)} {...props}>
      <CircleAlert className="mt-[3px] size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  )
}

/** Tiêu đề một cụm trường trong form dài (vd "Thông tin liên hệ"). */
function FieldSet({ className, legend, description, children, ...props }: React.ComponentProps<"fieldset"> & { legend: string; description?: string }) {
  return (
    <fieldset data-slot="field-set" className={cn("flex flex-col gap-4", className)} {...props}>
      <div className="flex flex-col gap-1">
        <legend className="text-sm font-medium text-foreground">{legend}</legend>
        {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </fieldset>
  )
}

export { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet }
