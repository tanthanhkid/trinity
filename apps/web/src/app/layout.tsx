import type { Metadata } from "next";
import { Inter, Montserrat } from "next/font/google";
import "./globals.css";
import Providers from "./providers";
import { SITE_CONFIG_INIT_SCRIPT } from "@/lib/site-config";
import { THEME_INIT_SCRIPT } from "@/lib/theme-script";

// Design system ds-v2 dùng font Montserrat. BẮT BUỘC subset "vietnamese" — thiếu là
// mất dấu tiếng Việt trên glyph không có trong latin/latin-ext.
//
// Cờ ds-v2 nay đọc LÚC CHẠY (`/site-config`), không còn biết lúc build: nạp CẢ HAI font, gắn cả hai
// biến CSS lên <html>; `globals.css` chọn `--font-app` theo `data-ds` (script <head> gắn attribute
// trước lần vẽ đầu). `next/font/google` không được gọi có điều kiện nên hai font luôn có mặt.
const montserratFont = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin", "vietnamese"],
});
const interFont = Inter({
  variable: "--font-inter",
  subsets: ["latin", "vietnamese"],
});

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
      // `data-ds="v2"` (scope token ds-v2 trong globals.css) KHÔNG gắn ở đây: do SITE_CONFIG_INIT_SCRIPT
      // trong <head> gắn theo `ds_v2` của /site-config; thiếu attribute = diện mạo mặc định.
      className={`${interFont.variable} ${montserratFont.variable} h-full antialiased notranslate`}
    >
      <head>
        <meta name="google" content="notranslate" />
        {/* Cấu hình lúc chạy (cờ ds-v2, realtime, pháp lý) nạp đồng bộ TRƯỚC mọi script khác để không nháy giao diện. */}
        <script dangerouslySetInnerHTML={{ __html: SITE_CONFIG_INIT_SCRIPT }} />
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
