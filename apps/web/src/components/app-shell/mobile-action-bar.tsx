import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Thanh hành động dính đáy cho FORM / THANH TOÁN / LƯU.
 *
 * - ≥640px: `div flex justify-end gap-2` — footer form bình thường, căn phải.
 * - <640px: cố định đáy màn (`fixed inset-x-0 bottom-0`), nền mờ, viền trên,
 *   safe-area; con xếp ngang — con ĐẦU (Huỷ, `ghost`) bên trái, con CUỐI (nút
 *   chính) chiếm phần còn lại. Kèm spacer `h-24` (chỉ <640px) ngay sau thanh để
 *   nội dung cuối trang không bị che.
 *
 * CSS-only (không hook) ⇒ không lệch hydrate. Thứ tự con: Huỷ trước, nút chính
 * CUỐI. Nút nguy hiểm KHÔNG đặt ở đây. Không dùng chung màn với
 * `MOBILE_FAB_CLASS` (cùng `z-40`).
 */
export function MobileActionBar({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <>
      <div
        data-slot="mobile-action-bar"
        className={cn(
          "flex justify-end gap-2",
          "max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:justify-between max-sm:border-t max-sm:bg-card/95 max-sm:px-4 max-sm:pt-3 max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-sm:backdrop-blur",
          "max-sm:[&>:last-child]:flex-1",
          className,
        )}
      >
        {children}
      </div>
      <div aria-hidden data-slot="mobile-action-bar-spacer" className="hidden max-sm:block max-sm:h-24" />
    </>
  )
}
