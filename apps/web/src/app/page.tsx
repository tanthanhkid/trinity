import { redirect } from "next/navigation"

/**
 * Gốc `/` không hiển thị gì — luôn đá về đăng nhập.
 *
 * Bình thường `middleware.ts` đã bắt `/` trước khi tới đây (chưa đăng nhập →
 * `/login`, đã có phiên → `/dashboard`). Trang này là lớp chặn cuối cho những
 * đường vào không qua middleware (matcher đổi, chạy `next start` trần...).
 */
export default function RootPage() {
  redirect("/login")
}
