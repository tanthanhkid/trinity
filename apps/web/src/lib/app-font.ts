import { Inter } from "next/font/google"

/**
 * Font của giao diện app: Inter (giao diện mới theo demo `trinity-giao-dien-demo`).
 *
 * Nạp ở module RIÊNG (không phải `app/layout.tsx`): `next/font` khai
 * `@font-face` + class định nghĩa `--font-inter`; class đó được
 * `useAppDocumentTheme` gắn lên <html> ở các trang dashboard.
 *
 * MỘT instance duy nhất, dùng chung với `app/layout.tsx` (trước đây khai Inter hai lần với `preload`
 * khác nhau ⇒ cùng một font tải hai bản woff2 khác tên, ~130 kB thừa).
 *
 * ⚠️ BẮT BUỘC subset "vietnamese" — thiếu là mất dấu tiếng Việt ở glyph không
 * có trong latin/latin-ext. Inter là variable font nên không cần liệt kê weight.
 */
export const appFont = Inter({
  variable: "--font-inter",
  subsets: ["latin", "vietnamese"],
  display: "swap",
})
