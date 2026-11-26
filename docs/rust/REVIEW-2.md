# Phản biện lần 2: PLAN.md và ISSUES.md (viết lại backend bằng Rust)

Ngày 26/11/2026 · Đối chiếu với mã ở worktree `rust-plan` (HEAD `fef6dab`) · Người phản biện độc lập, không sửa plan hay
mã, không chạy build/test. Không phản biện các quyết định trong `DECISIONS.md`.

## Tóm tắt

| Phần | Kết quả |
|---|---|
| A. 36 phát hiện lượt 1 | 32 ĐÃ XỬ LÝ (I7 xử lý đúng nhưng sinh mâu thuẫn lịch mới) · 1 CHƯA đủ (I12) · 3 SAI (B1 một phần, I17 một phần, N11) |
| B. Phát hiện mới | **1 CHẶN · 12 QUAN TRỌNG · 14 NHỎ** |
| Số đếm của ISSUES | Khớp: 175 issue = 40 S + 85 M + 50 L = 205 ngày-agent; không trùng ID; mọi ID trong cột phụ thuộc đều tồn tại |

**Kết luận: plan CHƯA đủ để bắt đầu.** Phần lớn sửa sau lượt 1 là thật và đúng chỗ. Còn một chỗ chặn cùng loại với B1
(42 lần đổi biến môi trường giữa ca trong e2e tích hợp, hộp đen không làm được), cộng một nhóm QUAN TRỌNG tập trung ở
ba vùng lượt 1 ít đụng: (1) đường găng và triển khai giai đoạn lai (C02 bị G07b chặn; không có issue triển khai cấu hình
lai; W01/W02 làm hỏng bản đang chạy nếu merge trước K18; `SIGHUP` không đọc lại env được); (2) phụ thuộc chéo module
(outbox sự kiện và tạo thông báo dùng ở đợt c nhưng nằm ở M32/M33 đợt d/e; tool MCP thiếu phụ thuộc); (3) vận hành
(khôi phục dump làm mất dữ liệu ghi sau đó; đường nâng cấp cho bản cài tự quản; sqlx offline trên máy không có DB).
Tất cả sửa được bằng chỉnh tài liệu và thêm khoảng 4–6 issue, không phải đổi hướng.

---

## A. Trạng thái các phát hiện lượt 1

| Mã | Trạng thái | Kiểm ở đâu | Ghi chú |
|---|---|---|---|
| B1 | **SAI (một phần)** | PLAN 6.2 (dòng 834–845), C06, C18, K34, C07–C13 | API điều khiển test + seed SQL đã có, đúng hướng. Nhưng (a) lý do bỏ đồng hồ giả ("chưa ca nào cần", PLAN dòng 843, 1215) **sai**: `notification-reaper.e2e-spec.ts:20,41` gọi `reapStuckProcessing(NOW)` với `NOW` cố định, `deals-won-date.e2e-spec.ts:21,44` gọi `BriefingAggregatorService.collect(…, NOW)`; (b) còn các lời gọi hàm nội bộ không phải job/cache: `DeliveryService.createLog` (`notification-reaper.e2e-spec.ts:25`), `IntegrationAuditService.log` (`integrations.e2e-spec.ts:90,120`), `OauthTokenService.verifyAccessToken` (`oauth.e2e-spec.ts` 4 chỗ, dòng 332–405). C13a có ghi "đổi sang HTTP hoặc SQL", các issue khác không. (c) Thiếu hẳn phần đổi env giữa ca: xem B-CHẶN-1 |
| B2 | ĐÃ XỬ LÝ | G15, C06 → G15, K03, PLAN 6.2 dòng 846–850 | |
| B3 | ĐÃ XỬ LÝ | PLAN 1.10, 4.14; C02 cột `safe_for_shadow`; K28 | Ghi chú nhỏ: `TenantDb` lấy kết nối theo nhu cầu (4.3) nên "giao dịch READ ONLY" phải đặt ở mức phiên (`default_transaction_read_only = on` khi `acquire` trong chế độ shadow), không chỉ bọc một `TenantTx` |
| I1 | ĐÃ XỬ LÝ | PLAN 1.2, 6.1; C02, K14, K15 | Đếm lại: 47 `@RequireOrgFeature` ngoài spec (48 tính cả spec): khớp |
| I2 | ĐÃ XỬ LÝ | PLAN 3 điểm 4; G12, K33, M30b, X02c | |
| I3 | ĐÃ XỬ LÝ | G12, M45, X02e; phần "không theo" | Lý do không chia sẻ `FixedWindowLimiter` **chấp nhận được** (chống lạm dụng, không phải hạn mức tính tiền). Điều kiện kèm: Node phải nhận request từ Rust qua loopback (xem B-NHỎ-8), nếu không một số giới hạn theo IP sẽ thành một xô chung |
| I4 | ĐÃ XỬ LÝ | PLAN 4.9, K20, K06 | PLAN mục 3 điểm 3 (dòng 484) vẫn viết `pg_try_advisory_lock` mức phiên: mâu thuẫn với 4.9. Bảo vệ "phòng cấu hình sai" chỉ có ở phía Rust (B-NHỎ-2) |
| I5 | ĐÃ XỬ LÝ | PLAN 4.3, K06, X05 | |
| I6 | ĐÃ XỬ LÝ | PLAN 4.14, K17, M13b | Khi bật `LOGIN_WIFI_TRUST_CF_IP`/`ATTENDANCE_TRUST_CF_IP`, Node đọc `cf-connecting-ip` **trước** `x-real-ip` (`login-wifi-check.helper.ts:85-88`). K17 "đặt lại" phải đặt cả `cf-connecting-ip`, nên ghi rõ trong tiêu chí |
| I7 | ĐÃ XỬ LÝ, **tạo mâu thuẫn mới** | PLAN 2.3, 2.4; G07a, G07b, R002 | Tách hai bước đúng. Nhưng chuỗi phụ thuộc làm G07b nằm trên đường găng của cả giai đoạn 2: xem B-QT-1 |
| I8 | ĐÃ XỬ LÝ | PLAN 2.3 điểm 5; G04, G06, G09 | Số thứ tự migration chưa chốt: B-NHỎ-4 |
| I9 | ĐÃ XỬ LÝ | PLAN 6.5 điểm 5, 6.6; X01 | Dump có, nhưng cách dùng dump để lui sai: B-QT-7 |
| I10 | ĐÃ XỬ LÝ | PLAN 6.5; X11, X13 | Phần "không theo" (không che PII, thay bằng X13) **chấp nhận được** nếu thêm điều kiện xử lý máy chứa bản sao (B-NHỎ-12) |
| I11 | ĐÃ XỬ LÝ | ISSUES | Kiểm từng mục: X02a → X01, K31; X02d/e → T01; X06 → X10; K35 cho M34, M37, M53b; M40/M42 → M16; channel-guard thuộc M45; C06 → C18, G15. Có thêm phụ thuộc thiếu mới: B-QT-5 |
| I12 | **CHƯA (một phần)** | PLAN 11, ISSUES | Đã tách issue lớn, thêm X12a–e, dòng thời gian theo mốc. Nhưng tốc độ ở giai đoạn module gần như không đổi so với bản bị chê: B-QT-12 |
| I13 | ĐÃ XỬ LÝ | PLAN 7, R003 | |
| I14 | ĐÃ XỬ LÝ | PLAN 10.3, M30a | Mô tả `Math.round` (nửa về +∞) đúng |
| I15 | ĐÃ XỬ LÝ | PLAN 6.2, C02 `shape_permissions`, C14a–d, tiêu chí chung | |
| I16 | ĐÃ XỬ LÝ | PLAN 4.4, K05 | |
| I17 | **SAI (một phần)** | PLAN 4.14 dòng 772–773, K28 | `NOTIFY` vô hiệu cache: đúng. Nhưng shadow chỉ bỏ cache ở **phía Rust**; response của Node vẫn có thể lấy từ cache (TTL 60 giây, gồm cả số liệu phụ thuộc "bây giờ" như stats hôm nay/trend) ⇒ khác biệt giả tăng thay vì giảm. Sửa: route có cache được đánh dấu trong `routes.json` và so lỏng phần số đếm, hoặc đặt `min_samples` "không áp dụng" + quét X13 với cache tắt ở cả hai bên |
| I-không theo (I3, I10, B1-clock, N11) | Xem từng dòng | PLAN "Lịch sử phản biện" | I3, I10: chấp nhận. B1-clock: lý do sai (trên). N11: phương án chọn không chạy được (dưới) |
| N1 | ĐÃ XỬ LÝ | G10, M11, 1.13 | |
| N2 | ĐÃ XỬ LÝ | 1.9, mục 0 | |
| N3 | ĐÃ XỬ LÝ | 2.2, G03 | |
| N4 | ĐÃ XỬ LÝ | K26, 10.2 | |
| N5 | ĐÃ XỬ LÝ | 6.2, 10.2, K06, K10 | |
| N6 | ĐÃ XỬ LÝ | 4.8, C03 | Thêm ca "đối số thừa" (B-NHỎ-13) |
| N7 | ĐÃ XỬ LÝ | 4.6, K11 | |
| N8 | ĐÃ XỬ LÝ | W03, K27 | `DS_V2_ENABLED` là hằng số module (`design-system-flags.ts:17`): đổi sang đọc lúc chạy cần nạp `site-config` trước lần vẽ đầu, ghi vào W03 |
| N9 | ĐÃ XỬ LÝ | K17 | |
| N10 | ĐÃ XỬ LÝ | 2.2, G05, G06, M45 | |
| N11 | **SAI** | PLAN 4.14 dòng 758, 6.5 điểm 7 (dòng 903), 6.6 (dòng 911), K17 | "Sửa env rồi gửi `SIGHUP`" không làm được: tiến trình không đọc lại được biến môi trường của chính nó sau khi khởi động; dưới Docker/PM2 đổi env nghĩa là tạo lại tiến trình. Xem B-QT-4 |
| N12 | ĐÃ XỬ LÝ | 4.3, R005, K06 | Công ty 1 (`public`) không có `migrated_to` (`provision.ts:57-58` lọc `id <> 1`): quy tắc "từ chối công ty chưa migrate" cần nhánh riêng đọc `_prisma_migrations` (B-NHỎ-3) |
| N13 | ĐÃ XỬ LÝ | mục 8, K31 | |
| N14 | ĐÃ XỬ LÝ | W02, W04 | |
| N15 | ĐÃ XỬ LÝ | 4.12, K27 | |
| N16 | ĐÃ XỬ LÝ | 6.4, X04 | |
| Sai số đếm | ĐÃ XỬ LÝ | 1.1, C09, C13b | 23 lời gọi `app.get(` (gồm 3 `require(...)`): khớp |

---

## B. Phát hiện mới

### CHẶN

#### B-CHẶN-1. E2e tích hợp đổi biến môi trường giữa ca; máy chủ hộp đen không đổi được

- **Liên quan:** PLAN 6.2; C06, C12a, C12b, C13a, C13b, C18, K34, K03.
- **Bằng chứng:** 42 phép gán/xoá `process.env.*` trong 7 file e2e (`grep -c "process.env\.[A-Z_]* = \|delete process.env\." apps/monolith/test/rbac/*.e2e-spec.ts`):
  `webhooks-out` 14, `webhooks-in` 7, `mcp` 6, `oauth` 6, `integrations` 4, `ai-actions` 2. Các biến: `INTEGRATIONS_MCP_ENABLED` (9),
  `INTEGRATIONS_WEBHOOKS_ENABLED` (6), `INTEGRATIONS_SECRET_KEY` (6), `INTEGRATIONS_PUBLIC_BASE_URL` (5),
  `INTEGRATIONS_ALLOW_PRIVATE_TARGETS` (5), `INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS`, `INTEGRATIONS_MCP_ALLOWED_ORIGINS`, và
  `NODE_ENV = 'production'` tạm thời (`webhooks-out.e2e-spec.ts:158-162`) để kiểm "production từ chối địa chỉ nội bộ".
  Mã Node đọc các biến này **mỗi lần gọi** (ví dụ `ssrf-guard.ts:27`), nên test đổi được giữa ca. Rust đọc cấu hình lúc
  khởi động (K03).
- **Tác động:** Khoảng 150 ca của C12a, C12b, C13a, C13b không chạy được theo kịch bản hiện tại; tiêu chí "N ca đạt" của các
  issue này không đạt được. Ca `NODE_ENV=production` còn mâu thuẫn trực tiếp với thiết kế "API điều khiển test chỉ có ngoài
  production" (C18): ở cấu hình đó không seed/flush qua API được. Đây là phần còn thiếu của B1, nằm trên đường găng (C06).
- **Đề xuất:** C06 thêm khái niệm **hồ sơ cấu hình** (`profiles/*.env`): bộ chạy khởi động máy chủ một lần cho mỗi hồ sơ
  (mặc định; tích hợp tắt; thiếu khoá bí mật; production) và gom ca theo hồ sơ; ca production chỉ seed bằng SQL. Liệt kê
  ánh xạ 42 chỗ → hồ sơ trong C12a–C13b. Không thêm "đổi cấu hình lúc chạy" vào API điều khiển (Rust sẽ phải giữ cấu hình
  thay đổi được ở mọi chỗ). Cộng thời gian khởi động máy chủ theo hồ sơ vào đích 15 phút của C17.

### QUAN TRỌNG

#### B-QT-1. Toàn bộ giai đoạn 2 bị G07b chặn (chờ hết giao dịch, mặc định ≥ 14 ngày)

- **Liên quan:** PLAN 2.4 (dòng 470–471), 11 (mốc M1/M2); ISSUES C01, C02, C04 (→ G08), C05 (→ G09), G08 (→ G06, G07b), đường găng.
- **Bằng chứng:** `ISSUES.md:55-56` C01, C02 phụ thuộc G08; `ISSUES.md:42` G08 phụ thuộc G07b; C06 phụ thuộc C02. G07b chỉ
  làm khi R002 báo 0 yêu cầu đang chờ và đã qua hạn link (Q1 mặc định 14 ngày). PLAN 2.4 lại viết "để không chặn giai đoạn 2,
  14 route thanh toán mang nhãn `deprecated` trong `routes.json` từ G07a" và G07a có tiêu chí về `routes.json`, trong khi
  `routes.json` chỉ ra đời ở C02, sau G08.
- **Tác động:** Đường găng thật là `G05 → G07a → (chờ ≥ 14 ngày) → G07b → G08 → C02 → C06 → …`, không phải `G12 → C18 → C06`
  như ISSUES ghi; mốc M2 trượt ít nhất 2 tuần. Mâu thuẫn nội bộ giữa G07a và C02.
- **Đề xuất:** C01, C02, C04 phụ thuộc G06 + G07a (không G08); 14 route thanh toán vào `routes.json` với `deprecated: true`
  ngay từ C02; G08 chỉ còn dọn vỏ và cập nhật `routes.json`/`events.json`. C05 tách: ảnh chụp schema sinh từ G04/G06 trước,
  cập nhật lại sau G09. Sửa câu đường găng ở cuối ISSUES và tiêu chí G07a (bỏ câu về `routes.json`).

#### B-QT-2. Không có issue triển khai cấu hình lai; W01/W02 làm hỏng bản đang chạy nếu merge trước khi Rust đứng trước

- **Liên quan:** PLAN 7 (điểm dừng sau giai đoạn 3), 4.14, 5; W01, W02, K17, K18, X01, X06; `docs/runbooks/fast-delivery.md`.
- **Bằng chứng:**
  - W01 (`ISSUES.md:122`) xoá route handler `app/api/v1/[...path]` (proxy API) và rewrite `/.well-known`, chỉ phụ thuộc G11.
    W02 (`:123`) bật `output: 'export'` (mất `proxy.ts`: chặn trang, chuyển hướng `/`, rewrite subdomain cửa hàng, `no-store`),
    phụ thuộc R004, W01. Cả hai không phụ thuộc K17/K18. Hiện `docker-compose.yml:119-138` cho trình duyệt vào thẳng `web:3000`
    và Next chuyển `/api/v1` sang `api:4000`.
  - Bản chạy của chủ dự án: PM2, build trên máy trạm rồi chở artifact, cổng sức khoẻ 40 giây, lui bằng chuyển thư mục
    (`fast-delivery.md` mục 3). Script deploy nằm ngoài repo. Plan không nhắc PM2 lần nào; Rust không build trên máy trạm
    (PLAN 1106: máy không có toolchain, build release trên CI).
  - Chỉ X06 có compose mới, và đó là compose cuối (không có Node).
- **Tác động:** Merge W01/W02 (được đánh dấu song song, giai đoạn 3) là `main` không còn chạy được bằng compose hay PM2 hiện
  tại. "Điểm dừng an toàn sau giai đoạn 3: Rust đứng trước làm proxy" không có artifact nào để triển khai: không có image/compose
  lai, không có bước tải binary từ CI vào script deploy, không có health gate cho tiến trình thứ ba.
- **Đề xuất:** Thêm issue **D01 "triển khai cấu hình lai"** (M, sau K17, K18, K31): compose lai (`trinity` trước, `api` và `web`
  phía sau, chỉ loopback/mạng nội bộ), cập nhật script deploy PM2 (tải binary đã ký từ CI theo commit, cổng sức khoẻ cho cả
  ba tiến trình, lui), tài liệu. W01, W02 phụ thuộc K18 + D01 (hoặc giữ sau cờ build cho tới khi D01 bật trên bản chạy).
  X02a phụ thuộc D01.

#### B-QT-3. Đổi env giữa chừng: job và route không chuyển sở hữu được như mô tả

- **Liên quan:** PLAN 4.9 (cờ `TRINITY_RUST_JOBS` / `TRINITY_DISABLED_JOBS`), 4.14, 6.5 điểm 7, 6.6; K17, K20, T01, X02d, X02e.
- **Bằng chứng:** `TRINITY_DISABLED_JOBS` (T01) là env của Node; muốn chuyển một job phải khởi động lại Node, kéo theo rớt
  socket (Socket.IO còn ở Node tới đợt d) và request dở. Node không có khoá chéo tiến trình (`cron-registry.ts:37-80`:
  chỉ con trỏ trong RAM, không lock), nên trong khoảng giữa "tắt ở Node" và "bật ở Rust" hoặc ngược lại, job hoặc trống
  hoặc chạy hai bên.
- **Tác động:** Quy trình bật đợt d/e không có thứ tự an toàn được viết ra; tiêu chí "mỗi job chỉ một bên chạy" không có cơ
  chế kiểm ở phía Node.
- **Đề xuất:** Gộp với B-QT-4: bảng sở hữu route **và** job đọc từ một **tệp** (`TRINITY_OWNERSHIP_FILE`, JSON) mà cả Rust
  (nạp lại khi `SIGHUP`) và Node (T01 đọc tệp mỗi lượt tick, không cần khởi động lại) cùng đọc. Runbook X01 ghi thứ tự:
  Rust nhận trước, Node nhả sau trong cùng một lần ghi tệp; job hiện có đều nhận việc nguyên tử nên chồng lấn một lượt là
  chấp nhận được, trống thì không. T01 lên cỡ M.

#### B-QT-4. Lui theo đợt bằng `SIGHUP` + env không chạy được (N11 xử lý sai)

- **Liên quan:** PLAN 4.14 dòng 758, 6.5 điểm 7, 6.6 dòng 911; K17, X01 (tiêu chí "lui dưới 2 phút").
- **Bằng chứng:** Xem A/N11. Không có đường nào để tiến trình Rust thấy giá trị env mới mà không khởi động lại.
- **Tác động:** Tiêu chí K17 ("`SIGHUP` đổi sở hữu khi đang có request dài mà không rớt") không thể đạt với thiết kế ghi trong
  plan; đường lui thực tế là khởi động lại, đúng thứ N11 muốn tránh.
- **Đề xuất:** Như B-QT-3 (tệp sở hữu). Env `TRINITY_RUST_ROUTES` chỉ còn là giá trị khởi tạo. Sửa 4.14, 6.5, 6.6, K17, X01.

#### B-QT-5. Phụ thuộc chéo module chưa có chủ: outbox sự kiện, tạo thông báo, tool MCP

- **Liên quan:** ISSUES M07, M08, M13–M14, M16–M18, M22, M27, M30b, M40, M41, M56; M32, M33; PLAN 4.1 ("cổng").
- **Bằng chứng:**
  - `publishIntegrationEvent` (`packages/prisma/src/integrations/integration-events.service.ts:31`, ghi outbox trong
    **cùng** giao dịch nghiệp vụ) được gọi ở `contacts`, `deals`, `custom-objects`, `pos`, `store`, `public-api`, `social`,
    `facebook`, `zalo-oa`. Trong ISSUES, outbox thuộc M33 (đợt e); M07, M08, M17/M18 (đợt c) và M27, M56 (đợt d) không
    phụ thuộc M33. Webhook-kick (`webhook-kick.interceptor.ts`, map `kicks` ở `webhook-dispatcher.service.ts:50`) là lời
    gọi trong tiến trình: khi Rust ghi mà dispatcher còn ở Node thì mất "đá", sự kiện trễ tới lượt tick 10 giây.
  - Tạo thông báo cho người dùng qua `NotificationsService`/`ChannelNotificationsService` ở `contacts`, `deals`, `attendance`
    (`attendance.service.ts:3066`), `newsfeed`, `briefings`, `stale-work`, `facebook`, `zalo-oa`. Module `notify` là M32
    (đợt d), nhưng M07/M08 thuộc đợt c và không phụ thuộc M32. M30b (báo duyệt phiếu lương) cũng không phụ thuộc M32/K33.
  - Tool MCP gọi service của module chưa nằm trong phụ thuộc: `report-tools.ts` → `deps.customReports` (M21) nhưng M40 chỉ
    phụ thuộc M20; `briefing-tools` → M23, `lead-intent-tools` → M24, `interaction-tools` → M08, `feature-tools` →
    `channelGuard`/`channels` (M45, M20), `setup-tools` → `setup`/`versions` (M19, M17) đều thuộc M41 nhưng M41 chỉ phụ
    thuộc M39, M17, M18.
- **Tác động:** Agent làm M07 hoặc tự viết lại phần outbox/thông báo (hai bản, lệch nhau) hoặc bị kẹt; so DB (C16) sẽ báo
  khác biệt ở `integration_events`/`notification_logs` mà không issue nào sở hữu.
- **Đề xuất:** Thêm issue nền **K36 "cổng sự kiện tích hợp và thông báo"** (M): `publish_integration_event(tx, type, payload)`
  theo `events.json` (C04), `create_notification(tx, …)` ghi đúng bảng và phát `NOTIFY` chuông (G12/K33), phát `NOTIFY`
  "kick" cho dispatcher ở bên kia. M07, M08, M13b, M14a, M16, M18, M22, M27, M30b, M56 phụ thuộc K36; M32/M33 chỉ còn route
  và job. Bổ sung phụ thuộc M40 → M21; M41 → M06, M08, M19, M20, M23, M24, M45.

#### B-QT-6. Đăng ký công ty ở Rust (đợt b) cần Rust ghi migration, trái với "trong strangler Rust chỉ kiểm"

- **Liên quan:** PLAN 4.5 (dòng 642), 10.1 rủi ro 5 (dòng 1005); K09, M02, X02b.
- **Bằng chứng:** `provisionCompany` chạy `prisma migrate deploy` cho schema mới rồi ghi `migrated_to`
  (`packages/prisma/src/tenant/provision.ts:31-42,145`). M02 (đăng ký công ty) chuyển sang Rust ở đợt b; K09 làm
  `provisionCompany` + `migrate --companies` bằng migrator Rust. Node lúc boot cũng chạy `migrateAllCompanies` nền.
- **Tác động:** Từ đợt b, migrator Rust **ghi** `_prisma_migrations` của công ty mới trên bản thật, sớm hơn nhiều so với X06
  mà plan nói. Trong lai, cả Node và Rust cùng chạy migrate nền lúc boot.
- **Đề xuất:** Chọn một: (a) giữ `POST /auth/register` ở Node tới X06 (bảng sở hữu tách route này khỏi cụm auth), hoặc
  (b) chấp nhận Rust ghi từ đợt b: đưa test hai chiều K07 vào điều kiện X02b, chỉ một bên chạy migrate nền (cờ), và sửa câu
  ở 4.5 và rủi ro 5.

#### B-QT-7. "Khôi phục từ bản dump của đợt" làm mất dữ liệu khách ghi sau đó

- **Liên quan:** PLAN 6.5 điểm 5, 6.6 dòng 911–912, 10.1 rủi ro 19; X01.
- **Bằng chứng:** Dump lấy ngay trước khi đổi sở hữu; tiêu chí bật đợt cần 48 giờ shadow + 24 giờ công ty thử. Dữ liệu
  dùng chung một DB, mọi module (cả phần Node) tiếp tục ghi.
- **Tác động:** Phát hiện lỗi ghi sau 1–3 ngày rồi khôi phục cả DB từ dump là xoá mọi đơn, chấm công, tin nhắn của **mọi**
  công ty ghi trong khoảng đó, trái nguyên tắc "không xoá dữ liệu khách hàng" của repo.
- **Đề xuất:** Ghi rõ dump là để **đối chiếu và sửa có chọn lọc** (khôi phục vào DB riêng, so theo bảng/dòng mà module của
  đợt ghi, viết script sửa), không phải khôi phục đè. Nếu muốn khôi phục theo thời điểm thì cần WAL archiving/PITR: thêm vào
  X01 như tuỳ chọn có hướng dẫn. Bộ kiểm bất biến X11 chạy **mỗi giờ** trong 72 giờ đầu của mỗi đợt để cửa sổ hỏng ngắn.

#### B-QT-8. Đường nâng cấp cho bản cài tự quản (Docker) chưa có

- **Liên quan:** PLAN 8 (image `distroless/cc` non-root, dòng 961), X06, X07; `install.sh`, `docker-compose.yml`, `Dockerfile`.
- **Bằng chứng:** Volume hiện tại do user `node` (uid 1000) sở hữu: `Dockerfile:49-51` (`chown -R node:node /var/lib/trinity
  /app/uploads`, `USER node`); compose gắn `storage:/var/lib/trinity/storage`, `uploads:/app/uploads`
  (`docker-compose.yml:101-103`). `distroless/cc:nonroot` chạy uid 65532. Image đổi tên (`trinity-api` + `trinity-web` →
  `trinity`), mất service `redis`, `migrate`, `web`; cổng người dùng trỏ reverse proxy vào là `WEB_PORT` 3000 (API 4000 chỉ
  loopback). Healthcheck compose dùng `node -e fetch(...)`, distroless không có shell/node.
- **Tác động:** Người tự cài kéo bản mới sẽ gặp lỗi ghi file (đổi uid), đường dẫn uploads lệch, reverse proxy trỏ sai cổng;
  repo công khai nên đây là người dùng thật, không chỉ bản của chủ dự án.
- **Đề xuất:** X06 thêm tiêu chí: chạy được trên volume cũ (giữ uid 1000 hoặc bước `chown` một lần có tài liệu), giữ
  đường dẫn `/app/uploads` và `/var/lib/trinity/storage` (hoặc env), giữ cổng 3000 mặc định, healthcheck `trinity healthcheck`;
  thêm mục "Nâng cấp từ bản Node" vào X07 và `CHANGELOG` (breaking), thử nâng cấp trên một bản compose có dữ liệu.

#### B-QT-9. `sqlx::query!` cần DB lúc biên dịch; máy agent không có Postgres/Docker

- **Liên quan:** PLAN 4.4 (truy vấn kiểm lúc biên dịch, `.sqlx` offline), 8, 11 (dòng 1106–1109).
- **Bằng chứng:** Với `SQLX_OFFLINE=true`, mỗi câu `query!` **mới hoặc sửa** phải có sẵn trong `server/.sqlx/`; tạo dữ liệu
  đó (`cargo sqlx prepare`) cần một Postgres đã migrate. Plan nói máy phát triển không có toolchain, chỉ chạy `cargo check -p`,
  còn test pg chạy trên CI; luật máy là không Docker trên Mac.
- **Tác động:** Agent không `cargo check` được code có truy vấn mới tại máy; mọi vòng lặp sửa SQL phải đi qua CI (đích 8 phút
  một lượt). Với ~1.900 lời gọi model cần viết lại thành SQL, đây là phần lớn thời gian của giai đoạn 4, chưa nằm trong ước lượng.
- **Đề xuất:** Chốt trong K01/K02: Postgres 16 cài thường (Homebrew) trên máy agent, migrate bằng Prisma, `DATABASE_URL`
  cục bộ để `query!` kiểm trực tiếp; `cargo sqlx prepare --check` trước khi đẩy. Hoặc runner CI tự quản có Postgres. Ghi rõ
  "một tiến trình biên dịch tại một lúc" có nghĩa 3 agent dùng chung một hàng đợi biên dịch, và tính vào hiệu suất song song.

#### B-QT-10. Bộ tính công thức của bảng tuỳ biến không có trong plan

- **Liên quan:** M17, M18, M41 (tool đọc bản ghi), K26; PLAN 10.1 rủi ro 1, 10.3.
- **Bằng chứng:** `services/crm/src/custom-objects/formula/formula-parser.ts` (310 dòng): bộ phân tích + thẩm định kiểu + tính
  giá trị, hàm `round(x, n)` dùng `Math.round(Math.abs(x) * f + Number.EPSILON * f) / f` (dòng 259–262), chuẩn hoá
  `Math.round(x * 1e6) / 1e6` (dòng 266–267), ngày theo UTC+7 (dòng 251–253), `days_between`/`months_between`. Câu lỗi tiếng
  Việt trả ra 400 (`field-definition.ts:36-45`, "Công thức: …"). Giá trị được tính khi trả bản ghi
  (`record-presenter.service.ts:64-105`) và xuất CSV. Mẫu ngành dùng công thức (`education-center.template.ts`). Spec chỉ
  11 ca. Từ "công thức"/"formula" không xuất hiện trong PLAN và ISSUES.
- **Tác động:** Lệch làm tròn số thực JS (cùng loại rủi ro I14) hiện ra ở màn bản ghi, MCP, xuất file; câu lỗi tiếng Việt so
  nguyên văn nên lệch là đỏ golden nhưng chỉ ở ca có sẵn.
- **Đề xuất:** M17 nêu rõ phần công thức (parser, câu lỗi nguyên văn), M18 phần tính giá trị; thêm bảng ca dùng chung TS/Rust
  ≥ 300 ca (biểu thức hợp lệ/lỗi, x,5, số lớn, ngày quanh nửa đêm VN, tháng cuối), dùng hàm `js_round` của 10.3.

#### B-QT-11. Spike R004 bỏ sót hai trường hợp khó nhất của route động

- **Liên quan:** R004 (`ISSUES.md:26`), PLAN 5, K18.
- **Bằng chứng:** Trang cửa hàng trên tên miền phụ: `proxy.ts:33-45` rewrite `<slug>.<STORE_DOMAIN>/` → `/s/<slug>`, tức URL
  trình duyệt là `/` nhưng nội dung là `/s/[slug]`. Với phương án A ("trang giữ chỗ + `usePathname()`"), `usePathname()` trả `/`
  nên không lấy được slug, và App Router phía trình duyệt có thể điều hướng lại theo URL `/`. `invite/[token]` mang token mời
  trong đường dẫn (phương án B sẽ đưa token vào query, dễ lọt log). R004 chỉ thử `contacts/[id]` và `x/[objectKey]/v/[viewKey]`.
- **Tác động:** Phương án được chốt có thể không chạy cho trang bán hàng (đã quyết giữ) và chỉ lộ ở K18/W04.
- **Đề xuất:** R004 thêm hai trang `s/[slug]` (cả `/s/<slug>` và tên miền phụ) và `invite/[token]` vào 5 tiêu chí. Ghi cách
  Rust truyền slug cho trang khi phục vụ qua tên miền phụ (ví dụ chèn `<meta>`/biến JSON vào HTML). Lọc log (K04) che cả
  `token` trong query.

#### B-QT-12. Ước lượng giai đoạn module vẫn ở tốc độ bị chê ở lượt 1

- **Liên quan:** PLAN 0, 11; ISSUES giai đoạn 4.
- **Bằng chứng:** Tổng 205 ngày-agent đúng số học. Chia theo giai đoạn: R 4, G 18, C 30,5, K 30, T 0,5, W 3,5, **M 97**, X 13,5,
  X12 8. 65 issue M phủ gần hết ~77.000 dòng TS (82.800 trừ phần nền đã ở K) ⇒ khoảng **790 dòng TS mỗi ngày-agent**, đã gồm
  viết SQL tay cho ~1.900 lời gọi Prisma, ~2.000 luật validation, test hợp đồng, 3 lượt review. Con số "400 dòng/ngày" ở mục 11
  có được vì chia cho cả phần không phải chuyển mã. Lượt 1 chê 875 dòng/ngày; phần module gần như không đổi. Chưa tính
  B-QT-9 (vòng biên dịch qua CI) và hàng đợi biên dịch chung trên một máy 16 GB.
- **Tác động:** Mốc M3–M6 có xác suất trượt cao; 5 issue X12 (8 ngày) là dự phòng duy nhất.
- **Đề xuất:** Ước lượng giai đoạn 4 theo dải 140–190 ngày-agent (khoảng 400–550 dòng/ngày), tổng 250–300; giữ 205 làm
  "khoảng dưới". Đo tốc độ thật sau 5 issue M đầu (M01, M06, M07, M15, M25) rồi chỉnh dòng thời gian, ghi điểm đo này vào mục 11.

### NHỎ

| # | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|
| N-1 | Thiếu issue cho các ca e2e gọi hàm nội bộ không phải job/cache (B1 phần b) | `createLog`, `IntegrationAuditService.log` (kiểm che SĐT trong audit), `verifyAccessToken`, `collect(…, NOW)`, `reapStuckProcessing(NOW)` | Mỗi ca ghi rõ ở issue C tương ứng: viết lại qua HTTP + SQL tương đối với giờ thật, hoặc chuyển thành unit test bảng ca dùng chung; tiêu chí "N ca đạt" tính số đã chuyển, liệt kê ca bị chuyển loại |
| N-2 | Khoá chống chạy trùng job chỉ có ở Rust; PLAN 3 điểm 3 còn ghi khoá mức phiên | `cron-registry.ts:37-80`; PLAN dòng 484 | Sửa câu; T01 cho Node nhận lượt qua cùng `platform.job_runs` (hoặc ghi rõ dựa vào nhận việc nguyên tử theo dòng) |
| N-3 | Chế độ một công ty: `platform.job_runs` cũng nằm ở `platform` (4.3 chỉ ngoại lệ bảng hàng đợi); công ty 1 không có `migrated_to` | PLAN dòng 605–606; `provision.ts:57-58` | Sửa 4.3; quy tắc "từ chối công ty chưa migrate" cho công ty 1 đọc `_prisma_migrations` của `public` |
| N-4 | Số thứ tự migration của G04, G05, G06, G09 chưa chốt; G09 ghi cứng `0021` trong khi G04/G05/G06 cũng thêm migration và chạy song song | `ISSUES.md:37-43` | Đặt trước: G04 `0021`, G05 `0022`, G06 `0023`, G09 `0024`; PR sau rebase đổi tên nếu cần trước khi merge |
| N-5 | VietQR (EMVCo) cần mã BIN ngân hàng (6 số), cấu hình SePay cũ lưu tên viết tắt ("MBBank", "Vietcombank") | `connectors.service.ts:16-18,50-55` | G05: bảng ánh xạ tên SePay → BIN (NAPAS); tên không có trong bảng thì tắt chuyển khoản và nhắc nhập lại; 10 mẫu đối chiếu gồm cả bước ánh xạ |
| N-6 | M44a ghi 23 tool; đếm thật nhóm đăng bài là 17 + 6 + 3 = 26, trừ `list_youtube_playlists` còn **25**. Tổng các nhóm M40–M44c khi đó mới ra 101 | `tools/social-tools.ts` (17), `actions/action-social-tools.ts` (6), `actions/action-recurring-tools.ts` (3) | Sửa M44a thành 25 tool |
| N-7 | R001 còn ghi "150 issue được tạo" | `ISSUES.md:23` | Sửa thành 175 (hoặc "đủ số trong ISSUES") |
| N-8 | Bảy cách lấy IP khác nhau ở Node; `oauth-rate-limits.ts:5-12` (dùng cho OAuth và MCP) chỉ tin `x-real-ip` khi kết nối từ **127.0.0.1**, không tin mạng riêng; `store.controller.ts:18` lấy `x-forwarded-for[0]` | các file đã nêu | Cấu hình lai bắt buộc Node nghe loopback và Rust gọi qua loopback (ghi vào D01, không dùng mạng compose); K16 có bảng ca IP theo từng route; giữ nguyên hành vi từng chỗ khi chuyển, ghi lỗi `x-forwarded-for[0]` của cửa hàng thành việc sửa sau X06 |
| N-9 | Làm mới token Zalo OA dùng single-flight trong RAM; refresh token Zalo dùng một lần | `zalo-oa-token.service.ts:34` | M52: khoá `pg_advisory_xact_lock` theo OA khi làm mới (an toàn cả khi Rust nhiều luồng và khi đổi sở hữu giữa chừng) |
| N-10 | Chống chèn công thức khi xuất CSV/xlsx không nằm trong danh sách bảo mật | `custom-objects/csv-format.ts:4-8` | Thêm vào 10.2 (Bảo mật) và tiêu chí K29/M18/M21: ô bắt đầu bằng `= + - @ \t \r` được thêm `'`, ghi kiểu chuỗi |
| N-11 | Bỏ Vercel kéo theo bản demo công khai (đang deploy trên Vercel theo `fast-delivery.md` mục 3) không còn chỗ chạy | `docs/runbooks/fast-delivery.md` | G11 thêm bước chuyển bản demo sang máy chủ tự quản (hoặc tắt có thông báo) và sửa runbook |
| N-12 | X13 khôi phục dữ liệu thật lên "máy riêng" và cần ký JWT cho người dùng thật | PLAN 6.5 điểm 3, X13 | Ghi điều kiện: máy do chủ dự án quản, ổ mã hoá, xoá bản sao sau khi quét, dùng `JWT_SECRET` riêng của máy quét (ký token mới), không dùng bí mật production |
| N-13 | Đối số thừa trong tool MCP: zod mặc định bỏ khoá lạ, JSON Schema sinh ra có thể có `additionalProperties: false` ⇒ Rust (kiểm bằng `jsonschema`) từ chối chỗ Node chấp nhận | `mcp-server.service.ts` `registerTool` với `inputSchema: tool.input(z)` | C03 thêm golden "gọi tool với khoá thừa"; M39 khớp theo golden đó |
| N-14 | Dọn dữ liệu mẫu còn đọc `payment_intents` (bảng sắp lưu trữ) để không xoá khách đang được tham chiếu | `sample-records.service.ts:144` | Ghi ngoại lệ "chỉ đọc" cho truy vấn này ở G07b và M19, hoặc bỏ kèm lý do |

---

## C. Kiểm ISSUES

| Tiêu chí | Kết quả |
|---|---|
| Mỗi issue một PR | Đạt với đa số. Rủi ro PR quá lớn: G12 (L, đụng auth, rbac-nest, notification, payroll, crm, channel-guard; 5 kênh `NOTIFY`): nên tách G12a (bỏ Redis) và G12b (kênh `NOTIFY` + test hai tiến trình). C06 (L) gánh khung + seed + máy chủ giả + hồ sơ cấu hình (B-CHẶN-1): tách C06a khung/seed, C06b máy chủ giả Graph/Zalo |
| Phụ thuộc vòng | Không có |
| Phụ thuộc thiếu | B-QT-1 (C01/C02/C04), B-QT-2 (W01/W02 → K18, D01), B-QT-5 (K36; M40, M41, M30b), B-QT-6 (M02) |
| Song song đụng file/migration | G04/G05/G06/G09 cùng thêm migration (N-4). G02, G04, G06, G07a cùng sửa `mcp-tools.registry.ts`, `org-features.ts`, `MCP_SERVER_INSTRUCTIONS`: đã ghi `rebase`, nhưng G06 và G07a được đánh "song song với nhau" mà đều đụng hai file này. Giai đoạn 4: mọi M cùng sửa `server/.sqlx/` và bảng route chung; cần quy ước một file `.sqlx` mỗi truy vấn (mặc định của sqlx) và bảng route theo crate để rebase không xung đột |
| Tiêu chí xong đo được | Phần lớn đo được. Chưa đo được: "quét được bằng 2 app ngân hàng" (G05, cần người), "người duyệt xem mẫu phiếu lương" (rủi ro 7, không có issue), "khoảng 10 endpoint" ở M13a/M13b/M14a/M55a/M55b (nên ghi danh sách route cụ thể từ `routes.json` để không trùng/sót giữa các issue tách đôi) |
| Trùng/thừa | Không có issue trùng. T01 và K20/K34 có phần chồng về sở hữu job: gộp lại theo B-QT-3. X03 (báo cáo shadow 7 ngày) và X12e chồng một phần; giữ được nếu X03 chỉ là báo cáo |

## D. Ước lượng thời gian

205 ngày-agent cộng đúng theo quy ước cỡ, và có cải thiện thật so với lượt 1 (tách issue, dự phòng, dòng thời gian theo mốc).
Tuy vậy chưa hợp lý ở ba điểm: tốc độ giai đoạn module (B-QT-12), vòng biên dịch/truy vấn không có DB cục bộ (B-QT-9), và
thời gian chờ G07b nằm trên đường găng (B-QT-1). Ước lượng thực tế hơn: **250–300 ngày-agent, 22–28 tuần với 3 agent**; giữ
205 làm khoảng dưới và chỉnh lại sau khi đo 5 issue M đầu.

## Kết luận

Plan **chưa đủ** để bắt đầu theo định nghĩa "không còn CHẶN/QUAN TRỌNG": còn 1 CHẶN và 12 QUAN TRỌNG. Có thể bắt đầu ngay
các việc không phụ thuộc những điểm này: R002–R006, G01, G02, G04, G05, G10, G11 (kèm N-11), G15. Trước khi tạo issue
trên GitHub cần: hồ sơ cấu hình cho test hộp đen (B-CHẶN-1); sửa chuỗi phụ thuộc C01/C02/C04 (B-QT-1); thêm D01 và K36
(B-QT-2, B-QT-5); tệp sở hữu thay cho env + `SIGHUP` (B-QT-3, B-QT-4); chốt cách đăng ký công ty trong lai (B-QT-6);
sửa cách dùng dump (B-QT-7); thêm tiêu chí nâng cấp cho X06 (B-QT-8); chốt Postgres cục bộ cho sqlx (B-QT-9); thêm công
thức vào M17/M18 (B-QT-10); mở rộng R004 (B-QT-11); đánh lại ước lượng (B-QT-12).
