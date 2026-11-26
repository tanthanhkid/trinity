# Phản biện lần 3: PLAN.md và ISSUES.md (viết lại backend bằng Rust)

Ngày 26/11/2026 · Đối chiếu với mã ở worktree `rust-plan` (HEAD `fef6dab`) · Người phản biện độc lập, không sửa plan hay
mã, không chạy build/test. Không phản biện các quyết định trong `DECISIONS.md` (chỉ nêu hệ quả kỹ thuật chưa được ghi).

## Tóm tắt

| Phần | Kết quả |
|---|---|
| A. 27 phát hiện lượt 2 + 4 mục lượt 1 xử lý sai/chưa đủ | 29 ĐÃ XỬ LÝ · 1 SAI (N-7: sửa nhầm cột) · 1 ĐÃ XỬ LÝ nhưng sinh lỗi mới (QT-2 → vòng phụ thuộc). Ba mục "không theo" của lượt 2 chấp nhận được, N-2 kèm một ngoại lệ |
| B. Phát hiện mới | **1 CHẶN · 3 QUAN TRỌNG · 13 NHỎ** |
| Số đếm của ISSUES | Khớp: 181 issue = 37 S + 94 M + 50 L = 212,5 ngày-agent; không trùng ID; mọi ID phụ thuộc đều tồn tại. **Có một vòng phụ thuộc** (B-CHẶN-1) |

**Kết luận: plan CHƯA đủ để bắt đầu** theo định nghĩa "không còn CHẶN/QUAN TRỌNG". Phần sửa sau lượt 2 là thật và đúng
chỗ gần như toàn bộ. Còn lại: một vòng phụ thuộc do chính D01 tạo ra (sửa bằng đổi 2–3 ô phụ thuộc), và ba lỗ ở vùng hai
lượt trước ít đụng, đều thuộc **khả thi của bộ test hộp đen và đường nâng cấp**: job nền tự chạy trong máy chủ hộp đen,
giờ giả và golden phụ thuộc lịch, cổng `/notif-ws` 4000 mà tài liệu triển khai hiện bắt người tự cài trỏ vào. Tất cả sửa
được bằng chỉnh tài liệu, không thêm issue lớn, không đổi hướng. Các việc không đụng những điểm này (R002–R006, G01–G15,
C01–C05, K01–K05) bắt đầu được ngay.

---

## A. Trạng thái các phát hiện lượt 2

| Mã | Trạng thái | Kiểm ở đâu | Ghi chú |
|---|---|---|---|
| CHẶN-1 (env giữa ca) | ĐÃ XỬ LÝ | PLAN 1.1 (dòng 55–59), 6.2 điểm 4 (906–910); C06a, C12a–C13b | Đếm lại khớp: 39 chỗ = 14 + 7 + 6 + 6 + 4 + 2, cộng 3 của `extensions` = 42. Ánh xạ hồ sơ khả thi (đã thử từng ca có đổi env giữa ca), nhưng thiếu một điều kiện để hồ sơ chạy được: B-QT-1 |
| QT-1 (G07b chặn GĐ 2) | ĐÃ XỬ LÝ | PLAN 2.4 (482–485); C01–C05 | C01/C02/C04 → G06 + G07a; C05 → G04–G06; G07a bỏ câu `routes.json` |
| QT-2 (triển khai lai) | ĐÃ XỬ LÝ, **sinh lỗi mới** | D01; W01 → K18, D01; PLAN 5 (864–867), 7 | D01 phụ thuộc K18, K18 phụ thuộc W02, W02 phụ thuộc W01, W01 phụ thuộc K18 và D01: vòng. Xem B-CHẶN-1 |
| QT-3, QT-4 (tệp sở hữu) | ĐÃ XỬ LÝ | PLAN 3 điểm 3, 4.9, 4.13, 4.14 (796–800), 6.6; K17, K20, T01, X01 | Còn sót phía Node: migrate nền lúc boot và `@Cron` của thông báo không đi qua T01 (B-NHỎ-6) |
| QT-5 (K36) | ĐÃ XỬ LÝ (thiếu 4 cạnh) | K36; 10 issue phụ thuộc; M40, M41, M30b | Còn 4 module gọi outbox/thông báo mà không phụ thuộc K36: B-NHỎ-4 |
| QT-6 (Rust ghi migration từ đợt b) | ĐÃ XỬ LÝ | PLAN 4.5 (677–680), rủi ro 5; K07, K09, X02b | Phương án (b), lý do không chọn (a) chấp nhận được |
| QT-7 (dump) | ĐÃ XỬ LÝ | PLAN 6.5 điểm 5, 6.6; X01 | Có diễn tập sửa có chọn lọc 20 dòng: tốt |
| QT-8 (nâng cấp Docker) | ĐÃ XỬ LÝ (thiếu một cổng) | PLAN 8 (1045–1050); X06, X07, X14 | uid, đường dẫn, cổng 3000, healthcheck đều có. Sót cổng 4000 cho `/notif-ws`: B-QT-3 |
| QT-9 (sqlx offline) | ĐÃ XỬ LÝ | PLAN 4.4 (643–648), 11; K01 | |
| QT-10 (công thức) | ĐÃ XỬ LÝ | PLAN 1.13, 10.3 điểm 6; M57; M17/M18 → M57 | |
| QT-11 (R004) | ĐÃ XỬ LÝ | PLAN 5 (849–854); R004; K04 | |
| QT-12, I12 (ước lượng) | ĐÃ XỬ LÝ | PLAN 0, 11 | Kiểm số: phần ngoài module = 4 + 19 + 31,5 + 37 + 15 + 8 = 114,5 ngày; 140–190 + 114 ≈ 254–304: khớp "250–300". 250/2,1 = 119, 300/2,1 = 143 ngày làm việc ⇒ 24–29 tuần: khớp |
| B1 (giờ giả, gọi hàm nội bộ) | ĐÃ XỬ LÝ về số, **ngữ nghĩa sai** | PLAN 6.2 điểm 1 (896–903), điểm 5; C18, K34 | Giờ giả có, nhưng hai bên hiểu khác nhau: B-QT-2 |
| I17 (cache) | ĐÃ XỬ LÝ | PLAN 4.14 (818–821); C02 `cached`; G12a; K28; X13 | |
| N11 (`SIGHUP` + env) | ĐÃ XỬ LÝ | như QT-3/4 | |
| Ghi chú B3, I6, N8 | ĐÃ XỬ LÝ | K28; K17; W03 | |
| N-1 | ĐÃ XỬ LÝ | PLAN 6.2 điểm 5; C08, C11, C12b, C13a | |
| N-2 | Theo một phần — **chấp nhận được, có điều kiện** | PLAN 3 điểm 3 (503–505), T01 | Tiền đề "mọi job hiện có nhận việc nguyên tử theo dòng" sai với `stale-work.digest` (B-NHỎ-5). Ngoài job đó, lý do không thêm khoá ở Node đứng được |
| N-3 | ĐÃ XỬ LÝ | PLAN 4.3 (634–637); K06 | |
| N-4 | ĐÃ XỬ LÝ | PLAN 2.3 điểm 5; G04, G05, G06, G09 | |
| N-5 | ĐÃ XỬ LÝ | G05 | |
| N-6 | ĐÃ XỬ LÝ | M44a | |
| N-7 | **SAI** | `ISSUES.md:27` | Cột "Tiêu chí xong" của R001 vẫn ghi "150 issue được tạo"; câu sửa ("bằng đúng số dòng") bị đặt vào cột Nhãn |
| N-8 | ĐÃ XỬ LÝ | PLAN 4.14 (801–803); D01; K16 | Cách làm "loopback" trong compose chưa nói rõ: B-NHỎ-11 |
| N-9, N-10, N-11, N-12, N-13, N-14 | ĐÃ XỬ LÝ | M52, 10.2; K29, M18, M21; G11; X13; C03; G07b, M19 | |
| Mục C (tách G12, C06, quy ước tệp chung, tiêu chí đo được) | ĐÃ XỬ LÝ | G12a/b, C06a/b, đầu ISSUES, G05, X02d | |
| "Không theo" lượt 2: QT-6 phương án a, QT-12 22–28 tuần | Chấp nhận được | PLAN 1380–1381 | Lý do có căn cứ, số học đúng |

---

## B. Phát hiện mới

### CHẶN

#### B-CHẶN-1. Vòng phụ thuộc K18 → W02 → W01 → (K18, D01) → K18

- **Bằng chứng:** `ISSUES.md:109` K18 phụ thuộc "K17, **W02**"; `:131` W02 phụ thuộc "R004, **W01**"; `:130` W01 phụ thuộc
  "G11, **K18**, **D01**"; `:128` D01 phụ thuộc "K17, **K18**, K31". Hai vòng: K18 → W02 → W01 → K18 và
  K18 → W02 → W01 → D01 → K18. D01 nằm trên câu đường găng ở `ISSUES.md:239`.
- **Tác động:** Không thứ tự nào làm xong được bốn issue này như đang ghi; khi tạo issue trên GitHub với phụ thuộc, cả
  "điểm dừng an toàn sau giai đoạn 3", X01 và X02a (đều phụ thuộc D01) không bao giờ mở được. Lỗi do chính bản sửa QT-2
  sinh ra.
- **Đề xuất:** D01 **không** cần web tĩnh: PLAN 4.14 dòng 813 đã ghi "cho tới khi W02 xong, đường không phải API được
  chuyển tiếp tới Next server". Sửa thành: D01 → K17, K31 (bỏ K18); W01 → G11, D01; W02 → R004, W01; K18 → K17, W02. Vì
  W02 bỏ Next server, W02 và K18 phải lên bản chạy **cùng một lần triển khai**: ghi điều đó vào tiêu chí W02, hoặc tách
  W02 thành W02a (thêm `build:export` song song, không bỏ `standalone`) và W02b (bỏ Next server, sau K18 + D01). Thêm một
  bước kiểm "không có vòng" vào script tạo issue của R001.

### QUAN TRỌNG

#### B-QT-1. Máy chủ hộp đen tự chạy job nền; bộ test không có cách tắt

- **Liên quan:** PLAN 6.2 điểm 1 và 4; C06a, C12a, C18, K20, K34, T01.
- **Bằng chứng:**
  - E2e hiện tại khởi động app **khi cờ còn tắt** rồi mới bật cờ trong từng ca, nên worker webhook không bao giờ tự chạy;
    ca test gọi `tick()` bằng tay: `webhooks-out.e2e-spec.ts:40-41` (xoá env rồi mới `bootApp`), 34–38 (`enable()` gọi sau).
  - Worker chỉ đặt `setInterval` 10 giây **nếu lúc khởi động** cờ và khoá đã có: `webhook-dispatcher.service.ts:71-80`.
    Với hồ sơ `default`/`private-targets` (cờ bật từ lúc khởi động), timer chạy thật song song với ca test.
  - Các job khác luôn đặt timer ngoài serverless: `social-publish.job.ts:46-49`, `facebook-flows.job.ts:20-21`,
    `facebook-broadcasts.job.ts:21-22`, `@Cron('0 */2 * * * *')` ở `notifications.scheduler.ts:16`. Phía Rust, K20 chạy mọi
    job theo tệp sở hữu.
  - Các ca phụ thuộc việc **không** có lượt tự chạy: "lỗi 500 … không gửi trước hạn" (`webhooks-out.e2e-spec.ts:366`),
    "dispatcher chạy trùng KHÔNG tạo delivery đôi" (`:347`), "cờ TẮT: tick không làm gì" (`:335`), "crash giữa lúc gửi …
    nhận lại SAU lease" (`:477`).
  - C18/K34 chỉ có "chạy một lượt job", không có "tắt lịch tự động". T01 (cách duy nhất để Node bỏ lượt theo tệp) nằm ở
    giai đoạn 3, sau C06a.
- **Tác động:** Ca của C12a, C13b (hết hạn thao tác), C15 (kịch bản, gửi hàng loạt) chạy lúc đạt lúc trượt tuỳ nhịp timer;
  golden ghi từ Node không lặp lại được (C06a đòi "chạy lại 3 lần giống hệt").
- **Đề xuất:** C18 và K34 thêm luật: khi `TRINITY_TEST_HOOKS=1`, **không đăng ký lịch tự động nào** (mọi `setInterval`,
  `@Cron`, scheduler K20, worker hàng đợi K21); job chỉ chạy qua `POST /internal/test/jobs/:name/run`. Hồ sơ `production`
  không có hook nên không ca nào của nó được dựa vào việc job chạy hay không. Thêm vào tiêu chí C18: khởi động với mọi cờ
  bật, chờ 3 chu kỳ, không có dòng `webhook_deliveries`/`notification_logs` mới.

#### B-QT-2. Thời gian trong bộ hợp đồng: giờ giả hai bên hiểu khác nhau, golden gắn với lịch

- **Liên quan:** PLAN 6.1 (dòng 883–885), 6.2 (897–900, 915, 927–928); C06a, C18, K34, C17, K31.
- **Bằng chứng:**
  - PLAN 900: "Ở Rust, giờ giả đi qua trường `now` của `Ctx`; ở bản TS chỉ các hàm đã nhận tham số thời gian đọc nó."
    Backend TS đọc đồng hồ thật ở **406 chỗ trong 127 file** (`new Date()`/`Date.now()`, không tính spec và mã sắp gỡ),
    cộng `now()` trong SQL. Khi một ca đặt `POST /internal/test/clock`, mọi handler Rust thấy giờ giả, còn handler Node
    (ngoài hai hàm nhận `now`) thấy giờ thật: golden ghi từ Node và kết quả Rust khác nhau ở chính chỗ không liên quan tới
    ca đó, hoặc tệ hơn, giống nhau vì cả hai đều sai theo cách khác.
  - Golden được commit và có job "sinh lại và so" (PLAN 883–885), seed "cố định" (915), bộ chuẩn hoá chỉ thay "thời điểm
    gần bây giờ" (927–928). Nhưng nhiều response tính **theo ngày hôm nay**: `dashboard-trend.service.ts:27-36` trả mảng
    `days` lùi từ hôm nay; `contracts.service.ts:875` tính `days_remaining`/"sắp hết hạn"; thống kê "hôm nay" ở
    `interactions.service.ts:160-167`, chấm công, nhắc việc treo. Với seed cố định, các response này đổi mỗi ngày.
- **Tác động:** Job "sinh lại và so" golden đỏ mỗi ngày; C17 (chạy đêm, có thể vắt qua 17:00 UTC = nửa đêm VN) dao động;
  ca dùng giờ giả cho kết quả khác nhau giữa Node và Rust dù Rust đúng.
- **Đề xuất:** (1) Bỏ `POST /internal/test/clock` toàn cục; giữ **chỉ** tham số `now` của `jobs/:name/run`, đủ cho hai ca
  đã biết (`reapStuckProcessing`, `collect`), và Rust cũng chỉ dùng giờ giả ở đúng hai đường đó. (2) Seed thời gian
  **tương đối** (`now() - interval '…'`) cho mọi bảng có cột ngày mà response tính theo hôm nay. (3) Bộ chuẩn hoá thêm nhãn
  cho ngày VN hôm nay/hôm qua/±N ngày (`<vn-day:0>`, `<vn-day:-1>`) và cho số ngày tương đối. (4) So Rust với Node **trong
  cùng một lượt chạy** (ghi golden Node rồi so Rust ngay), golden commit chỉ để xem diff; tránh khung 16:50–17:10 UTC.

#### B-QT-3. Cổng 4000 cho `/notif-ws`: tài liệu hiện bắt reverse proxy trỏ thẳng vào API

- **Liên quan:** PLAN 8 (1045–1050), D01, X06, X07, X14; `docs/deployment.md`, `docker-compose.yml`.
- **Bằng chứng:** `docs/deployment.md:26-37` yêu cầu reverse proxy chuyển `/notif-ws/*` thẳng tới `localhost:4000` (API)
  vì Next không chuyển tiếp WebSocket, và danh sách kiểm `:114` đòi `101 Switching Protocols` ở đó.
  `docker-compose.yml` công bố API ở `127.0.0.1:${API_PORT:-4000}` chính vì luật này. Web nối socket theo origin của trang
  (`notification-socket.tsx:45-52, 167-173`, chỉ `transports: ['websocket']`). Plan chỉ giữ cổng 3000 (mục 8, X06, X14).
- **Tác động:** Sau X06 không còn gì nghe ở 4000: mọi bản tự cài làm theo tài liệu cũ mất chuông realtime (socket thử lại
  10 lần rồi thôi), không có lỗi nào chỉ ra nguyên nhân; X14 không bắt được vì chỉ thử "reverse proxy trỏ cổng 3000".
  Trong cấu hình lai (D01), luật cũ còn làm WebSocket **đi vòng qua Rust** tới thẳng Node.
- **Đề xuất:** Binary Rust nghe thêm cổng tương thích (`API_PORT`, mặc định 4000, chỉ loopback) chỉ cho `/notif-ws` và
  `/api/v1` tới hết một bản phát hành, hoặc X07 có bước "xoá luật `/notif-ws`" và healthcheck báo rõ. X14 thêm tiêu chí:
  reverse proxy cấu hình theo `docs/deployment.md` cũ, sau nâng cấp vẫn nhận `notification:new`. D01 ghi rõ trong lai
  `/notif-ws` đi qua Rust (gỡ luật cũ hoặc trỏ về cổng của Rust).

### NHỎ

| # | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|
| N-1 | Câu đường găng sai: M01 **không** phụ thuộc D01; thiếu G12a → G12b → K11 (K11 phụ thuộc G12b); chuỗi dài nhất theo cỡ là `G12a → G12b → K11 → K12 → K14 → M45 → M46 → M53a → M53b → M54a → M55a → M55b → M44a → X02e` (18,5 ngày), và D01 nằm sau toàn bộ giai đoạn 2 qua `C13a → C17 → K31 → D01` | `ISSUES.md:239`, `:102`, `:122`, `:128`, `:143` | Sinh câu đường găng bằng script từ bảng (cùng script kiểm vòng ở B-CHẶN-1) |
| N-2 | R001 vẫn ghi 150 (N-7 lượt 2 sửa nhầm cột) | `ISSUES.md:27` | Chuyển câu sang cột Tiêu chí |
| N-3 | Hệ quả của quyết định 8 chưa ghi: proxy Cloudflare (gói Free/Pro, cả Tunnel) giới hạn body request 100 MB và chờ origin 100 giây (lỗi 524). Plan giữ upload video 200 MB qua multipart và timeout 120 giây cho `/export` | PLAN 1.2 (dòng 134–135), 4.14 (804–806); `social.config.ts:57` (`MAX_VIDEO_BYTES` 200 MB); upload qua `POST /social/media` (`social.controller.ts:133-147`) | Ghi vào 4.13/`docs/deployment.md`: sau Cloudflare, video tối đa 100 MB (hạ `MAX_VIDEO_BYTES` theo env) hoặc tải thẳng lên S3 bằng URL ký sẵn; xuất tệp phải xong dưới 100 giây hoặc chuyển sang hàng đợi + tải sau. K16/X05 thử đúng giới hạn này |
| N-4 | 4 module gọi outbox/tạo thông báo nhưng không phụ thuộc K36 (trực tiếp hay bắc cầu): M54a (`social-posts.service.ts:888` `publishIntegrationEvent`), M23 (`briefing-channel.ts:43` `createPendingLogs`), M38 (`ai-actions.service.ts:215`), M34 (`webhook-delivery-worker.service.ts:166`, báo tự tắt endpoint) | ISSUES dòng 167, 179, 183, 203 | Thêm K36 vào bốn issue |
| N-5 | `stale-work.digest` không nhận việc nguyên tử: đọc khoá "đã gửi hôm nay", gửi cho mọi người, rồi mới ghi khoá; chồng một lượt khi đổi chủ là gửi trùng tổng hợp cho cả công ty | `stale-work.service.ts:131-145`; PLAN 503–505, T01 | Sửa câu "mọi job" thành ngoại lệ có tên; runbook X01: đổi chủ job này ngoài khung giờ `digest_hour` |
| N-6 | Hai đường chạy nền của Node không đi qua T01: `void migrateAllCompanies(...)` lúc boot (`bootstrap-app.ts:87`) và `@Cron` của `notification.scheduled` (`notifications.scheduler.ts:16`, ngoài `cronRegistry`) | PLAN 4.5 (680), K09 "chỉ một bên chạy migrate nền" nhưng không issue nào sửa phía Node | T01 thêm hai đường này vào phạm vi và tiêu chí |
| N-7 | "Đá" bộ phát webhook ở bản chạy VPS hiện là **no-op**: `kick()` thoát ngay khi không phải serverless; độ trễ thật là tick 10 giây. Bảng ở PLAN mô tả như lời gọi trong tiến trình; G12b/K36 đòi "Node phát đi dưới 2 giây" là thêm hành vi mới vào bản TS đang đóng băng, còn G11 làm interceptor thành mã chết | `webhook-dispatcher.service.ts:92-93`; PLAN 519; ISSUES `:51`, `:127` | Bỏ kênh "đá" khỏi G12b/K36 (giữ tick 10 giây như hiện tại) hoặc ghi rõ đây là thay đổi có chủ đích; G11 xoá `WebhookKickInterceptor` |
| N-8 | Bỏ Vercel Blob (G11) để lại 2–4 route luôn trả 400 và nhánh web tương ứng: `POST social/media/upload-token`, `social/media/register`, token video bảng tin | `storage.service.ts:146-153`; `social-media.service.ts:76-78`; `newsfeed.service.ts:522-525` | G11 quyết định gỡ hay giữ các route này; cập nhật số 559 |
| N-9 | Con trỏ phân trang (77 chỗ `encodeCursor`/`next_cursor`, base64url của JSON `{v, id}`) không được nhắc trong plan. Client đang lật trang lúc đổi sở hữu sẽ gửi con trỏ do Node phát cho Rust; nếu bộ chuẩn hoá xếp con trỏ vào `<token>` thì golden che mất khác biệt | `record-query.ts:44-82`, `custom-records-list.service.ts` | 4.4 ghi: con trỏ phải giống từng byte (thứ tự khoá JSON, dạng `sort_v` của numeric/timestamptz); C14c có ca "con trỏ Node dùng ở Rust và ngược lại" |
| N-10 | Rust từ chối (503) mọi công ty có `migrated_to` cũ hơn bản biên dịch, nhưng D01 không ghi thứ tự triển khai: binary mới lên trước bước `prisma migrate` của Node là toàn bộ route Rust trả 503 | PLAN 4.3 (631–633); D01 | D01: thứ tự "migrate (Prisma) → khởi động Node → thay binary Rust", cổng sức khoẻ kiểm `migrated_to` |
| N-11 | "Node và Next chỉ nghe loopback, Rust gọi qua loopback" trong compose cần ba container chung network namespace (`network_mode: service:trinity`), nếu không loopback của container này không tới container kia | D01; PLAN 801–803 | Ghi cách làm vào D01; kiểm `oauth-rate-limits.ts` thấy `127.0.0.1` thật |
| N-12 | Tệp sở hữu được đọc ở hai issue song song không phụ thuộc nhau (K17 cho route, K20 cho job) ⇒ hai bộ đọc; chưa ghi luật khớp "tiền tố dài nhất" trong khi có tiền tố lồng nhau thuộc hai đợt (`settings` đợt a và `settings/channel-guard` đợt e; `public/auth` đợt b và `public/contacts` đợt e) | ISSUES `:108`, `:111`; `channel-guard.controller.ts:9`, `usage.controller.ts:13` cùng `@Controller('settings')` | Bộ đọc tệp đặt ở K03 (cấu hình), K17/K20 dùng chung; ghi luật tiền tố dài nhất + phương thức; test bảng 559 route → chủ |
| N-13 | Lặt vặt khác: (a) bộ hợp đồng chạy trên bản `test-hooks`, binary phát hành chưa bao giờ chạy hợp đồng: cho hồ sơ `production` chạy trên binary phát hành; (b) D01 "tải binary **đã ký**" nhưng ký (cosign) chỉ có ở X08 sau X06, K31 chỉ có artifact; (c) job pg Rust chỉ có từ K31 (sau K17, C17) trong khi K06–K21 lấy test pg làm tiêu chí: tách phần "Rust pg tests" sớm vào K02; (d) payroll: M29 23 + M30b 17 + M31 7 = 47, còn 4 route `payroll/employees` chưa rõ chủ, và 8 route xuất/nhập/pdf của `payslips.controller.ts` nằm trong 17 của M30b trong khi M31 mô tả chính chúng; (e) hồ sơ thiếu ca "khoá sai độ dài" (`webhooks-out.e2e-spec.ts:120`) và ca "đổi khoá" (`:548`): ghi rõ seed bản mã bằng SQL | ISSUES `:128`, `:122`, `:175–176`, `:225` | Sửa từng dòng |

---

## C. Kiểm ISSUES

| Tiêu chí | Kết quả |
|---|---|
| Mỗi issue một PR | Đạt. Không còn issue nào ước trên 1.500 dòng TS chưa tách; các L lớn nhất (G12b, C06a, K17) có phạm vi một PR |
| Phụ thuộc vòng | **Có**: B-CHẶN-1 |
| Phụ thuộc thiếu | B-NHỎ-4 (K36), B-NHỎ-6 (T01), B-NHỎ-12 (K20 ↔ K17) |
| Song song đụng file | K17 và K20 cùng đọc tệp sở hữu (B-NHỎ-12). C02 sinh trước G02/G03/G04 nên mỗi PR gỡ đó phải sinh lại `routes.json` (chấp nhận được, đã có job CI đỏ khi lệch) |
| Tiêu chí đo được | Đạt, trừ C06a "3 lần giống hệt" chỉ đo được sau B-QT-1/B-QT-2 |

## Kết luận

Plan **chưa đủ** để bắt đầu theo định nghĩa "không còn CHẶN/QUAN TRỌNG": còn 1 CHẶN, 3 QUAN TRỌNG. Cả bốn đều là sửa tài
liệu: đổi phụ thuộc D01/W01/W02/K18 (B-CHẶN-1); thêm luật "test hooks ⇒ không lịch tự động" vào C18/K34 (B-QT-1); bỏ giờ
giả toàn cục, seed tương đối, so trong cùng lượt (B-QT-2); xử lý cổng 4000 của `/notif-ws` trong X06/X07/X14/D01 (B-QT-3).
Sau bốn chỗ đó, phần NHỎ sửa được trong PR của từng issue. Có thể bắt đầu ngay R002–R006, G01–G15, C01–C05, K01–K05.
