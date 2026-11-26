# Phản biện lần 4 (kiểm chốt): PLAN.md và ISSUES.md (viết lại backend bằng Rust)

Ngày 26/11/2026 · Worktree `rust-plan` (HEAD `fef6dab`, docs/rust chưa commit) · Người phản biện độc lập, không sửa plan
hay mã, không build/test. Không phản biện các quyết định trong `DECISIONS.md`, chỉ nêu hệ quả kỹ thuật chưa được ghi.

## Tóm tắt

| Phần | Kết quả |
|---|---|
| A. 17 phát hiện lượt 3 | 15 ĐÃ XỬ LÝ · 2 ĐÃ XỬ LÝ nhưng cách sửa sinh lỗi mới (QT-3 → B-NHỎ-1; N-3 → B-QT-2). Không mục nào SAI hay CHƯA |
| B. Phát hiện mới | **0 CHẶN · 2 QUAN TRỌNG · 9 NHỎ** |
| `check-issues.py` | 183 issue = 37 S + 96 M + 50 L = 214,5 ngày-agent; 0 trùng, 0 tham chiếu thiếu, **0 vòng**. Khớp PLAN mục 0, 7 (tổng), 11. Bảng giai đoạn ở mục 7 chia sai giữa GĐ 4 và GĐ 5 (B-NHỎ-6) |

**Kết luận: CHƯA ĐỦ** (còn 2 QUAN TRỌNG, đều sửa bằng tài liệu trong vài dòng, không thêm giai đoạn). Sau khi sửa hai
chỗ đó thì đủ để bắt đầu. Ngay bây giờ làm được R001–R006, G01–G15, C01–C18, K01–K16 vì không đụng hai điểm này.

---

## A. Trạng thái các phát hiện lượt 3

| Mã | Trạng thái | Kiểm ở đâu | Ghi chú |
|---|---|---|---|
| CHẶN-1 (vòng K18/W02/W01/D01) | ĐÃ XỬ LÝ | ISSUES:128 D01 → K17, K31; :130 W01 → G11, D01; :131 W02a → R004, W01; K18 → K17, W02a; :132 W02b → W02a, K18, D01, W04; PLAN 5 (thứ tự 6 bước), 7 | Script báo 0 vòng. Hệ quả cho người tự cài giữa W01 và X06: B-QT-1 |
| QT-1 (job nền tự chạy trong máy chủ hộp đen) | ĐÃ XỬ LÝ | C18 (ISSUES:86), K34, PLAN 6.2 | Có tiêu chí đo: "chờ 3 chu kỳ không có dòng mới" ở cả hai bên |
| QT-2 (giờ giả, golden theo lịch) | ĐÃ XỬ LÝ | PLAN 931 (bỏ giờ giả toàn cục), 970, 981–985; C06a; C18 chỉ `now` cho 2 job | Hệ quả sau X06 (không còn Node để so cùng lượt): B-NHỎ-5 |
| QT-3 (cổng 4000 `/notif-ws`) | ĐÃ XỬ LÝ, **sinh lỗi nhỏ** | PLAN 813–816, 1098; D01, X06, X07, X14 | "chỉ loopback" sai trong container Docker: B-NHỎ-1 |
| N-1 (câu đường găng) | ĐÃ XỬ LÝ | ISSUES:241–251 | Chuỗi ghi tay khác chuỗi script in ra (X06 qua `G12a → G12b` hay `R005 → K06 → K08`; D01 qua C12b hay C13a) nhưng đều là các nhánh bằng nhau về cỡ (23,5 và 10,5): không sai |
| N-2 (R001 ghi 150) | ĐÃ XỬ LÝ | ISSUES:27 | |
| N-3 (giới hạn 100 MB / 100 giây Cloudflare) | ĐÃ XỬ LÝ, **sinh lỗi mới** | PLAN 802–811; M53b, X05, X07, X15 | "Tên miền không proxy" phá giả định an ninh của chính 4.13: B-QT-2. Env video chưa có ở bản TS: B-NHỎ-3 |
| N-4 (K36) | ĐÃ XỬ LÝ | M23, M34, M38, M54a đều có K36 | |
| N-5 (`stale-work.digest`) | ĐÃ XỬ LÝ (khung giờ chưa đúng) | M24 (ISSUES:169), X01 (:215), PLAN mục 3 | B-NHỎ-4 |
| N-6 (T01 thiếu hai đường nền) | ĐÃ XỬ LÝ | T01 | |
| N-7 ("đá" webhook) | ĐÃ XỬ LÝ | PLAN 524; G11; K36 "tick 10 giây" | |
| N-8 (route Vercel Blob) | ĐÃ XỬ LÝ | G11; PLAN 18, 380 | Số chốt ở C02 |
| N-9 (con trỏ phân trang) | ĐÃ XỬ LÝ một phần | PLAN 665; C14c | Chỉ mô tả một trong ít nhất ba dạng con trỏ: B-NHỎ-2 |
| N-10 (thứ tự triển khai lai) | ĐÃ XỬ LÝ | D01; PLAN 4.14 | |
| N-11 (loopback trong compose) | ĐÃ XỬ LÝ | D01 `network_mode: service:trinity`; PLAN 827–829 | |
| N-12 (bộ đọc tệp sở hữu) | ĐÃ XỬ LÝ | K03 (ISSUES:94); K17, K20 → K03; PLAN 4.14 | |
| N-13 (a–e) | ĐÃ XỬ LÝ | C06a, K31 (a); D01 SHA-256 (b); K02 job pg (c); M30b/M31 (d); hồ sơ `bad-secret-key` (e) | (d) đếm lại trên mã: `salary-rules` 4 + `tax-config` 6 + `kpi` 5 + `salary-components` 4 + `insurance-settings` 4 = 23; `payslips.controller.ts` 17 route thật (5 decorator còn lại nằm trong chú thích) = 9 không trả tệp + 8 xuất/nhập/pdf; `employees` 4; `reports` 3 ⇒ 23 + 13 + 11 = 47, khớp |

---

## B. Phát hiện mới

### QUAN TRỌNG

#### B-QT-1. Giữa W01 và X06, bản phát hành công khai không có đường triển khai Docker chạy được

- **Liên quan:** W01 (ISSUES:130), D01 (:128), PLAN 5 (bước 1–2), 7 (1056–1059), 8 (1094–1102); `.github/workflows/docker.yml`,
  `docker-compose.yml`.
- **Bằng chứng:**
  - Trong compose hiện tại trình duyệt gọi `/api/v1` cùng origin và **Next route handler** chuyển tiếp sang `api:4000`
    (`docker-compose.yml:127-133` đặt `BACKEND_URL`/`MONOLITH_INTERNAL_URL` cho `web`; route handler
    `apps/web/src/app/api/v1/[...path]`). W01 xoá các route handler này; điều kiện merge chỉ là "cấu hình lai đã chạy
    trên bản đang dùng", tức bản của chủ dự án.
  - `docker.yml:7-9` dựng image khi gắn tag `v*` (release-please). Image dựng sau W01 là `trinity-web` không còn
    `/api/v1`: mọi bản tự cài kéo bản phát hành mới với compose cũ mất toàn bộ API, không có lỗi nào chỉ ra lý do.
  - Compose lai của D01 cần một image cho tiến trình Rust, nhưng image `trinity` chỉ có từ mục 8/X06/X08; K31 chỉ tạo
    **artifact** CI. Artifact GitHub Actions phải đăng nhập mới tải được và hết hạn sau tối đa 90 ngày, nên "tải binary
    từ artifact CI theo commit" (D01) không phải kênh phân phối cho người tự cài.
  - Repo công khai, PLAN 8 tự gọi người tự cài Docker là "người dùng thật". Khoảng W01 → X06 theo bảng mốc là 4–5 tháng.
- **Tác động:** hoặc phải ngừng phát hành 4–5 tháng (quyết định 6 vẫn cho sửa lỗi, tức vẫn có bản phát hành), hoặc bản
  phát hành kế tiếp làm hỏng mọi bản cài Docker. Không issue nào nói chọn cách nào.
- **Đề xuất:** chọn và ghi vào D01/W01 một trong hai: (a) D01 thêm image `trinity` (Rust, chế độ proxy) vào `docker.yml`
  và đổi `docker-compose.yml` mặc định sang compose lai **trước** W01; W01 thêm điều kiện "bản phát hành gần nhất đã dùng
  compose lai", X14 thêm ca nâng cấp từ compose cũ sang compose lai; (b) W01 giữ lại route handler `/api/v1` và
  `/uploads` (chỉ xoá phần serverless) cho tới X06, và W01 đổi tiêu chí tương ứng. (b) rẻ hơn và không đụng đường găng.

#### B-QT-2. "Tên miền không proxy cho tệp lớn" mở đường giả IP chấm công và kiểm Wi-Fi đăng nhập

- **Liên quan:** PLAN 4.13 dòng 797–799 và 806–808; K16, M13b; X07.
- **Bằng chứng:**
  - PLAN 797–799: tài liệu triển khai phải "chỉ mở cổng origin cho dải IP của Cloudflare (hoặc dùng Tunnel), nếu không
    header này giả được". Chín dòng sau (806–808): "Ai cần tệp lớn hơn ngay thì tải qua một tên miền không bật proxy
    (chỉ DNS) trỏ thẳng origin". Muốn vậy origin phải mở cho mọi IP.
  - Khi bật cờ, bản TS tin `cf-connecting-ip` vô điều kiện, không kiểm IP nguồn có thuộc Cloudflare:
    `attendance-ip.helper.ts:50-53` (`ATTENDANCE_TRUST_CF_IP`), `login-wifi-check.helper.ts:85` (`LOGIN_WIFI_TRUST_CF_IP`).
    K16 "tin proxy theo cờ" và K17 đặt lại cả bốn header "từ IP đã xác định ở K16", tức cũng theo cờ đó. Người gửi thẳng
    tới origin kèm `CF-Connecting-IP: <IP văn phòng>` qua được kiểm IP chấm công (ảnh hưởng tới lương) và cổng Wi-Fi
    đăng nhập.
  - Không khả thi như đang viết: (1) Cloudflare Origin Certificate (PLAN 4.13, K19) trình duyệt không tin, tên miền chỉ
    DNS cần chứng chỉ công khai, mà binary không làm ACME (quyết định 8); (2) web tải video lên `/api/v1` cùng origin,
    đổi sang tên miền khác cần CORS và cookie khác host, không issue nào làm; (3) người dùng Tunnel không có origin công khai.
- **Đề xuất:** bỏ câu "tên miền không proxy" khỏi 4.13 (giới hạn 95 MB tới X15 là đủ). Nếu muốn giữ, K16 phải chỉ tin
  `cf-connecting-ip` khi IP nguồn TCP thuộc dải Cloudflare (danh sách cấu hình được), có ca test "gửi thẳng origin kèm
  header giả", và X07 ghi rõ yêu cầu chứng chỉ công khai + CORS. Cách thứ nhất rẻ hơn.

### NHỎ

| # | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|
| N-1 | Cổng tương thích 4000 "chỉ loopback" không tới được trong Docker: loopback của container khác loopback của host, `ports: 127.0.0.1:4000:4000` chỉ chuyển vào được tiến trình nghe `0.0.0.0` trong container. Thêm nữa, ở compose cũ `API_PORT` là biến **phía host** (container nghe `PORT=4000`); trong lai (`network_mode: service:trinity`) Node đang giữ 4000, nếu binary đọc `API_PORT` từ chung `.env` để mở cổng tương thích thì trùng cổng | PLAN 815, X06 (ISSUES:224); `docker-compose.yml:100-106` | Ghi: trong container nghe `0.0.0.0:4000`, compose chỉ công bố `127.0.0.1`; ngoài Docker mới nghe loopback. Dùng biến riêng (vd `COMPAT_API_PORT`) và chỉ bật khi không còn Node. X14 đã có ca bắt lỗi này, nên chỉ là sửa câu chữ |
| N-2 | Con trỏ phân trang có ít nhất ba dạng, PLAN 665 chỉ tả dạng base64url JSON của `record-query.ts`. `contacts` dùng con trỏ Prisma `cursor: {id}` + `skip: 1` với sắp theo cột không duy nhất (chính mã ghi chú là có thể bỏ sót/lặp trang 2, `contacts.service.ts:357-397`); `pos-orders` dùng id thô với `id < cursor` (`pos-orders.service.ts:100-105`); `notifications` dùng id số + `skip: 1` (`notifications.service.ts:78-101`). Ca chéo Node ↔ Rust chỉ có ở C14c (cụm bảng tuỳ biến) | `grep encodeCursor\|next_cursor` ra 30 file ngoài mã sắp gỡ: contacts, deals, activities, kanban, newsfeed, POS, notifications, webhooks, social, zalo, MCP tools | PLAN 4.4 liệt kê dạng con trỏ theo module; thêm vào tiêu chí xong chung của M..: "route có `next_cursor`: ca trang 2 với khoá sắp trùng giá trị, con trỏ chéo Node ↔ Rust" |
| N-3 | `SOCIAL_MAX_VIDEO_MB` chỉ có ở bản Rust (M53b). Từ nay tới X02e, `POST /social/media` do Node xử lý với hằng số 200 MB (`social.config.ts:57`), nên bản cài sau Cloudflare vẫn nhận lỗi 413 của Cloudflare chứ không phải câu lỗi của Trinity như PLAN 806–807 hứa | PLAN 806–807; M53b (ISSUES:203); không issue G nào thêm env này | Thêm env vào G15 (cùng loại "cấu hình bằng env", cỡ S) hoặc ghi rõ chỉ có hiệu lực từ đợt e |
| N-4 | Khung an toàn của `stale-work.digest` ghi sai: `digest_hour` là cài đặt **từng công ty** (0–23, `stale-work.config.ts:10,25`) và job gửi ở **mọi** lượt từ `digest_hour` trở đi cho tới khi ghi được dấu ngày; còn lần gửi lỗi thì không ghi dấu và thử lại cả ngày (`stale-work.service.ts:136-145`). "Ngoài `digest_hour` ± 1 giờ" không có nghĩa khi nhiều công ty khác giờ, và không an toàn với công ty đang thử lại | X01 (ISSUES:215), M24 (:169) | Điều kiện đổi chủ: với mọi công ty bật `stale_reminders`, hoặc giờ VN < `digest_hour`, hoặc dấu `LAST_DIGEST_KEY` = hôm nay; script của X01 kiểm đúng điều kiện này trên DB |
| N-5 | Sau X06 không còn Node để "so trong cùng lượt" (PLAN 981–982), nên tiêu chí "bộ hợp đồng đạt" của X06 (ISSUES:224) và CI hợp đồng về sau không có chuẩn so | PLAN 6.1 (`golden/**` "không phải chuẩn so"), 6.2 | Ghi: từ X06 golden commit thành chuẩn so (C06a đã chứng minh golden ổn định qua hai ngày nhờ seed tương đối và nhãn `<vn-day>`); X06 tiêu chí "bộ hợp đồng đạt so với golden" |
| N-6 | Bảng giai đoạn PLAN 7 chia sai: GĐ 4 ghi "98 + 8" nhưng X02a–e (5 × S = 2,5) + X12a–e (M, M, L, L, L = 8) = 10,5 ⇒ 108,5; GĐ 5 ghi 16 nhưng X01, X03–X11, X13–X15 = 13,5. Tổng 214,5 vẫn đúng vì hai sai bù nhau | PLAN 1051–1052; script: X = 24 | Sửa thành 98 + 10,5 và 13,5 |
| N-7 | X15 không vừa một PR cỡ M: gồm API tải theo phần phía máy chủ, bộ tải lên theo phần ở web, và chuyển "mọi tệp xuất trên 60 giây" (số lượng chỉ biết sau X05) sang job nền kèm giao diện tải về sau | ISSUES:237 | Tách X15a (tải video theo phần: máy chủ + web) và X15b (xuất nền), X15b liệt kê route theo kết quả X05 |
| N-8 | W01 xoá cả `api/build-id` và `api/fe-logging`, nhưng trong lai trang vẫn do Next phục vụ và Rust chuyển tiếp mọi đường không phải `/api/v1` sang Next: `/api/build-id` thành 404, `BuildIdWatcher` im lặng thôi báo "có bản cập nhật" suốt giai đoạn lai (`build-id-watcher.tsx:17-24` nuốt lỗi). W01 cũng ghi "xoá `nest-bridge`" trùng với G11 | ISSUES:130, :49; PLAN 5 bảng | W01 chỉ xoá `api/v1` và `uploads`; `build-id` giữ ở Next tới W02b (hoặc ghi rõ Rust trả build id của web), `fe-logging` theo quyết định Q8; bỏ chữ `nest-bridge` khỏi W01 |
| N-9 | X14 là phụ thuộc của X06 nhưng thử nâng cấp sang image và compose mà chính X06 mới tạo; W02a đòi "40 trang mở được từ máy chủ tĩnh" trong khi theo phương án A của R004 route động cần luật trả trang giữ chỗ, máy chủ tĩnh thường không có | ISSUES:224, :236, :131 | X14 ghi "chạy trên nhánh của X06 trước khi merge"; W02a ghi rõ máy chủ tĩnh dùng trong tiêu chí (có luật fallback cho 8 route động) |

---

## C. Kiểm ISSUES

| Tiêu chí | Kết quả |
|---|---|
| Số liệu PLAN ↔ ISSUES | Khớp: 183 issue, 37/96/50, 214,5 ngày, 66 issue module = 98 ngày, "116 ngày ngoài module" (= 214,5 − 98), 47 route lương, 0 vòng. Lệch duy nhất: bảng giai đoạn (B-NHỎ-6) |
| Phụ thuộc | Không vòng, không tham chiếu thiếu. Các cạnh mới của lượt 3 (W02a/W02b, K03 → K17/K20, K36 → M23/M34/M38/M54a, X15 → X05/X06) đúng chiều |
| Mỗi issue một PR | Đạt, trừ X15 (B-NHỎ-7) |
| Tiêu chí xong đo được | Đạt, trừ X06 "bộ hợp đồng đạt" sau khi bỏ Node (B-NHỎ-5) và X01 khung giờ digest (B-NHỎ-4) |
| Đường găng | Script in chuỗi dài nhất tổng thể là `… → X06 → X15` (24,5 ngày); ISSUES ghi chuỗi tới X06 (23,5) và để X15 ngoài. Nhất quán với "X15 làm sau X06" |

## Kết luận

**CHƯA ĐỦ** — còn 2 QUAN TRỌNG (B-QT-1 bản phát hành Docker giữa W01 và X06; B-QT-2 tên miền không proxy phá kiểm IP),
cả hai sửa bằng vài dòng ở PLAN 4.13, D01, W01; 0 CHẶN; 9 NHỎ sửa được trong PR của từng issue. Toàn bộ 17 phát hiện
lượt 3 đã xử lý. Bắt đầu ngay được R001–R006, G01–G15, C01–C18, K01–K16.
