"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"

import { cn } from "@/lib/utils"
import { DS_V2_ENABLED } from "@/lib/design-system-flags"
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"
import { useIsPhone } from "@/hooks/use-is-phone"

function Select<Value, Multiple extends boolean | undefined = false>(
  props: SelectPrimitive.Root.Props<Value, Multiple>,
) {
  // base-ui Select defaults modal=true → render backdrop với `inert` che pointer
  // events của Popover/filter siblings. Shadcn convention là non-modal; override
  // ở wrapper trừ khi caller chỉ định explicitly.
  return <SelectPrimitive.Root modal={false} {...props} />
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  )
}

/**
 * Wrapper quanh `@base-ui/react/select`'s SelectValue.
 *
 * ⚠ LƯU Ý QUAN TRỌNG — KHÔNG dùng dạng self-closing `<SelectValue />`:
 * base-ui KHÔNG tự render label từ `<SelectItem>` children (khác shadcn/Radix).
 * Khi `value` được preload từ form state / URL param / API mà chưa có user
 * click, SelectValue fallback về **raw value (ID số, slug)** → UI hiện "3"
 * thay vì "Giai đoạn 3".
 *
 * LUÔN truyền children function map value → label:
 * ```tsx
 * <SelectValue placeholder="Chọn...">
 *   {(v) => {
 *     if (typeof v !== "string" || !v) return null
 *     return options.find((o) => String(o.id) === v)?.label ?? null
 *   }}
 * </SelectValue>
 * ```
 */
function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    />
  )
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-full items-center justify-between gap-1.5 border border-input bg-card py-2 pr-2 pl-3 text-sm whitespace-nowrap shadow-[var(--shadow-field)] transition-[color,background-color,border-color,box-shadow] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-9 max-sm:data-[size=default]:h-11 pointer-coarse:data-[size=default]:h-11 data-[size=sm]:h-7 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // ds-v2: trigger bo ~8px (rounded-sm), size=sm
        // KHÔNG override radius riêng (kế thừa rounded-sm từ base, tránh bo
        // NGƯỢC thang — size nhỏ hơn lại tròn hơn). Cờ tắt → rounded-lg +
        // override `data-[size=sm]:rounded-[min(var(--radius-md),10px)]`.
        DS_V2_ENABLED
          ? "rounded-sm"
          : "rounded-lg data-[size=sm]:rounded-[min(var(--radius-md),10px)]",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        }
      />
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger: alignItemWithTriggerProp,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  // trên điện thoại (<640px) mặc định KHÔNG căn mục đang chọn trùng trigger —
  // trong bảng trượt đáy (MobileFilterSheet/Dialog) chế độ căn trigger đặt popup lệch
  // ra ngoài màn và nới layout viewport quá rộng (Chrome mobile). Popup
  // thả xuống dưới trigger như dropdown thường. Desktop giữ mặc định cũ (true).
  const isPhone = useIsPhone()
  const alignItemWithTrigger = alignItemWithTriggerProp ?? !isPhone
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        // điện thoại định vị `fixed` — `absolute` lệch mép làm Chrome mobile nới layout
        // viewport (popup → sheet → anchor rộng theo, khuếch đại tới 4×). `fixed` không nới.
        positionMethod={isPhone ? "fixed" : "absolute"}
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn("relative isolate z-50 max-h-(--available-height) w-max min-w-(--anchor-width) max-w-[min(28rem,calc(100vw-1rem))] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", className )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex min-w-0 flex-1 gap-2 whitespace-normal break-words">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronUpIcon
      />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronDownIcon
      />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
