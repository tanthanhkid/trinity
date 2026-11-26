# Phản biện lần 5 (kiểm chốt): PLAN.md và ISSUES.md (viết lại backend bằng Rust)

Ngày 26/11/2026 · Worktree `rust-plan` (HEAD `fef6dab`, `docs/rust` chưa commit) · Người phản biện độc lập. Không sửa
plan hay mã, không build hay test. Không phản biện các quyết định trong `DECISIONS.md`, chỉ nêu hệ quả kỹ thuật chưa được ghi.

## Tóm tắt

| Phần | Kết quả |
|---|---|
| A. 11 phát hiện lượt 4 | 9 ĐÃ XỬ LÝ · 2 ĐÃ XỬ LÝ nhưng cách sửa chưa đủ (B-QT-2 → B5-QT-1; N-5 → B5-N-5). Không mục nào CHƯA hay SAI |
| B. Phát hiện mới | **0 CHẶN · 2 QUAN TRỌNG · 7 NHỎ** |
| `check-issues.py` | 185 issue = 38 S + 97 M + 50 L = 216 ngày-agent; 0 trùng, 0 tham chiếu thiếu, **0 vòng**. Theo nhóm: G 19,5 · C 31,5 · K+D+T+W 38 · M 98 · X 25 (= 10,5 GĐ 4 + 14,5 GĐ 5). Khớp PLAN mục 0, 7, 11, Lịch sử lượt 4 và cuối ISSUES (X06 23,5; D01 10,5; X02a 12; W02b 21). Chuỗi ghi tay `R005 → K06 → K08` dài bằng chuỗi script in `G12a → G12b` (3 = 3) |

**Kết luận: CHƯA ĐỦ**: còn 2 QUAN TRỌNG, cả hai sửa bằng vài dòng trong G16/K16 và W03, không thêm giai đoạn, không
đụng đường găng. Làm ngay được R001–R006, G01–G15, C01–C18 và các issue K không nằm sau K16 (G16, K16, K17 chờ sửa luật IP; W03 chờ chọn phương án).

---

## A. Trạng thái các phát hiện lượt 4

| Mã | Trạng thái | Kiểm ở đâu | Ghi chú |
|---|---|---|---|
| B-QT-1 (Docker công khai giữa W01 và X06) | ĐÃ XỬ LÝ | W01 (ISSUES:132) giữ route handler `/api/v1`, `/uploads`, `/api/build-id`, `/api/fe-logging`; W02b (:134) "merge ngay trước X06", X06 phụ thuộc W02b; D01 ghi lai chỉ cho bản tự dựng; PLAN 5 (thứ tự 6 bước + lý do) | Phương án (b). Hệ quả chưa ghi: W03 vẫn đổi web sang `/site-config` mà Node không có (B5-QT-2); quan hệ "ngay trước X06" chưa có trong đồ thị (B5-N-1) |
| B-QT-2 (tên miền không proxy, tin `cf-connecting-ip`) | ĐÃ XỬ LÝ, **cách sửa chưa đủ** | PLAN 4.13 (bỏ gợi ý, giới hạn 95 MB tới X15a); G16 (:56); K16 (:109) | Bỏ gợi ý: đúng. Nhưng luật mới "tin khi nguồn TCP thuộc dải Cloudflare **hoặc loopback/mạng riêng**" không chặn gì trong mọi cách triển khai có tài liệu: B5-QT-1 |
| N-1 (cổng tương thích 4000) | ĐÃ XỬ LÝ | PLAN 4.13 (`COMPAT_API_PORT`, `0.0.0.0` trong container, loopback ở host); X06 (:226) | Còn hai chỗ cổng chưa ghi: B5-N-2, B5-N-3 |
| N-2 (ba dạng con trỏ) | ĐÃ XỬ LÝ | PLAN 4.4 (dòng 664–676); tiêu chí chung M.. (ISSUES đầu tệp, mục 4) | Đối chiếu `contacts.service.ts:384-392`: sắp có chọn luôn kèm `id` làm khoá phụ nên kết quả trang 2 xác định, tái tạo được |
| N-3 (`SOCIAL_MAX_VIDEO_MB` ở bản TS) | ĐÃ XỬ LÝ | G15 (:55); PLAN 4.13 | Lưu ý cài đặt ở B5-N-6 |
| N-4 (khung giờ `stale-work.digest`) | ĐÃ XỬ LÝ | PLAN mục 3 (507–511), 10.2 (1233); M24 (:171); X01 (:217) | Đối chiếu `stale-work.service.ts:131-145`, `stale-work.config.ts:13,25`: điều kiện "giờ VN < `digest_hour` hoặc dấu = hôm nay, với mọi công ty bật cờ" đúng với mã |
| N-5 (chuẩn so sau X06) | ĐÃ XỬ LÝ, **chưa trọn** | PLAN 6.2 (1009–1011); X06 | Bảng 6.1 dòng 942 vẫn ghi golden "không phải chuẩn so"; golden ghi từ thời C chưa được ghi lại trước X06: B5-N-5 |
| N-6 (bảng giai đoạn) | ĐÃ XỬ LÝ | PLAN 7 (1077–1081) | Script: G 19,5; K+D+T+W 38; X 25 = 10,5 + 14,5. Còn chữ "66 issue" ở GĐ 4: B5-N-7 |
| N-7 (tách X15) | ĐÃ XỬ LÝ | X15a, X15b (:239–240); PLAN 4.13 | |
| N-8 (W01 xoá `build-id`, `fe-logging`, `nest-bridge`) | ĐÃ XỬ LÝ | W01 (:132); `nest-bridge` chỉ còn ở G11 (:50) | |
| N-9 (X14 trước X06; máy chủ tĩnh của W02a) | ĐÃ XỬ LÝ | X14 (:238) nhận tham số nhánh, X06 chạy trên nhánh mình; W02a (:133) có luật trả trang giữ chỗ | |

---

## B. Phát hiện mới

### QUAN TRỌNG

#### B5-QT-1. G16/K16 "tin `cf-connecting-ip` khi nguồn là loopback hoặc mạng riêng" không chặn được giả IP trong bất kỳ cách triển khai nào có tài liệu

- **Liên quan:** G16 (ISSUES:56), K16 (:109), K17 (:110), PLAN 4.13 dòng 808–815; quyết định 8 (sau Cloudflare).
- **Bằng chứng:**
  - **Docker compose (đường duy nhất của người tự cài tới X06):** trình duyệt gọi `/api/v1` vào Next, route handler
    chép **mọi** header của client sang Node, chỉ bỏ `host`, `connection`, `transfer-encoding`
    (`apps/web/src/app/api/v1/[...path]/route.ts:130-133`). Node luôn thấy nguồn TCP là container `web` (172.16/12, mạng
    riêng) ⇒ theo luật G16 luôn tin `CF-Connecting-IP` do client tự gửi. Cổng web được công bố ra mọi địa chỉ
    (`docker-compose.yml`: `"${WEB_PORT:-3000}:3000"`), nên ai gửi thẳng tới origin kèm header giả vẫn qua.
  - **PM2/VPS:** Next gọi Node qua `localhost:4000` (cùng route handler, `.env.example:63`) ⇒ nguồn loopback ⇒ tin.
  - **Reverse proxy trên host** (`docs/deployment.md:32,37` hướng dẫn Caddy/nginx; Cloudflare Origin Certificate thường
    gắn ở đây): nginx/Caddy mặc định chuyển nguyên header của client, nguồn tới app là loopback ⇒ tin. Áp cho cả
    Node (G16) lẫn Rust (K16) khi Rust đứng sau Caddy/nginx.
  - Hàm sẵn có `isPrivateOrLoopbackIp` (`attendance-ip.helper.ts:27-36`) đúng là để tin `x-real-ip`/`x-forwarded-for`
    do proxy nội bộ **tự ghi đè**; `CF-Connecting-IP` thì không proxy nội bộ nào ghi đè, nên đem cùng luật đó áp cho nó
    là sai loại.
  - Tiêu chí của G16 và K16 chỉ có ca "gửi thẳng từ IP ngoài dải" (tới tiến trình đang nghe loopback hoặc sau Next), nên
    test xanh trong khi lỗ vẫn còn; PLAN 4.13 và Lịch sử lượt 4 ghi lỗi này là "đã sửa".
- **Tác động:** kiểm IP chấm công (ảnh hưởng lương) và cổng Wi-Fi đăng nhập vẫn giả được như trước; lớp chặn duy nhất
  còn lại là tường lửa origin theo dải Cloudflare, thứ PLAN coi là "lớp thứ hai".
- **Đề xuất:** viết lại luật ở G16 và K16 theo "chặng ngoài cùng": `CF-Connecting-IP` chỉ được tin khi **địa chỉ đã nối
  tới proxy ngoài cùng** thuộc `CLOUDFLARE_IP_RANGES`. Cụ thể: nguồn TCP công khai thì xét chính nó; nguồn loopback/mạng
  riêng thì xét chặng do proxy tin cậy ghi (chặng phải cùng của `x-forwarded-for`/`x-real-ip` mà proxy đó đặt), không
  xét header client. Cloudflare Tunnel (cloudflared tự ghi đè `CF-Connecting-IP`) bật bằng cờ riêng, vd
  `CF_TUNNEL=true`, thay vì suy từ "loopback". Ở bản TS, route handler của Next phải chuyển kèm IP nguồn của nó (đặt
  `x-real-ip` = IP socket, xoá `cf-connecting-ip` của client khi chặng đó không thuộc dải Cloudflare). Thêm ca test:
  "qua Next/Caddy nội bộ kèm `CF-Connecting-IP` giả, chặng ngoài không thuộc dải Cloudflare ⇒ bỏ qua"; ghi
  `CLOUDFLARE_IP_RANGES` mặc định lấy từ danh sách công bố của Cloudflare và cách cập nhật.

#### B5-QT-2. W03 làm hỏng trang pháp lý và cờ giao diện của bản phát hành công khai (và của cấu hình lai) từ lúc merge tới X06

- **Liên quan:** W03 (ISSUES:135, phụ thuộc W02a, K27; ∥ `có`), K27 (:120), PLAN 5 (dòng "Trang `/privacy`, `/terms`"),
  hệ quả của việc dời W02b về sát X06 ở lượt 4.
- **Bằng chứng:**
  - W03 đổi web sang lấy `/privacy`, `/terms` (`LEGAL_*`), `NEXT_PUBLIC_REALTIME_MODE`, `NEXT_PUBLIC_DS_V2` từ
    `GET /api/v1/site-config`. Endpoint này chỉ có ở Rust (K27); bản TS không có (`grep site-config` trong `services/`
    và `apps/web/src` ra 0 dòng) và đang đóng băng tính năng (quyết định 6).
  - W03 không phụ thuộc W02b/X06, nên merge sớm và đi vào mọi bản phát hành `trinity-web` từ đó tới X06. Theo chính
    PLAN 5 lượt 4, các bản đó chạy với compose cũ, không có Rust ⇒ `/site-config` 404. Trang `/privacy`, `/terms` hiện
    render ở máy chủ từ env (`components/legal-page.tsx:23-38`, `force-dynamic`) sẽ mất tên đơn vị vận hành, mã số
    thuế, email liên hệ; với bản cài dùng Facebook, URL chính sách là thứ Meta đòi.
  - Cấu hình lai của chủ dự án cũng hỏng như vậy cho tới khi route `site-config` được giao cho Rust trong tệp sở hữu
    (mặc định "mọi thứ thuộc Node", D01).
  - Cùng loại lỗi mà B-QT-1 lượt 4 vừa sửa cho route handler.
- **Đề xuất (chọn một, ghi vào W03):** (a) W03 phụ thuộc W02b (đi cùng bản phát hành với X06), rẻ nhất; hoặc (b) W03
  chỉ áp cho bản `build:export`, bản `standalone` giữ đọc env ở máy chủ, kèm tiêu chí "compose cũ: `/privacy` còn
  `LEGAL_COMPANY_NAME`"; hoặc (c) web lùi về giá trị lúc build khi `/site-config` trả 404. Đồng thời ghi K27 thuộc đợt
  nào trong tệp sở hữu.

### NHỎ

| # | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|
| B5-N-1 | "W02b merge ngay trước X06" chỉ nằm trong chữ, đồ thị không có. W02b chỉ phụ thuộc `W02a, K18, D01, W04, X12e`, còn X06 chờ thêm X03 (báo cáo shadow 7 ngày), X04, X05, X09, X10, X14. Merge W02b khi X12e xong thì (1) `docker-compose.yml` trên `main` mất service `web` mà chưa có image `trinity` (X06 mới tạo), trái "`main` luôn chạy được"; (2) luật "không gắn tag giữa W02b và X06" khoá luôn bản sửa lỗi (quyết định 6 vẫn cho) trong nhiều tuần. Script in W02b = 21 cũng vì thế mà sớm hơn thực tế | ISSUES:134, :226; PLAN 5 bước 6 | W02b phụ thuộc thêm X03, X04, X05, X09, X10, X14 (chỉ còn X06 sau nó), hoặc ghi W02b là PR xếp chồng dưới X06, merge liền nhau; X14 đã chạy trên nhánh X06 nên nhánh đó phải chứa W02b |
| B5-N-2 | Chưa ghi binary đọc **cổng chính** từ biến nào. PLAN 4.13 "giữ nguyên tên biến trong `.env.example`", mà ở đó `PORT=4000` là cổng của API Node (`.env.example:19`). Bản cài PM2 nâng cấp dùng lại `.env` thì binary nghe 4000 trùng `COMPAT_API_PORT` mặc định 4000, còn luật reverse proxy "trang → 3000" mất đích | PLAN 4.13 dòng 805–807, 830–836; X06 | Ghi tên biến cổng chính (vd `WEB_PORT`/`TRINITY_PORT`, mặc định 3000), `PORT` thuộc nhóm biến bỏ qua kèm cảnh báo; khởi động báo lỗi rõ khi cổng chính trùng cổng tương thích |
| B5-N-3 | Compose cũ công bố cổng API là `127.0.0.1:${API_PORT:-4000}:4000` (`docker-compose.yml:105`); X06 ghi compose mới "chỉ công bố `127.0.0.1:4000`". Người đã đặt `API_PORT` khác (vì 4000 bị chiếm) và trỏ `/notif-ws` vào đó mất chuông sau nâng cấp | X06 (:226); `docs/deployment.md:32,37` | Compose mới giữ vế host `${API_PORT:-4000}` (vế container là `COMPAT_API_PORT`); X14 thêm ca `API_PORT=4100` |
| B5-N-4 | Compose lai của D01 đặt `web` chung network namespace với `trinity`, Rust nhận cổng 3000; Next standalone mặc định cũng nghe 3000 (service `web` không đặt `PORT`), nên trùng cổng trong cùng namespace | D01 (:130); `docker-compose.yml:119-135` | D01 ghi cổng nội bộ của Next (vd `PORT=3001`) và `NODE_FALLBACK_URL`/đích trang tương ứng |
| B5-N-5 | (a) Bảng 6.1 dòng 942 vẫn ghi `golden/**` "**không** phải chuẩn so", mâu thuẫn 6.2 dòng 1009–1011 sau lượt 4. (b) Golden ghi từ Node ở giai đoạn C; tới X06 bản TS còn nhận sửa lỗi (quyết định 6) và X12a–e đưa khác biệt vào danh sách cho phép, nên golden cũ có thể lệch Node cuối cùng và tiêu chí "đạt so với golden" của X06 đỏ vì lý do không phải lỗi Rust | PLAN 942, 1007–1011; X06 | Sửa dòng 942; X06 (hoặc X03) ghi lại golden từ Node **lần cuối** sau X12e, áp danh sách cho phép, rồi mới đóng băng làm chuẩn so |
| B5-N-6 | `SOCIAL_MAX_VIDEO_MB` ở G15: hằng số `MAX_VIDEO_BYTES` được dùng ở decorator multer (`social.controller.ts:143`, tính lúc nạp module) và ở tải từ URL (`social-media.service.ts:18,229`). Đọc env lười ở một chỗ mà quên chỗ kia thì giới hạn chỉ đổi một nửa | G15 (:55) | Tiêu chí G15: đặt env = 95 thì cả tải multipart lẫn nhập từ URL trả câu lỗi của Trinity ở 96 MB |
| B5-N-7 | Bảng giai đoạn GĐ 4 ghi "66 issue" nhưng cột Issue gồm M01–M57 (66) **và** X02a–e, X12a–e (10) = 76 issue; cuối ISSUES không nêu chuỗi dài nhất tổng thể mà script in (`… → X06 → X15a`, 24,5) | PLAN 1080; ISSUES 241–259 | Ghi "66 issue module + 10 issue bật/sửa lệch"; thêm một dòng "chuỗi dài nhất tổng thể tới X15a, 24,5 (sau X06)" |

---

## C. Kiểm ISSUES

| Tiêu chí | Kết quả |
|---|---|
| Số liệu PLAN ↔ ISSUES | Khớp: 185 issue, 38/97/50, 216 ngày, "khoảng 118 ngày các giai đoạn khác" (= 216 − 98), bảng giai đoạn 4 / 19,5 / 31,5 / 38 / 98 + 10,5 / 14,5 (cộng 216). Lệch duy nhất là chữ "66 issue" (B5-N-7) |
| Phụ thuộc | Không vòng, không tham chiếu thiếu. Cạnh mới của lượt 4 đúng chiều: K16 → G16; X14 → X12e, X06 → X14, W02b; W02b → X12e; X15a → X06; X15b → X06, X05. Thiếu cạnh W02b → các phụ thuộc còn lại của X06 (B5-N-1) và W03 → W02b (B5-QT-2) |
| Mỗi issue một PR | Đạt |
| Tiêu chí xong đo được | Đạt, trừ G16/K16 (ca test không chạm đường triển khai thật, B5-QT-1) và X06 (golden cũ, B5-N-5) |
| Đường găng | X06 23,5 · D01 10,5 · X02a 12 · W02b 21 · tổng thể X15a 24,5. Khớp |

## Kết luận

**CHƯA ĐỦ**: còn 2 QUAN TRỌNG (B5-QT-1 luật tin `cf-connecting-ip` theo "loopback/mạng riêng" vô hiệu trong mọi cách
triển khai có tài liệu; B5-QT-2 W03 phụ thuộc `/site-config` mà Node không có, làm hỏng trang pháp lý của bản phát hành
công khai tới X06). Cả hai sửa bằng vài dòng ở G16, K16, PLAN 4.13 và W03. 0 CHẶN; 7 NHỎ sửa được trong PR của từng issue.
Toàn bộ 11 phát hiện lượt 4 đã xử lý (2 chưa trọn, đã chuyển thành phát hiện mới ở trên).
