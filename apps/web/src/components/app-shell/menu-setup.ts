import { Rocket } from "lucide-react"
import type { SetupStatus } from "@trinity/rbac"
import type { MenuItem } from "@/components/nav-config"
import { SETUP_HOME, SETUP_MENU_KEYS } from "@/lib/setup-routes"

/** Mục "Bắt đầu": hướng dẫn người mới — Trinity có gì, việc cần làm tiếp (nối AI, dựng quy trình…). Mở cho mọi người đã đăng nhập (người không phải quản trị thấy lời nhắn chờ). */
export const SETUP_ITEM: MenuItem = {
  key: "bat_dau",
  title: "Bắt đầu",
  icon: Rocket,
  href: SETUP_HOME,
  iconColor: "text-amber-600 dark:text-amber-400",
}

/**
 * Menu theo trạng thái dựng: `chua_dung` ⇒ CHỈ Bắt đầu · Hoạt động AI · Cài đặt; `dang_dung` ⇒ menu theo gói + Bắt đầu lên đầu;
 * `da_dung` ⇒ menu hiện có + Bắt đầu ở cuối (mở lại hướng dẫn người mới). Không mutate đầu vào; chạy TRƯỚC lọc RBAC như mọi lớp menu khác.
 */
export function withSetupMenu(items: readonly MenuItem[], status: SetupStatus): readonly MenuItem[] {
  if (status === "da_dung") return [...items, SETUP_ITEM]
  if (status === "dang_dung") return [SETUP_ITEM, ...items]
  const keep = new Set<string>(SETUP_MENU_KEYS)
  const rest = items
    .filter((i) => keep.has(i.key))
    .map((i) => (i.key === "ai_actions" ? { ...i, title: "Hoạt động AI" } : i))
  return [SETUP_ITEM, ...rest]
}
