import { Inbox, Package, Sparkles, Store } from "lucide-react"

import type { MenuItem } from "@/components/nav-config"

/**
 * Mục menu bổ sung ngoài `nav-config.ts`.
 *
 * Vì sao là file RIÊNG chứ không thêm thẳng vào `nav-config.ts`: giữ
 * `nav-config.ts` ổn định (ít thay đổi, nhiều nơi phụ thuộc thứ tự/khoá) —
 * mục menu mới chèn vào danh sách LÚC RENDER thay vì sửa file gốc.
 *
 * **"Sản phẩm"** — UI ở `app/(dashboard)/products/page.tsx`. Vị trí #2 trong
 * `EXTRA_MENU_ITEMS` (sau "Hộp thư"). `badgeLabel: "Mới"` hiện
 * nhãn "Mới" cạnh mục — chỉ `ShellLeafItem` đọc field này.
 *
 * RBAC quyền + phạm vi: mục này khai `permission: "products.view"`
 * — khớp `GET /products` (`@Can('products.view')`). Ai chỉ có `products.view`
 * (không có `products.manage`) vào chỉ xem, không thấy nút thêm/sửa/xoá.
 */

/**
 * **"Hộp thư"** (Zalo OA + Messenger) — UI ở `app/(dashboard)/inbox`. Đứng ngay dưới "Tổng quan" như bản demo.
 * Hiện khi có quyền của ÍT NHẤT một kênh — đúng luật hai hộp thư sẵn có trong Cài đặt > Kết nối & AI:
 * Zalo OA = `contacts.update`, Messenger = `integrations.webhooks` (kênh này còn theo công tắc `facebook_page`,
 * lọc ở trong trang — `inboxChannels`). Công tắc tổ chức `inbox` tắt ⇒ ẩn.
 * Không có số chưa đọc: app chưa có API đếm tổng tin chưa đọc.
 */
const INBOX_ITEM: MenuItem = {
  key: "inbox",
  title: "Tương tác",
  icon: Inbox,
  href: "/inbox",
  iconColor: "text-blue-600 dark:text-blue-400",
  anyOf: ["contacts.update", "integrations.webhooks", "social.post"],
  feature: "inbox",
}

const PRODUCTS_ITEM: MenuItem = {
  key: "products",
  title: "Sản phẩm",
  icon: Package,
  href: "/products",
  iconColor: "text-sky-600 dark:text-sky-400",
  badgeLabel: "Mới",
  permission: "products.view",
  feature: "products",
}

/**
 * POS bán hàng tại quầy. Quyền `pos.sell` (RBAC quyền + phạm vi,) — khớp `@Can` của
 * `services/commerce/src/pos`; thiếu quyền thì không thấy mục này (BE vẫn chặn 403 nếu gõ URL/gọi API).
 */
const POS_ITEM: MenuItem = {
  key: "pos",
  title: "Bán hàng (POS)",
  icon: Store,
  href: "/pos",
  iconColor: "text-emerald-600 dark:text-emerald-400",
  badgeLabel: "Mới",
  permission: "pos.sell",
  feature: "pos",
}

/**
 * Hoạt động AI: lịch sử thao tác ChatGPT/Claude đã thực hiện theo quyền người dùng (và, khi bật "Yêu cầu duyệt thay đổi do AI", nơi duyệt đề xuất).
 * Hiện cho ai được nối AI (`integrations.ai_connect`). Badge số đề xuất chờ duyệt (nếu có) do `AiActionsNavBadge` hiển thị.
 */
const AI_ACTIONS_ITEM: MenuItem = {
  key: "ai_actions",
  title: "Hoạt động AI",
  icon: Sparkles,
  href: "/ai-actions",
  iconColor: "text-indigo-600 dark:text-indigo-400",
  permission: "integrations.ai_connect",
}

/** Các mục menu bổ sung, theo thứ tự "Hộp thư", "Sản phẩm", "POS", "Hoạt động AI". */
export const EXTRA_MENU_ITEMS: readonly MenuItem[] = [INBOX_ITEM, PRODUCTS_ITEM, POS_ITEM, AI_ACTIONS_ITEM]

/** Mục đứng ngay TRƯỚC nhóm mục bổ sung. */
const ANCHOR_KEY = "dashboard"

/**
 * Trả về danh sách menu gốc (`nav-config.ts`) đã chèn các mục bổ sung vào
 * đúng vị trí (ngay sau "Tổng quan").
 *
 * KHÔNG lọc RBAC ở đây — caller (`ShellSidebar`) chạy `isItemVisible` trên danh
 * sách trả về, nên mục mới đi qua **đúng** bộ luật hiển thị hiện có
 * (quyền + `menu-visibility` cấu hình được ở Cài đặt), không có đường
 * tắt riêng.
 *
 * Mảng đầu vào được trả về NGUYÊN VẸN (không mutate) — `menuItems` là
 * `readonly` và dùng chung với `nav-config.ts`.
 */
export function withExtraMenuItems(
  items: readonly MenuItem[],
): readonly MenuItem[] {
  const anchor = items.findIndex((item) => item.key === ANCHOR_KEY)
  // Không tìm thấy mốc (ai đó đổi tên key "dashboard") → chèn lên ĐẦU thay vì
  // bỏ im lặng: mục menu biến mất là lỗi khó thấy, còn nằm sai vị trí thì thấy
  // ngay. Cùng tinh thần thà ồn ào hơn là âm thầm không làm gì.
  const at = anchor === -1 ? 0 : anchor + 1
  return [...items.slice(0, at), ...EXTRA_MENU_ITEMS, ...items.slice(at)]
}
