# Tốc độ vòng 3 — mở lại tức thì

Mục tiêu: các màn chính hiện dữ liệu dưới 1 giây, cả lần đầu và lần mở lại.

## Đã làm
- **Service Worker** (`apps/web/scripts/sw-template.js`, sinh `out/sw.js` ở `make-sw.mjs`): `/_next/static/*` cache-first (chunk các màn chính được precache lúc cài), HTML và payload RSC `.txt` mạng trước với hạn 1,5 giây rồi tới bản đã lưu (sau deploy không nạp HTML cũ trỏ chunk đã mất; tối đa 100 mục). Không đụng `/api`, `/notif-ws`, `/uploads`, `/docs`, `/.well-known`, `/oauth`, `/s/*`; không lưu chuyển hướng/lỗi. Mã build (từ thư mục `_next/static/<id>` có `_buildManifest.js`) đổi ⇒ SW mới `skipWaiting` + `clients.claim`; activate giữ cache chunk của bản liền trước (tab cũ còn cần chunk lười), xoá các bản cũ hơn.
  - **Tắt khẩn**: đặt `TRINITY_SW_KILL=1` hoặc tạo tệp `sw-kill` CẠNH `WEB_DIR` (`<WEB_DIR>/../sw-kill`; không đặt trong `out/` vì build xoá thư mục này) ⇒ Rust trả `/sw.js` dạng tự huỷ (xoá cache `trinity-*`, huỷ đăng ký, tải lại tab). Không cần build lại. Xoá tệp/biến để bật lại; trang cũng tự gỡ đăng ký khi thấy bản tự huỷ.
  - `/sw.js` do Rust trả `Cache-Control: no-cache` và không qua luật chuyển hướng theo cookie. Nếu lớp đệm phía trước (CDN/Caddy) ghi đè `Cache-Control` cho tệp này thì bản mới trễ tối đa theo `s-maxage` của lớp đó; nên loại `/sw.js` khỏi luật ghi đè.
- **Cache dữ liệu trên máy** (`lib/query-persist.ts`, `lib/local-cache.ts`): kết quả React Query lưu IndexedDB `trinity-cache`, khoá `rq:<công ty>:<người dùng>`, hết hạn 24 giờ, đổi `PERSIST_BUSTER` để bỏ cache khi đổi hình dạng dữ liệu. Không lưu token; loại query có khoá chứa `api-key|secret|token|password|oauth|credential|mcp|webhook|inbound-source|2fa|otp`; bỏ query > 256 KB, tổng ≤ 4 MB. `clearTokens()` (đăng xuất, hết phiên, vào trang đăng nhập) xoá IndexedDB và bộ nhớ HTML của SW và phát tín hiệu sang các tab khác (BroadcastChannel + `storage`): mỗi tab dừng ghi, xoá cache trong bộ nhớ, và ghi lại khi có token mới. Đổi danh tính (người dùng hoặc công ty) xoá cache trong bộ nhớ trước khi nạp/ghi khoá mới; mỗi lượt ghi kiểm còn token.
- **Early Hints**: HTML trang thật có header `Link: <…>; rel=preload; as=script|style|font` cho JS/CSS/font `/_next/static/` mà HTML nạp ngay (≤ 3 KB, bỏ `nomodule`). HTML tĩnh dùng chung cho mọi người ⇒ header không chứa dữ liệu riêng.
- **Nạp trước dữ liệu khi rê chuột menu** (`lib/route-prefetch.ts`, qua `HoverLink`): hiện làm cho Hộp thư (khoá và hàm nạp dùng chung với màn qua `lib/inbox-queries.ts`).
- **Hộp thư chậm**: `/interactions` sắp theo `commented_at`/`last_message_at` và `/interactions/stats` đếm theo ngày trên `facebook_comments`, `facebook_messages`, `zalo_oa_messages` chưa có chỉ mục thời gian ⇒ migration `0029_chi_muc_tuong_tac`.

## Không làm và lý do
- **Nhúng dữ liệu bootstrap vào HTML**: HTML có dữ liệu người dùng mà lớp đệm phía trước đặt `s-maxage` cho HTML thì lộ dữ liệu giữa người dùng; rủi ro lớn hơn lợi ích khi đã có cache IndexedDB.
- **JS màn đầu < 300 KB nén**: gói dùng chung hiện ~326 KB nén (đo bằng `size:routes:export`), trong đó React + Next ≈ 130 KB, `@base-ui/react` ≈ 45 KB, axios ≈ 17 KB, sonner ≈ 11 KB, tailwind-merge ≈ 8 KB; mã ứng dụng dùng chung mỏng. Các thư viện nặng khác (xyflow, dnd-kit, markdown, cmdk, posthog, motion) đã nằm ngoài gói dùng chung. Muốn xuống dưới 300 KB phải thay base-ui hoặc axios (đổi lớn), để vòng sau. Từ lần mở thứ hai, SW phục vụ JS từ máy nên không còn tải lại.

## Ghi chú
- Migration `0029` tạo chỉ mục không `CONCURRENTLY` (khoá ghi ngắn); chấp nhận được vì bảng tương tác ở prod còn nhỏ. Bảng lớn hơn thì nên đổi sang tạo song song.
- Cache dữ liệu: loại query có `meta.persist === false`, `gcTime`/`staleTime` vô hạn, dữ liệu chứa URL `blob:`, khoá `media-file`; hạn 24 giờ tính theo `dataUpdatedAt` của từng query (khi ghi và khi nạp). Service Worker không đăng ký ở `/s/*`, `/oauth/*`, `/privacy`, `/terms`, `/invite`, `/register` và host cửa hàng.
