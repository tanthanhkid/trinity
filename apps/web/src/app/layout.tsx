import type { Metadata } from "next";
import { Inter, Montserrat } from "next/font/google";
import "./globals.css";
import Providers from "./providers";
import { DS_V2_ENABLED } from "@/lib/design-system-flags";
import { THEME_INIT_SCRIPT } from "@/lib/theme-script";

// Design system ds-v2 dùng font Montserrat. BẮT BUỘC subset "vietnamese" — thiếu là
// mất dấu tiếng Việt trên glyph không có trong latin/latin-ext.
//
// Cờ môi trường quyết định font nào ÁP, nhưng `next/font/google`
// KHÔNG được gọi có điều kiện — PHẢI nạp CẢ HAI font tại top-level module,
// chỉ CHỌN `.variable` nào gắn vào <html> là theo cờ lúc build. Cả 2 cùng
// bind chung tên biến CSS `--font-app` để globals.css/component không cần
// biết đang chạy font nào.
const montserratFont = Montserrat({
  variable: "--font-app",
  subsets: ["latin", "vietnamese"],
});
const interFont = Inter({
  variable: "--font-app",
  subsets: ["latin", "vietnamese"],
});
const appFont = DS_V2_ENABLED ? montserratFont : interFont;

export const metadata: Metadata = {
  title: "Trinity CRM",
  description: "Hệ thống Quản trị Tập trung - Trinity",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="vi"
      // class `dark` do script chống nháy gắn trước hydrate ⇒ khác SSR là có chủ đích.
      suppressHydrationWarning
      translate="no"
      // attribute scope cho token ds-v2 trong globals.css
      // (`:root[data-ds="v2"]`) — React bỏ hẳn attribute khi giá trị là
      // `undefined` nên cờ tắt = KHÔNG có data-ds, rơi về khối `:root` mặc
      // định (diện mạo mặc định).
      data-ds={DS_V2_ENABLED ? "v2" : undefined}
      className={`${appFont.variable} h-full antialiased notranslate`}
    >
      <head>
        <meta name="google" content="notranslate" />
        {/* Sáng/tối: gắn class `dark` trước khi vẽ để không nháy trắng (xem lib/theme.ts). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.addEventListener('error', function(e) {
                if (e.message && /loading chunk|failed to load chunk|dynamically imported module/i.test(e.message)) {
                  if (!sessionStorage.getItem('chunk-reload')) {
                    sessionStorage.setItem('chunk-reload', '1');
                    window.location.reload();
                  } else {
                    sessionStorage.removeItem('chunk-reload');
                  }
                }
              });
            `,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
