"use client"

import { createContext, useContext, useState, type ComponentType, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"

/**
 * Header mục của Cài đặt có slot `actions`: nút chính của
 * mục nằm ở góc phải header, ngoài cùng phải. Mục (tab) dùng
 * `<SettingsSectionActions>` để đẩy nút của mình vào slot qua portal — không
 * phải đổi cấu trúc dữ liệu/hook của từng mục. Chưa có slot (vd render riêng
 * trong test) thì hiện tại chỗ như cũ.
 *
 * Điện thoại: prop `mobile` cho nút chính của mục:
 *  - `mobile="fab"` — mục DANH SÁCH ("Thêm …", "Tạo …"): CHÍNH MỘT nút `<Button>`
 *    trong `children` thành FAB dưới phải <640px (cùng class với
 *    `MOBILE_FAB_CLASS`, áp bằng variant con vì nút có thể nằm sau `<Can>`/
 *    `Tooltip`). Chỉ truyền ĐÚNG 1 nút nền đặc.
 *  - `mobile="bar"` — mục LƯU FORM ("Lưu …"): bọc `<MobileActionBar>` — thanh dính
 *    đáy <640px (Huỷ/Hoàn tác ghost TRƯỚC, nút chính CUỐI).
 *  - bỏ trống — giữ nguyên như cũ (nút nằm ở slot header).
 * ≥640px không đổi gì. Vì là portal vào header, `fixed` neo theo viewport miễn là
 * tổ tiên (SidebarInset/main/header) không có transform/filter — đã kiểm.
 * Không dùng `fab` và `bar` cùng một màn (cùng z-40, cùng đáy).
 */
const SlotContext = createContext<HTMLElement | null>(null)

/** Bản của `MOBILE_FAB_CLASS` áp lên nút (`data-slot=button`) bất kỳ cấp con nào. Test khoá không lệch. */
export const SETTINGS_FAB_SLOT_CLASS =
  "max-sm:[&_[data-slot=button]]:fixed max-sm:[&_[data-slot=button]]:right-4 max-sm:[&_[data-slot=button]]:bottom-[calc(1rem+env(safe-area-inset-bottom))] max-sm:[&_[data-slot=button]]:z-40 max-sm:[&_[data-slot=button]]:h-14 max-sm:[&_[data-slot=button]]:rounded-2xl max-sm:[&_[data-slot=button]]:px-5 max-sm:[&_[data-slot=button]]:text-base max-sm:[&_[data-slot=button]]:shadow-lg"

export function SettingsSectionActions({
  children,
  mobile,
}: {
  children: ReactNode
  mobile?: "fab" | "bar"
}) {
  const slot = useContext(SlotContext)
  let content: ReactNode = children
  if (mobile === "fab") content = <div className={`contents ${SETTINGS_FAB_SLOT_CLASS}`}>{children}</div>
  else if (mobile === "bar")
    // Spacer của MobileActionBar vô nghĩa trong header (main đã có pb-28) → ẩn.
    content = (
      <div className="contents max-sm:[&_[data-slot=mobile-action-bar-spacer]]:hidden">
        <MobileActionBar>{children}</MobileActionBar>
      </div>
    )
  if (!slot) return <>{content}</>
  return createPortal(content, slot)
}

export function SettingsSectionHeader({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: ComponentType<{ className?: string }>
  title: string
  description?: string
  children: ReactNode
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <SlotContext.Provider value={slot}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        {title && (
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold text-foreground">
            {Icon && <Icon className="size-[18px] shrink-0 text-muted-foreground" />}
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground max-sm:hidden">{description}</p>
          )}
        </div>
        )}
        <div ref={setSlot} className="flex shrink-0 flex-wrap items-center justify-end gap-2" />
      </div>
      {children}
    </SlotContext.Provider>
  )
}
