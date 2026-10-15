/**
 * Nút chính của màn DANH
 * SÁCH ("Thêm …", "Tạo …") thành extended FAB trên điện thoại.
 *
 * Gắn thêm vào CHÍNH nút chính (`<Button>` mặc định) ở header:
 *   <Button className={MOBILE_FAB_CLASS}><Plus /> Thêm khách hàng</Button>
 *
 * Mọi class đều có tiền tố `max-sm:` ⇒ chỉ có hiệu lực < 640px; desktop/tablet
 * KHÔNG đổi 1 pixel. Vẫn là MỘT phần tử DOM (không nhân bản nút).
 *
 * - `bottom` cộng `env(safe-area-inset-bottom)` để không chạm thanh home của iOS.
 * - `z-40`: thấp hơn Dialog/Sheet (`z-50`) nên modal luôn phủ lên FAB.
 * - Không dùng chung 1 màn với `<MobileActionBar>` (cùng `z-40`, cùng đáy).
 * - `fixed` bị neo theo tổ tiên có `transform`/`filter`/`backdrop-filter`/
 *   `contain` — đừng đặt nút trong khối như vậy.
 */
export const MOBILE_FAB_CLASS =
  "max-sm:fixed max-sm:right-4 max-sm:bottom-[calc(1rem+env(safe-area-inset-bottom))] max-sm:z-40 max-sm:h-14 max-sm:rounded-2xl max-sm:px-5 max-sm:text-base max-sm:shadow-lg"
