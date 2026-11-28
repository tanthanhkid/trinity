"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"

/**
 * Khay đáy «Ánh xanh» cho ĐIỆN THOẠI (docs/design/anh-xanh.md): trượt lên từ đáy 200ms, bo trên
 * 20, thanh kéo 40×5 #E2E2DE, đệm 8/16/28 (+ safe-area), bóng tầng «nổi», lớp phủ
 * `--ax-scrim`. Dựng trên Dialog của Base UI ⇒ có sẵn khoá focus, Esc, bấm nền để đóng,
 * trả focus về nút mở.
 *
 * Desktop (≥1024px) thường dùng ngăn/khay bên phải thay vì khay đáy; nếu vẫn mở ở màn rộng,
 * khay giới hạn 560px và nằm giữa.
 *
 * @example
 * <BottomSheet open={open} onOpenChange={setOpen}>
 *   <BottomSheetContent title="Đổi giai đoạn" description="Khách Nguyễn Tú">
 *     …danh sách…
 *     <BottomSheetFooter><Button variant="ax-primary" size="ax-lg" className="w-full">Lưu</Button></BottomSheetFooter>
 *   </BottomSheetContent>
 * </BottomSheet>
 */
function BottomSheet(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />
}

function BottomSheetTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="bottom-sheet-trigger" {...props} />
}

function BottomSheetClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="bottom-sheet-close" {...props} />
}

function BottomSheetContent({
  className,
  title,
  description,
  hideTitle = false,
  children,
  ...props
}: Omit<DialogPrimitive.Popup.Props, "title"> & {
  /** Tiêu đề (bắt buộc cho trình đọc màn hình); `hideTitle` để chỉ giữ cho trình đọc. */
  title: React.ReactNode
  description?: React.ReactNode
  hideTitle?: boolean
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="bottom-sheet-scrim"
        className="fixed inset-0 z-50 bg-[var(--ax-scrim)] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      <DialogPrimitive.Popup
        data-slot="bottom-sheet-content"
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] w-full flex-col gap-3 overflow-y-auto overscroll-contain",
          "rounded-t-[var(--ax-radius-sheet-mobile)] bg-ax-surface px-4 pt-2 pb-[calc(28px+env(safe-area-inset-bottom))] text-ax-ink shadow-[var(--ax-shadow-float)] outline-none",
          "transition-transform duration-200 ease-out data-ending-style:translate-y-full data-starting-style:translate-y-full",
          "lg:max-w-[560px]",
          className,
        )}
        {...props}
      >
        <div aria-hidden className="mx-auto h-[5px] w-10 shrink-0 rounded-[3px] bg-ax-btn-border" />
        <div className={cn("flex flex-col gap-1", hideTitle && "sr-only")}>
          <DialogPrimitive.Title data-slot="bottom-sheet-title" className="ax-text-subhead text-ax-ink">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description data-slot="bottom-sheet-description" className="text-[13px] text-ax-ink-2">
              {description}
            </DialogPrimitive.Description>
          ) : null}
        </div>
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

/** Hàng nút cuối khay (dính đáy trong khay khi nội dung dài). */
function BottomSheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bottom-sheet-footer"
      className={cn("sticky bottom-0 -mx-4 mt-1 flex gap-2 bg-ax-surface px-4 pt-2", className)}
      {...props}
    />
  )
}

export { BottomSheet, BottomSheetClose, BottomSheetContent, BottomSheetFooter, BottomSheetTrigger }
