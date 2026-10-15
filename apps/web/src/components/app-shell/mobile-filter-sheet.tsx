"use client"

import { useState, type ReactNode } from "react"
import { SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useIsPhone } from "@/hooks/use-is-phone"

/**
 * Gom bộ lọc (> 2 trường) vào một nút "Bộ lọc (n)" trên điện
 * thoại.
 *
 * - ≥640px: render `children` INLINE nguyên vẹn (không thêm DOM bọc) — desktop
 *   không đổi.
 * - <640px: nút `outline` "Bộ lọc" (+ "(n)" khi `activeCount` > 0) mở bảng trượt
 *   từ đáy chứa `children` (cột dọc, cao tối đa 85dvh, cuộn) + footer "Đặt lại"
 *   (ghost, chỉ khi có `onReset`) và "Xem kết quả" (nút chính: gọi `onApply` nếu có —
 *   màn lọc theo nút "Tìm"/submit — rồi đóng bảng).
 * `children` chỉ được render ở MỘT nơi tại một thời điểm (inline HOẶC trong
 * sheet; sheet đóng thì không mount) — state của control nên nằm ở cha.
 * Ô tìm kiếm chính để NGOÀI component này. Dropdown/Select bên trong sheet
 * portal ra body: nếu đóng nhầm sheet dùng dropdown inline.
 */
export function MobileFilterSheet({
  activeCount = 0,
  onReset,
  onApply,
  title = "Bộ lọc",
  children,
}: {
  activeCount?: number
  onReset?: () => void
  onApply?: () => void
  title?: string
  children: ReactNode
}) {
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  if (!isPhone) return <>{children}</>
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <SlidersHorizontal aria-hidden />
        {title}
        {activeCount > 0 ? ` (${activeCount})` : ""}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3 overflow-y-auto px-4">{children}</div>
          <SheetFooter className="flex-row gap-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {onReset && (
              <Button type="button" variant="ghost" onClick={onReset}>
                Đặt lại
              </Button>
            )}
            <Button type="button" className="flex-1" onClick={() => { onApply?.(); setOpen(false) }}>
              Xem kết quả
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
