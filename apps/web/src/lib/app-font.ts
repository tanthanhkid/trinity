import { Inter } from "next/font/google"

/**
 * Font của giao diện app: Inter (giao diện mới theo demo `trinity-giao-dien-demo`).
 *
 * Nạp ở module RIÊNG (không phải `app/layout.tsx`): `next/font` khai
 * `@font-face` + class định nghĩa `--font-app-brand`; class đó được
 * `useAppDocumentTheme` gắn lên <html> ở các trang dashboard.
 *
 * ⚠️ BẮT BUỘC subset "vietnamese" — thiếu là mất dấu tiếng Việt ở glyph không
 * có trong latin/latin-ext. Inter là variable font nên không cần liệt kê weight.
 */
export const appFont = Inter({
  variable: "--font-app-brand",
  subsets: ["latin", "vietnamese"],
  display: "swap",
  preload: false,
})
