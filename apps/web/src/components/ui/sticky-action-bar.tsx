import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Thanh hành động dính «Ánh xanh» (docs/design/anh-xanh.md). Nền `--ax-grad-bar`
 * (trắng 86% → trắng).
 *
 * - `layout="auto"` (mặc định): dưới 1024px là thanh ĐÁY ĐIỆN THOẠI (cố định đáy, viền trên,
 *   đệm 12/16 + safe-area, kèm khoảng đệm để nội dung cuối không bị che); từ 1024px là thanh
 *   NỔI DESKTOP (sticky cách đáy 12px, bo 12, bóng tầng «nổi», căn phải).
 * - `layout="mobile"` / `"desktop"`: ép một dáng (vd khung điện thoại trong khay).
 *
 * Thứ tự con: phụ trước, nút chính CUỐI (điện thoại: nút cuối giãn hết phần còn lại).
 *
 * @example
 * <StickyActionBar>
 *   <Button variant="ax-secondary" size="ax">Bỏ sửa</Button>
 *   <Button variant="ax-primary" size="ax">Lưu thay đổi</Button>
 * </StickyActionBar>
 */
export function StickyActionBar({
  layout = "auto",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { layout?: "auto" | "mobile" | "desktop" }) {
  const mobile =
    "fixed inset-x-0 bottom-0 z-40 flex items-center gap-2 border-t border-ax-line ax-grad-bar px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] [&>:last-child]:flex-1"
  const desktop =
    "sticky bottom-3 z-30 flex items-center justify-end gap-3 rounded-[var(--ax-radius-card)] border border-ax-line ax-grad-bar px-4 py-3 shadow-[var(--ax-shadow-float)]"
  const auto =
    "max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:border-t max-lg:px-4 max-lg:pt-3 max-lg:pb-[calc(12px+env(safe-area-inset-bottom))] max-lg:[&>:last-child]:flex-1 lg:sticky lg:bottom-3 lg:z-30 lg:justify-end lg:gap-3 lg:rounded-[var(--ax-radius-card)] lg:border lg:px-4 lg:py-3 lg:shadow-[var(--ax-shadow-float)] flex items-center gap-2 border-ax-line ax-grad-bar"
  return (
    <>
      <div
        data-slot="sticky-action-bar"
        data-layout={layout}
        className={cn(layout === "mobile" ? mobile : layout === "desktop" ? desktop : auto, className)}
        {...props}
      >
        {children}
      </div>
      {layout !== "desktop" ? (
        <div
          aria-hidden
          data-slot="sticky-action-bar-spacer"
          className={cn("h-24", layout === "auto" && "lg:hidden")}
        />
      ) : null}
    </>
  )
}
