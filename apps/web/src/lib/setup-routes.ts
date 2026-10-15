import { isUnderRoute } from "@/lib/route-match"

/**
 * Khi hệ thống CHƯA dựng quy trình chỉ 3 nơi mở được: Bắt đầu · Hoạt động AI · Cài đặt (tối giản).
 * Mọi route khác chuyển về `/bat-dau`. Dùng `isUnderRoute` (không startsWith trần).
 */
export const SETUP_HOME = "/bat-dau"
export const SETUP_ALLOWED_ROUTES = [SETUP_HOME, "/ai-actions", "/settings"] as const

export function isAllowedBeforeSetup(pathname: string | null | undefined): boolean {
  return SETUP_ALLOWED_ROUTES.some((r) => isUnderRoute(pathname, r))
}

/** Khoá mục menu còn hiện khi chưa dựng. */
export const SETUP_MENU_KEYS = ["bat_dau", "ai_actions", "settings"] as const

/** Tab Cài đặt còn hiện khi chưa dựng (tối giản: tài khoản, người dùng, vai trò, team, kết nối AI, thông báo). */
export const SETUP_SETTINGS_TABS = ["profile", "users", "roles", "teams", "integrations", "notifications"] as const
