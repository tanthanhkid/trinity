"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/30 duration-200 ease-out supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // GIỮ NGUYÊN `sm:max-w-sm` bất kể cờ: mọi
          // nơi cần dialog rộng hơn đã tự thêm `sm:max-w-*` per-usage, đổi/xoá
          // default ở đây sẽ phá layout các dialog KHÔNG override width).
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 sm:gap-5 rounded-xl bg-popover p-4 sm:p-6 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-200 ease-out outline-none sm:max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.97]",
          // dialog cao hơn khung nhìn (vd 1366×768) bị cắt mép trên vì
          // `-translate-y-1/2` + không giới hạn cao ⇒ giới hạn cao + cuộn trong ở MỌI cỡ.
          // Dạng KHÔNG tiền tố cố ý: dialog tự đặt `max-h-*`/`overflow-hidden` (cn/twMerge)
          // vẫn thắng; `sm:` sẽ đè chúng. <640px do `max-sm:` bên dưới quyết định (không đổi).
          // < 640px = bảng trượt từ ĐÁY (thumb-zone). Toàn bộ `max-sm:` ⇒ ≥640px không đổi.
          // Nơi truyền class không tiền tố (`max-w-2xl`, `w-[600px]`) vẫn thua `max-sm:` ở <640px.
          "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[90dvh] max-sm:w-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:overflow-y-auto max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))] max-sm:data-open:slide-in-from-bottom max-sm:data-open:zoom-in-100 max-sm:data-closed:slide-out-to-bottom max-sm:data-closed:zoom-out-100",
          // Bóng nổi + ring mảnh ở mọi chế độ (token --shadow-pop tự đổi theo theme).
          "shadow-[var(--shadow-pop)]",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        // < 640px xếp DỌC, nút rộng hết, nút chính (con cuối) ở DƯỚI CÙNG gần ngón cái.
        "flex flex-col gap-2 pt-1 sm:flex-row sm:justify-end max-sm:[&>[data-slot=button]]:w-full",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-6 font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
