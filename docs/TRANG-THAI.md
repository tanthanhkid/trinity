# Năm trạng thái của một màn hình

"Đẹp" là khi mọi thứ chạy đúng. "Premium" là khi mạng chập chờn, máy chủ lỗi hay tài khoản còn trống mà màn hình vẫn nói thật và chỉ đường. Mỗi màn chính của Trinity web phải có đủ năm trạng thái dưới đây.

| Trạng thái | Phải có | Không được |
|---|---|---|
| **Đang tải** | Khung xương đúng hình nội dung sắp hiện (`LoadingBlock`, `Skeleton`), có `role="status"` | Màn trắng, chữ "Đang tải…" trơ trọi, khung xương quay mãi khi đã lỗi |
| **Trống** | Câu nói vì sao trống + **một** hành động tiếp theo (`EmptyState` với `action`). Đang lọc mà không khớp ⇒ nói "không khớp bộ lọc" + "Xoá bộ lọc" | Coi lỗi tải là "chưa có dữ liệu" |
| **Lỗi** | Nói chuyện gì xảy ra + cách sửa + nút **Thử lại** (`ErrorState`, gọi `refetch`) | Dòng chữ đỏ không có lối ra, chỉ hiện toast rồi để danh sách trống |
| **Mất mạng** | Dải báo ở đầu vùng nội dung (`OfflineBanner`), có mạng lại thì tự cập nhật + báo một câu | Im lặng (React Query tự dừng khi mất mạng nên người dùng tưởng app treo) |
| **Thành công** | Toast ngắn nói việc đã xong ("Đã ngắt kết nối Zalo OA") | Thao tác xong mà không có phản hồi gì |

## Thành phần dùng chung

- `components/ui/loading-block.tsx`: khung xương dòng chữ hoặc thẻ.
- `components/ui/empty-state.tsx`: trạng thái trống, có biểu tượng, câu giải thích và một hành động.
- `components/ui/error-state.tsx`: trạng thái lỗi. Nhận `error` (lấy câu giải thích qua `getApiErrorMessage`), `onRetry` và `retrying`. Có bản `compact` một dòng cho ô nhỏ như cột kanban hay thẻ.
- `components/offline-banner.tsx`: dải báo mất mạng, gắn sẵn trong `app/(dashboard)/layout.tsx`. Có hook `useOffline()` cho màn nào cần khoá nút gửi khi mất mạng.
- `lib/api-client.ts`, hàm `getApiErrorMessage`: yêu cầu không tới được máy chủ ⇒ "Không kết nối được máy chủ. Kiểm tra Internet rồi thử lại."; quá giờ ⇒ câu riêng.
- `app/(dashboard)/error.tsx`: lỗi hiển thị ⇒ "Thử lại" (dựng lại phần lỗi) trước, "Tải lại trang" là phương án cuối.

Quy ước: lỗi **khi chưa có dữ liệu** ⇒ `ErrorState` thay chỗ nội dung. Lỗi **khi đang có dữ liệu cũ** ⇒ giữ dữ liệu cũ, báo bằng toast.

## Cùng tình huống → cùng một mẫu

Người dùng học một lần, nhận ra ở mọi màn. Trước đợt này, "Chờ duyệt" có khoảng 9 kiểu hiển thị; "cần kết nối lại" có 4 cách nói ("Cần liên kết lại", "Cần cấp quyền lại"…) và 7 kiểu màu. Cùng một kênh còn đỏ ở màn Đăng đa kênh nhưng vàng ở màn Kết nối.

| Tình huống | Mẫu | Chữ | Màu |
|---|---|---|---|
| Trống | `EmptyState` | Vì sao trống + một hành động | Xám |
| Lỗi tải | `ErrorState` | "Không tải được …" + cách sửa + Thử lại | Hổ phách (biểu tượng) |
| Chờ người duyệt | `StatusTag kind="pending"` | "Chờ duyệt" (cụ thể hơn khi cần: "Chờ Kế toán duyệt", "Bản mới chờ duyệt") | Hổ phách |
| Kênh mất quyền truy cập | `StatusTag kind="reauth"` trong danh sách; `ReconnectNotice` trên thẻ kênh | "Cần kết nối lại" + vì sao + nút "Kết nối lại" | Hổ phách |
| Đang chạy / Đã tắt / Lỗi | `StatusTag kind="running" \| "off" \| "error"` | "Đang chạy", "Đã tắt", "Lỗi" | Xanh lá / xám / đỏ |

`components/ui/status-tag.tsx` giữ chữ chuẩn trong `STATUS_LABEL`, dùng chung cho toast và aria-label. Dòng kết nối dùng `StatusPill` cỡ nhỏ thì lấy chữ từ `STATUS_LABEL` để khớp câu chữ.

**Số và ngày** (`lib/format.ts`):

- Số đếm hiện ra luôn kèm đơn vị: `formatCount(12, "khách")` ⇒ "12 khách". Cột kanban ghi "12/15 card", không còn "12/15" trơ trọi.
- Số dùng `formatNumber` (1.234.567); tiền dùng `formatVnd` (1.250.000 ₫).
- Ngày: `formatDate` (21/10/2026), `formatDateTime` (14:30 21/10/2026), `formatDateTimeShort` (14:30 21/10) cho mốc gần trong danh sách dày. Luôn theo giờ Việt Nam, không tự gọi `toLocaleString` với tuỳ chọn riêng.

## Hoàn tác và khoảnh khắc hỏng

Bấm nhầm phải sửa được trong một nhịp, không qua hộp thoại thứ hai. `lib/undo.ts` có hai cách, cùng cửa sổ **5 giây** và cùng nút "Hoàn tác" trên toast:

| Cách | Khi nào | Hành vi |
|---|---|---|
| `deferWithUndo` | Thao tác máy chủ KHÔNG lùi được (xoá không có API khôi phục) | Ẩn ngay trên màn hình, chỉ gửi lệnh sau 5 giây. Hoàn tác ⇒ không gửi gì. Đóng tab trong lúc chờ ⇒ gửi ngay (`pagehide`) |
| `toastWithUndo` | Thao tác có đường ngược (đổi cột, gỡ kênh, xoá có API khôi phục) | Làm ngay; Hoàn tác gọi thao tác ngược |

Đang áp dụng:

- Xoá khách hàng hàng loạt và xoá card Kanban: xoá (mềm) ngay trên máy chủ. Hoàn tác gọi `POST /contacts/:id/restore` hoặc `POST /kanban/cards/:id/restore`, nên đóng tab hay đổi máy vẫn đúng.
  - Máy chủ chỉ cho người đã xoá hoặc Quản trị khôi phục, trong 10 phút, và vẫn trong phạm vi quyền.
  - Khách bị trùng SĐT với một khách đang có của cùng người phụ trách ⇒ 409, không khôi phục.
  - Không có tool MCP cho việc này.
- Xoá sản phẩm: lưu trữ (xoá mềm). Sản phẩm biến khỏi danh mục, POS và trang bán hàng; đơn cũ và liên hệ vẫn trỏ tới được.
  - Hoàn tác gọi `POST /products/:id/restore` (người đã xoá hoặc Quản trị, trong 10 phút).
  - Xoá hẳn (`DELETE /products/:id/permanent`): chỉ Quản trị, ở mục "Sản phẩm đã xoá (lưu trữ)", và chỉ khi chưa có đơn / liên hệ nào dùng (409 kèm lý do).
- Xoá bài nháp: deferred (chưa có API khôi phục).
- Kéo card sang cột khác (= đổi trạng thái): Hoàn tác đưa card về đúng chỗ cũ, giữa hai card hàng xóm cũ. Chỉ đổi thứ tự trong cùng cột thì không có toast.
- Gỡ kênh đăng bài: Hoàn tác bật lại kênh. Câu báo nói thật là bài chưa đăng lúc gỡ đã bị huỷ.

Hộp xác nhận của các thao tác này nói có Hoàn tác trong 5 giây, không còn "không hoàn tác được".

**Khoảnh khắc hỏng** phải nói rõ chuyện gì, ở đâu, và có nút làm lại ngay tại chỗ:

- Kênh mất kết nối: `ReconnectNotice` ở thẻ Fanpage, thẻ mạng ở Đăng đa kênh và Zalo OA. Có nút "Kết nối lại" mở lại luồng cấp quyền.
- Đăng bài lỗi: "Không đăng được lên <kênh>: <lý do>" + nút "Đăng lại" (viền, dễ thấy).

## Chữ lỗi

Mỗi câu lỗi trả lời hai câu hỏi: **chuyện gì xảy ra** và **làm gì tiếp**. Câu viết bằng tiếng Việt, không mã HTTP, không chữ tiếng Anh của máy chủ, không tên giao thức. Bảng chung ở `lib/error-messages.ts`:

| Loại | Khi nào | Câu hiện ra | Nút |
|---|---|---|---|
| `network` | Không có phản hồi | Không kết nối được máy chủ. Kiểm tra Internet rồi thử lại. | Thử lại |
| `timeout` | Quá giờ, 408, 504 | Máy chủ phản hồi quá lâu. Thử lại sau ít phút. | Thử lại |
| `session` | 401 | Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục — dữ liệu đã lưu không mất. | Đăng nhập lại |
| `forbidden` | 403 | Tài khoản của bạn chưa có quyền làm việc này. Nhờ quản trị viên cấp quyền ở Cài đặt › Vai trò. | (không) |
| `notFound` | 404 | Không tìm thấy dữ liệu. Có thể mục này đã bị xoá hoặc chuyển cho người khác — tải lại để xem bản mới nhất. | Thử lại |
| `conflict` | 409, 412 | Dữ liệu vừa được người khác thay đổi. Tải lại để xem bản mới nhất rồi làm lại. | Thử lại |
| `validation` | 400, 422 | Thông tin chưa hợp lệ. Kiểm tra lại các ô đã nhập. | (không) |
| `tooLarge` | 413 | Tệp quá lớn. Chọn tệp nhỏ hơn hoặc nén lại rồi tải lên. | (không) |
| `rateLimited` | 429 | Bạn thao tác hơi nhanh. Đợi khoảng một phút rồi thử lại. | Thử lại |
| `server` | 500 | Máy chủ đang gặp sự cố. Thử lại sau ít phút; vẫn lỗi thì báo quản trị viên kèm thời điểm xảy ra. | Thử lại |
| `maintenance` | 502, 503 | Hệ thống đang bảo trì hoặc khởi động lại. Thử lại sau vài phút. | Thử lại |
| `unknown` | Lỗi khác | Có trục trặc ngoài dự kiến. Thử lại; vẫn lỗi thì tải lại trang. | Thử lại |

Cách ghép câu:

- Màn hình chỉ truyền phần "việc gì không làm được": `getApiErrorMessage(err, "Không lưu được")` ⇒ "Không lưu được: máy chủ đang gặp sự cố. Thử lại sau ít phút; …". Đuôi "vui lòng thử lại" của câu cũ tự bỏ để khỏi nói hai lần.
- Máy chủ đã viết câu tiếng Việt cụ thể (vd "Số điện thoại đã tồn tại") ⇒ dùng nguyên câu đó, vì nó rõ hơn câu chung.
- Câu tiếng Anh hoặc mã lỗi của máy chủ ("Internal server error", "CONTACT_NOT_FOUND", "ThrottlerException…") không bao giờ hiện ra. Nhận biết bằng dấu tiếng Việt.
- `ErrorState` dùng cùng bảng: hết phiên thì có nút "Đăng nhập lại"; thiếu quyền thì không có "Thử lại" (thử cũng không được), chỉ có cách xin quyền.
- Các hàm lỗi riêng của từng mô-đun (`apiErrorMessage` ở webhook và vai trò, `aiActionErrorMessage`, `extensionErrorMessage`, lỗi chấm công) đều đi qua `errorMessage` của bảng chung.
- Trang lỗi toàn ứng dụng (`app/error.tsx`, `app/global-error.tsx`) không in `error.message`; lỗi đã gửi về nhật ký.

**Khoá ở mức mã nguồn** (`apps/web/src/__tests__/repo/error-text-guard.test.ts`, chạy trong CI). Test đỏ khi:

- tự đọc `response.data.message` mà không qua `errorMessage` / `getApiErrorMessage`;
- in `error.message` / `err.message` thô ra giao diện hoặc toast;
- `onError: () => toast.error("câu cố định")` (vứt lỗi thật — phải là `errorMessage(err, "câu")`);
- dùng câu chung chung ("Có lỗi xảy ra", "Đã xảy ra lỗi", "Something went wrong"…).

Ngoại lệ nằm trong `ALLOW` của test, mỗi dòng có lý do.

Câu màn hình đã tự giải thích cách sửa (vd "Không đọc được file. Kiểm tra đúng mẫu…") được giữ nguyên với lỗi dữ liệu. Mất mạng, máy chủ lỗi, thiếu quyền… vẫn nói thêm nguyên nhân thật.

Chữ "MCP" không xuất hiện trên giao diện: hướng dẫn nối trợ lý AI gọi là "địa chỉ kết nối". Tên biến môi trường (`INTEGRATIONS_*`) vẫn hiện ở các hướng dẫn cài đặt dành cho người tự cài máy chủ.

## Nền tảng UI

Đo trên Chrome headless (hồ sơ tạm, API giả qua CDP Fetch) bằng `apps/web/e2e/premium/ui-audit.mjs` và `contrast.mjs`, ngày 21/10/2026. Năm màn được đo: Tổng quan, Khách hàng, Kanban, Đăng đa kênh, Kết nối.

| Tiêu chí | Chuẩn | Cách đo |
|---|---|---|
| Vùng chạm | ≥ 44×44px trên điện thoại (360px) | Mọi nút/link/ô chọn đang hiện. Ô chọn trong `<label>` đo cả nhãn; link nằm giữa câu chữ được miễn |
| Tương phản | Chữ ≥ 4,5:1; biểu tượng, viền ô nhập ≥ 3:1 | Token màu thật, cả bản sáng lẫn tối |
| Focus bàn phím | Thấy được | Tab qua 25 phần tử đầu; phần tử đang focus phải có outline hoặc vòng (box-shadow) |
| Nhấn có phản hồi | Co nhẹ khi nhấn | `active:scale-[0.97]` ở `buttonVariants` và nút nhỏ trang chủ (link dạng nút trước đây không có) |
| Chuyển động ngắt được | Không còn animation dài khi bật "giảm chuyển động" | `prefers-reduced-motion: reduce` ⇒ đếm animation đang chạy > 10ms |
| Màn hẹp | Không cuộn ngang ở 360px | `scrollWidth − clientWidth` của trang |

**Kết quả** (trước → sau đợt sửa):

| Màn | Tràn ngang 360px | Vùng chạm < 44px | Focus thiếu viền | Animation khi giảm chuyển động |
|---|---|---|---|---|
| Tổng quan | 0 → 0 | 9 → 1 (*) | 0/25 | 0 |
| Khách hàng | 0 → 0 | 5 → 0 | 0/25 | 0 |
| Kanban | **291px → 0** | 0 → 0 | 0/25 | 0 |
| Đăng đa kênh | 0 → 0 | 8 → 0 | 0/25 | 0 |
| Kết nối | 0 → 0 | 0 → 0 | 0/25 | 0 |

(*) Còn link "Xem tất cả tính năng" (cao 21px, màu `--ring` 4,29:1) trong `home-ai-hub.tsx`. File này thuộc PR #48 nên sửa sau khi #48 gộp.

Đã sửa:

- **Kanban cuộn ngang cả trang ở 360px.** Chữ ẩn cho trình đọc màn hình (`sr-only`, `position:absolute`) ở cột xa bên phải bám ra `main` nên thoát khỏi khung cuộn của bảng. Thêm `relative` cho khung cuộn.
- **Vùng chạm**, chỉ đổi kích thước trên điện thoại:
  - nút "Mở"/"Xem chi tiết" thêm `min-w-11`;
  - link "Xem tất cả", "Xem báo cáo chi tiết";
  - nút bỏ điều kiện lọc 36 → 44px, nút tìm kiếm 40 → 44px;
  - chip "✦AI" dẫn sang Hoạt động AI;
  - tab "Kênh/Xem trước", nhãn "Thời điểm đăng", "Gắn UTM", "Quản lý mẫu".
- **Tương phản:**
  - chữ lỗi đỏ ở bản tối 3,61 → 7,66:1, nhờ đổi riêng `.text-destructive` sang mực đỏ của nhãn; nền nút xoá giữ nguyên;
  - biểu tượng cảnh báo ở `ErrorState` và trang lỗi 2,93 → 6,00:1 (amber-600 → `--color-app-tag-amber-ink`).
- **Nhấn có phản hồi:** link dạng nút ("Kết nối lại", "Tạo board", "Đăng nhập lại"…) và nút nhỏ ở trang chủ.

**Bảng tương phản** (sau khi sửa, `node e2e/premium/contrast.mjs`):

#### Chế độ sáng

| Cặp | Chữ | Nền | Tỉ lệ | Đạt |
|---|---|---|---|---|
| Chữ chính trên thẻ | `#17181c` | `#ffffff` | 17,74:1 | ✅ |
| Chữ phụ (muted) trên thẻ | `#6b6f7b` | `#ffffff` | 5,02:1 | ✅ |
| Chữ phụ (muted) trên nền trang | `#6b6f7b` | `#fbfbfa` | 4,85:1 | ✅ |
| Chữ phụ trong ErrorState/EmptyState (nền muted/30) | `#6b6f7b` | `#fcfcfb` | 4,89:1 | ✅ |
| ink-2 trên thẻ (mô tả, tóm tắt) | `#4a4d57` | `#ffffff` | 8,43:1 | ✅ |
| Biểu tượng màu ring trên thẻ | `#3f7fb3` | `#ffffff` | 4,29:1 | ✅ |
| Link primary-ink trên thẻ | `#285f8c` | `#ffffff` | 6,76:1 | ✅ |
| Nút chính: chữ trên primary | `#ffffff` | `#3a75a6` | 4,91:1 | ✅ |
| Chữ lỗi text-destructive trên thẻ (đăng bài lỗi) | `#c2413b` | `#ffffff` | 5,11:1 | ✅ |
| StatusTag Chờ duyệt / Cần kết nối lại | `#8a4f0d` | `#fbe8ca` | 5,46:1 | ✅ |
| StatusTag Đang chạy | `#277619` | `#e3f7ee` | 5,09:1 | ✅ |
| StatusTag Lỗi | `#b13442` | `#fde8ea` | 5,21:1 | ✅ |
| StatusTag Đã tắt | `#5c6a85` | `#e9eef4` | 4,67:1 | ✅ |
| ReconnectNotice: chữ đậm | `#17181c` | `#fbe8ca` | 14,78:1 | ✅ |
| ReconnectNotice: lý do (ink-2) | `#4a4d57` | `#fbe8ca` | 7,03:1 | ✅ |
| Gợi ý soạn bài khi mất kênh (amber-ink trên thẻ) | `#8a4f0d` | `#ffffff` | 6,55:1 | ✅ |
| Dải mất mạng (amber-900 / amber-50) | `#7b3306` | `#fffbeb` | 8,73:1 | ✅ |
| Biểu tượng cảnh báo ErrorState (amber-ink / muted) | `#8a4f0d` | `#f5f5f3` | 6,00:1 | ✅ |
| Viền ô nhập (input) trên thẻ | `#8a8d96` | `#ffffff` | 3,32:1 | ✅ |

#### Chế độ tối

| Cặp | Chữ | Nền | Tỉ lệ | Đạt |
|---|---|---|---|---|
| Chữ chính trên thẻ | `#eceef2` | `#131418` | 15,85:1 | ✅ |
| Chữ phụ (muted) trên thẻ | `#8d919c` | `#131418` | 5,84:1 | ✅ |
| Chữ phụ (muted) trên nền trang | `#8d919c` | `#0d0e11` | 6,12:1 | ✅ |
| Chữ phụ trong ErrorState/EmptyState (nền muted/30) | `#8d919c` | `#15161a` | 5,74:1 | ✅ |
| ink-2 trên thẻ (mô tả, tóm tắt) | `#b4b8c2` | `#131418` | 9,27:1 | ✅ |
| Biểu tượng màu ring trên thẻ | `#7fb2da` | `#131418` | 8,14:1 | ✅ |
| Link primary-ink trên thẻ | `#a6cbe8` | `#131418` | 10,81:1 | ✅ |
| Nút chính: chữ trên primary | `#0d0e11` | `#7fb2da` | 8,53:1 | ✅ |
| Chữ lỗi text-destructive trên thẻ (đăng bài lỗi) | `#f08b85` | `#131418` | 7,66:1 | ✅ |
| StatusTag Chờ duyệt / Cần kết nối lại | `#e0a24a` | `#2a2114` | 7,12:1 | ✅ |
| StatusTag Đang chạy | `#7fd3a2` | `#15261d` | 8,85:1 | ✅ |
| StatusTag Lỗi | `#f08b85` | `#2c1716` | 7,04:1 | ✅ |
| StatusTag Đã tắt | `#b4b8c2` | `#1d1f24` | 8,30:1 | ✅ |
| ReconnectNotice: chữ đậm | `#eceef2` | `#2a2114` | 13,63:1 | ✅ |
| ReconnectNotice: lý do (ink-2) | `#b4b8c2` | `#2a2114` | 7,98:1 | ✅ |
| Gợi ý soạn bài khi mất kênh (amber-ink trên thẻ) | `#e0a24a` | `#131418` | 8,27:1 | ✅ |
| Dải mất mạng (amber-100 / amber-950·40%) | `#fef3c6` | `#24120b` | 16,16:1 | ✅ |
| Biểu tượng cảnh báo ErrorState (amber-ink / muted) | `#e0a24a` | `#18191e` | 7,89:1 | ✅ |
| Viền ô nhập (input) trên thẻ | `#676b75` | `#131418` | 3,45:1 | ✅ |

## Cố tình phá

`apps/web/e2e/premium/break-it.mjs` cố tình làm hỏng từng thứ rồi kiểm màn hình có nói thật và có lối ra. Mỗi tình huống chạy trên một Chrome headless riêng, hồ sơ tạm, và mọi `/api/v1` bị chặn bằng CDP `Fetch` nên không gọi máy chủ thật. Mất mạng là mất mạng thật ở mức trình duyệt (`navigator.onLine = false`), không chỉ chặn API. Kết quả ngày 21/10/2026, sau khi sửa:

| Tình huống | Mong đợi | Thực tế | Đạt |
|---|---|---|---|
| `mat-mang-giua-luong` | Mất mạng giữa lúc dùng ⇒ dải 'Mất kết nối mạng' hiện; có mạng lại ⇒ dải tắt + báo 'Đã có mạng lại' | dải mất mạng: có; có mạng lại: dải tắt, toast có | ✅ |
| `mat-mang-luc-mo-trang` | Mở danh sách khách khi API không tới được ⇒ khung lỗi 'Không kết nối được máy chủ' + Thử lại (không phải 'chưa có khách') | Khách hàng — Xuất Excel Thêm khách Tất cả Của tôi Khách nóng Lọc 2 Sắp xếp Từ ngày: 14/10/2026 Đến ngày: 21/10/2026 Xoá hết điều kiện Không tải được danh sách k | ✅ |
| `api-500-roi-thu-lai` | API khách hàng trả 500 ⇒ 'máy chủ đang gặp sự cố' + Thử lại; máy chủ hết lỗi, bấm Thử lại ⇒ danh sách hiện | lúc lỗi: nói đúng; sau Thử lại: danh sách hiện | ✅ |
| `api-500-cac-man` | API chính của Kanban, Đăng đa kênh, Tổng quan trả 500 ⇒ mỗi màn hiện khung lỗi + Thử lại, không nói 'chưa có'/'0' | /kanban: đúng; /social?tab=posts: đúng; /dashboard: đúng | ✅ |
| `api-401-het-phien` | Phiên hết hạn (401 và làm mới token cũng 401) ⇒ về trang đăng nhập, không kẹt màn trắng/lỗi | URL: /login | ✅ |
| `danh-sach-trong` | Không có khách trong bộ lọc mặc định (7 ngày) ⇒ 'không khớp bộ lọc' + Xoá bộ lọc, nói một lần; bỏ lọc mà vẫn trống ⇒ 'Chưa có khách hàng nào' + Thêm khách; không có board ⇒ Tạo board | khách hàng: đúng; kanban: đúng | ✅ |
| `token-kenh-het-han` | Fanpage hết hạn token ⇒ 'Fanpage … cần kết nối lại' + lý do + nút Kết nối lại; kênh YouTube mất quyền ở Đăng đa kênh cũng vậy | Fanpage: có thông báo + nút; Đăng đa kênh: có thông báo | ✅ |
| `dang-bai-loi` | Bài đăng lỗi ⇒ 'Không đăng được lên <kênh>: <lý do>' + nút Đăng lại; bấm ⇒ gọi lệnh đăng lại | câu lỗi: đúng; nút: có; gọi đăng lại: có | ✅ |
| `hoan-tac-xoa-nhap` | Xoá bài nháp ⇒ biến mất ngay + toast Hoàn tác; bấm Hoàn tác ⇒ hiện lại, KHÔNG gửi DELETE; xoá lại và chờ 5 giây ⇒ gửi DELETE | ẩn ngay: có; Hoàn tác hiện lại: có; không gửi khi hoàn tác: đúng; hết 5 giây gửi DELETE: có | ✅ |

**Lệch đã tìm thấy và sửa:**

- Khách hàng, tải lỗi (mất mạng, 500): thanh phân trang dưới khung lỗi vẫn ghi "Không có khách hàng", tiêu đề ghi "0 khách". Trang vừa báo lỗi vừa khẳng định không có khách. Nay khung lỗi là thứ duy nhất nói; tiêu đề ghi "—".
- Khách hàng, danh sách trống: thanh phân trang lặp lại "Không có khách hàng" ngay dưới khung trống. Nay chỉ nói một lần.

Ghi chú: màn Khách hàng mặc định lọc 7 ngày gần nhất, nên trống ở lần mở đầu là "không khớp bộ lọc" + "Xoá bộ lọc". Bỏ lọc mà vẫn trống mới là "Chưa có khách hàng nào" + "Thêm khách".

## Dung lượng JS theo route

Next 16 (Turbopack) không còn in bảng dung lượng sau `next build`. `apps/web/scripts/route-js-size.mjs` (`pnpm --filter ./apps/web size:routes`) đo JS mỗi route nạp lần đầu (gzip mức 9). Danh sách chunk lấy từ `page_client-reference-manifest.js` cộng runtime trong `build-manifest.json`, khớp với `.next/diagnostics/route-bundle-stats.json` của Next. Chunk tải động (`next/dynamic`, `import()`) không được tính.

Job CI "Web build and UI checks" chạy script ngay sau `next build`: in bảng vào phần tóm tắt của job và báo đỏ khi một route vượt mức trong `apps/web/route-js-budget.json`. Mức ngân sách bằng số đo cộng 5%, làm tròn lên 5 kB; route mới chưa có trong file dùng `default_first_load_kb`. Nếu tăng có chủ đích, chạy `node scripts/route-js-size.mjs --write` và ghi lý do trong PR.

Phần nạp sau: biểu đồ Tổng quan, từng tab Báo cáo (chỉ tab đang mở), wizard Bắt đầu, bảng ⌘K (tải trước khi rê chuột hoặc focus vào ô tìm) và `socket.io-client` (chế độ poll không tải). Ngày 21/10/2026, mọi route trong ứng dụng giảm 36–124 kB gzip: Báo cáo 525 → 401 kB, Tổng quan 494 → 415 kB.

## Kiểm kê (21/10/2026)

✅ đủ · ⚠️ có nhưng yếu · ❌ thiếu. Cột "Sau" là trạng thái sau đợt sửa đầu tiên.

### Tổng quan (`/dashboard`)

| Trạng thái | Trước | Sau | Ghi chú |
|---|---|---|---|
| Đang tải | ✅ | ✅ | Khung xương ở mọi khối |
| Trống | ⚠️ | ✅ | Thêm lối sang Kanban cho khối "Việc cần làm hôm nay". "Khách gần đây" vẫn tự ẩn khi trống, có chủ ý |
| Lỗi | ❌ | ⚠️ | Số liệu kinh doanh: hết khung xương quay mãi, có Thử lại. Việc hôm nay: lỗi không còn hiện "Không có việc". **Còn lại:** khối Trợ lý AI/Kênh và "Cần bạn xem" (file của PR #48, sửa sau khi #48 gộp) |
| Mất mạng | ❌ | ✅ | `OfflineBanner` |
| Thành công | ✅ | ✅ | Bật tính năng có toast |

### Khách hàng (`/contacts`)

| Trạng thái | Trước | Sau | Ghi chú |
|---|---|---|---|
| Đang tải | ✅ | ✅ | |
| Trống | ⚠️ | ✅ | Chưa có khách ⇒ "Thêm khách". Lọc không khớp ⇒ "Xoá bộ lọc" |
| Lỗi | ❌ | ✅ | Trước: toast rồi hiện "Không tìm thấy khách hàng nào". Nay: `ErrorState` + Thử lại; dữ liệu cũ còn thì toast "đang hiện dữ liệu cũ" |
| Mất mạng | ❌ | ✅ | |
| Thành công | ✅ | ✅ | Xoá, chuyển hàng loạt |

### Pipeline / Kanban (`/kanban`)

| Trạng thái | Trước | Sau | Ghi chú |
|---|---|---|---|
| Đang tải | ⚠️ | ✅ | Danh sách board và chế độ Bảng chuyển sang khung xương |
| Trống | ⚠️ | ✅ | Chưa có board ⇒ "Tạo board" (người có quyền cấu hình) hoặc câu nhờ quản trị viên. **Còn lại:** board chưa có cột vẫn chỉ là chữ |
| Lỗi | ❌ | ✅ | Danh sách board, chi tiết board (trước: khung xương quay mãi), từng cột, chế độ Bảng |
| Mất mạng | ❌ | ✅ | |
| Thành công | ✅ | ✅ | Kéo thẻ lạc quan, lỗi thì toast; đổi cột và xoá card có Hoàn tác 5 giây |

### Kênh (`/connections`: Facebook, Zalo OA)

| Trạng thái | Trước | Sau | Ghi chú |
|---|---|---|---|
| Đang tải | ⚠️ | ⚠️ | Zalo OA chuyển sang khung xương. **Còn lại:** Facebook vẫn là vòng quay |
| Trống | ✅ | ✅ | Facebook: chỉ cách kết nối Fanpage |
| Lỗi | ⚠️ | ✅ | Facebook có Thử lại. Zalo OA tách "tính năng đang tắt" (404) khỏi lỗi thật |
| Mất mạng | ❌ | ✅ | |
| Thành công | ⚠️ | ✅ | Thêm toast khi ngắt Zalo OA |

### Đăng đa kênh (`/social`)

| Trạng thái | Trước | Sau | Ghi chú |
|---|---|---|---|
| Đang tải | ⚠️ | ✅ | Trang (trước: màn trắng), kênh, bài, nháp đều có khung xương |
| Trống | ✅ | ✅ | "Soạn bài đầu tiên", "Đến mục Kênh" |
| Lỗi | ❌ | ✅ | Kênh: trước hiện lưới trống. Soạn bài: trước báo sai "Chưa có kênh nào được liên kết". Bài, nháp, lịch, thư viện, thống kê: `ErrorState` + Thử lại |
| Mất mạng | ❌ | ✅ | Dải báo chung; nút Đăng/Hẹn giờ/Lưu nháp khoá khi mất mạng, kèm câu giải thích |
| Thành công | ✅ | ✅ | |

### Hộp thư, Sản phẩm, Bán hàng (POS), Nhân sự (đợt 2, 21/10/2026)

| Màn | Trước | Sau |
|---|---|---|
| Hộp thư (`/inbox`) | Tương tác tải lỗi ⇒ "Chưa có tương tác nào khớp bộ lọc"; lỗi hội thoại / đánh giá chỉ là chữ đỏ; mất mạng vẫn bấm Gửi | `ErrorState` + Thử lại ở Tương tác, Tất cả hội thoại, Zalo, Facebook, Google; ô soạn tin khoá Gửi khi mất mạng (vẫn gõ được, nói rõ) |
| Sản phẩm (`/products`) | Tải lỗi ⇒ "Chưa có sản phẩm nào"; Ẩn/Hiện lại lỗi thì im lặng, xoá xong không báo | `ErrorState`; Ẩn/Hiện lại có toast + **Hoàn tác** (đảo lại bằng chính API); xoá có toast; nhãn trạng thái dùng `StatusTag` |
| POS (`/pos`) | Không đọc được ca ⇒ mời "Mở ca" (có thể đang có ca mở thật); đơn / lịch sử ca lỗi ⇒ trống; mất mạng vẫn bấm Thanh toán | Ca lỗi ⇒ `ErrorState`, không mời Mở ca; thực đơn / đơn / ca / báo cáo có Thử lại; **mất mạng khoá Lưu đơn / Thanh toán / Huỷ đơn** + câu "giỏ hàng vẫn giữ nguyên" |
| Nhân sự (`/management/employees`) | Tải lỗi ⇒ "Chưa có nhân viên nào"; vòng quay hiện lại mỗi lần tải nền; xoá không hoàn tác được | `ErrorState`; khung xương chỉ lần đầu; trống có "Thêm nhân viên"; **xoá có Hoàn tác 5 giây** (chưa có API khôi phục ⇒ hoãn gửi); lưu khoá khi mất mạng |
| Đơn trang bán hàng (`/connections?muc=ban-online`) | Đổi trạng thái (kể cả huỷ) không có phản hồi | Toast + **Hoàn tác** (đổi lại trạng thái cũ) |

`ui-audit.mjs` nay đo cả 9 màn (0 lỗi sau khi sửa vùng chạm của chip lọc Tương tác và nút Thống kê). `break-it.mjs` thêm 3 tình huống (13/13 đạt):

- 500 ở Sản phẩm / Nhân sự / ca POS;
- POS mất mạng;
- Ẩn sản phẩm rồi Hoàn tác.

## Việc còn lại

- Đã xong (phần G):
  - Đăng đa kênh: lịch, thư viện, thống kê dùng `ErrorState`. Thư viện lỗi không còn hiện "Thư viện trống".
  - Mất mạng thì khoá nút Đăng/Hẹn giờ/Lưu nháp và nói rõ bài đang soạn vẫn giữ nguyên.
  - Nhãn "Chờ duyệt" của đề xuất AI dùng `StatusTag`.
  - "Cần bạn xem": chấm "đang chờ" màu hổ phách thay vòng nét đứt; tổng có đơn vị ("3 mục"). `NeedsReviewView` đã nhận `error`/`onRetry`.
- Còn chờ PR #48 gộp (cùng file `dashboard-home.tsx`, `home-ai-hub.tsx`):
  - Truyền lỗi vào "Cần bạn xem" (hiện đang coi lỗi là "không có gì").
  - Thêm Thử lại cho khối Trợ lý AI/Kênh.
  - Áp `StatusTag`/`ReconnectNotice` cho khối Kênh trên Tổng quan.
- Hoàn tác cho các thao tác xoá/đổi trạng thái ở màn khác (nhân sự, sản phẩm, đơn hàng…) dùng cùng `lib/undo.ts`.
