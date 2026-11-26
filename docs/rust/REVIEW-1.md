# Phản biện lần 1: PLAN.md và ISSUES.md (viết lại backend bằng Rust)

Ngày 26/11/2026 · Đối chiếu với mã ở worktree `rust-plan` (HEAD `fef6dab`) · Người phản biện độc lập, không sửa plan
hay mã, không chạy build/test.

## Tóm tắt

| Mức | Số phát hiện |
|---|---:|
| CHẶN | 3 |
| QUAN TRỌNG | 17 |
| NHỎ | 16 |
| **Tổng** | **36** |

Số đo chính của plan **khớp** với mã (đếm lại bằng lệnh ở Phụ lục A của plan): 639 endpoint, 117 model + 1 enum,
21 migration, 115 tool MCP tĩnh (mảng `MCP_TOOLS` trong `mcp-tools.registry.ts`), 13 lần `cronRegistry.register`,
64 quyền và 22 công tắc tính năng, 590 `@ApiOperation` và 0 `@ApiResponse` có `type`, 61 `@updatedAt`, 28 cascade,
phép trừ 639 − 74 − 1 − 12 = 552 và 115 − 14 = 101. Tổng ca e2e đếm theo `^\s*(it|test)\(` là 345 (plan: 349, do
`grep -c "it(\|test("` đếm cả dòng có `it(` ở giữa); C09 thực tế 22 ca (plan 24), C13 thực tế 71 ca (plan 73).

Chỗ yếu không nằm ở số đếm mà ở các giả định chưa kiểm: bộ e2e chưa chuyển sang hộp đen được bằng cách "chỉ thay lớp
vận chuyển", máy chủ giả Graph/Zalo không có chỗ cắm, shadow GET sẽ gọi ra Graph và ghi DB, và giai đoạn lai còn
nhiều state trong RAM hơn danh sách ở mục 3.4.

---

## CHẶN

### B1. Chuyển e2e sang hộp đen không phải "chỉ thay lớp vận chuyển"

- **Liên quan:** PLAN 6.2 ("chuyển từ supertest… là thay lớp vận chuyển, không viết lại kịch bản"); C06–C13, C17.
- **Bằng chứng:**
  - 22 lời gọi `app.get(...)` vào service trong tiến trình: `WebhookDispatcherService.tick()`
    (`apps/monolith/test/rbac/webhooks-out.e2e-spec.ts:43,271,301,312`), `WebhookDeliveryWorker`,
    `AiActionExpiryService.runOnce()` (`ai-actions.e2e-spec.ts:364,425`), `RbacCache.invalidateUsers` (6 chỗ),
    `OauthTokenService` (4), `IntegrationAuditService` (2), `NotificationsService`, `DeliveryService`,
    `BriefingAggregatorService`, và client Redis lấy thẳng từ DI để `keys`/`del` khoá rate limit
    (`mcp.e2e-spec.ts:91`, `ai-actions.e2e-spec.ts:99,381`). Lệnh: `grep -ho "app.get([A-Za-z]*" apps/monolith/test/rbac/*.e2e-spec.ts | sort | uniq -c`.
  - 362 lời gọi `prisma.<model>` trực tiếp trong spec (seed và sửa DB giữa ca, ví dụ `webhooks-out` 62, `ai-actions` 72,
    `webhooks-in` 50, `mcp` 30). Lệnh: `grep -hE "prisma\.[a-zA-Z$]+" apps/monolith/test/rbac/*.e2e-spec.ts | wc -l`.
  - Seed người dùng/vai trò trong `harness.ts:161-197` cũng qua Prisma.
- **Tác động:** Các ca phụ thuộc job (webhook ra, hết hạn thao tác AI, thông báo hẹn giờ, bản tin) và ca sửa quyền
  trực tiếp trong DB rồi xoá cache **không chạy được** qua HTTP. Với Rust còn tệ hơn: cache quyền TTL 60 giây
  (PLAN 4.7) làm ca "sửa vai trò trong DB rồi gọi lại" đỏ giả. C07–C13 bị cỡ thấp và tiêu chí "N ca đạt" không đạt
  được nếu không có cơ chế điều khiển.
- **Đề xuất:**
  1. Thêm issue mới (trước C06, cỡ M, cả TS và Rust): **API điều khiển test** chỉ bật khi `TRINITY_TEST_HOOKS=1` và
     `NODE_ENV!=production` (Rust: cờ biên dịch `test-hooks` + env), có `x-service-secret`:
     `POST /internal/test/jobs/:name/run` (chạy một lượt job cho một công ty), `POST /internal/test/cache/flush`
     (quyền, đếm, dashboard, blacklist, rate limit), `POST /internal/test/clock` (nếu cần giờ giả). Tiêu chí: route
     không tồn tại trong build production (test hợp đồng kiểm 404).
  2. Seed/sửa DB trong test dùng `pg` thẳng (SQL), không Prisma; viết helper chung `tests/contract/db.ts`.
  3. Đánh lại cỡ C07, C12, C13 lên L+ (hoặc tách đôi), sửa câu ở PLAN 6.2.

### B2. Không có chỗ cắm máy chủ giả Graph/Zalo, cũng không có issue để thêm

- **Liên quan:** PLAN 6.2 ("thêm ở bản TS nếu chưa có"), C06, C14f, C15, M46–M55, X02e.
- **Bằng chứng:** URL cứng, luôn `https`: `services/crm/src/facebook/graph-client.ts:79`
  (`https://graph.facebook.com/${graphVersion}/…`), `social/providers/facebook.provider.ts:231`,
  `social/facebook-first-comment.ts:22`, `zalo-oa/zalo-oa.config.ts:7-13` (4 URL Zalo). Không có biến env nào đổi
  host: `grep -rnoE "process\.env\.[A-Z_]*(GRAPH|ZALO)[A-Z_]*" services` chỉ ra biến version/app, không có base URL.
- **Tác động:** Khung test hợp đồng (C06) không dựng được máy chủ giả; toàn bộ phủ route cụm kênh (C14f, C15) và tiêu
  chí "dùng máy chủ giả" của M46–M55 không làm được. Không có issue nào nằm trên đường găng cho việc này.
- **Đề xuất:** Thêm issue giai đoạn 1 (cỡ S, trước C06): `FACEBOOK_GRAPH_BASE_URL`, `ZALO_OAUTH_BASE_URL`,
  `ZALO_OPENAPI_BASE_URL`, `ZALO_ZNS_BASE_URL` (mặc định như hiện tại, nhận `http://` chỉ ngoài production), gom 3 chỗ
  dựng URL Graph về một hàm. Rust đọc cùng biến (K03). Ghi phụ thuộc vào C06.

### B3. Shadow "chỉ GET" vẫn ghi DB và gọi Graph API

- **Liên quan:** PLAN 3.2, 4.14, 6.5 điểm 3; K28, X02a–e, X03.
- **Bằng chứng:**
  - `GET /facebook/conversations/:id/messages` gọi `syncConversation` (lấy tin từ Graph) rồi đặt `unread_count = 0`
    (`facebook/facebook.controller.ts:86-90`, `facebook/facebook-messenger.service.ts:347-352`).
  - `GET /zalo-oa/threads/:id/messages` gọi `markRead` (`zalo-oa/zalo-oa.controller.ts:84-108`,
    `zalo-oa-threads.service.ts:124-126`).
  - `GET /facebook/go/:code` tăng `clicks` (`facebook-public.controller.ts:23`, `facebook-chat-links.service.ts:82`).
  - Các callback OAuth là GET và đổi `code` lấy token: `facebook/oauth/callback`, `zalo-oa/oauth/callback`,
    `social/oauth/callback/:network`.
- **Tác động:** Shadow chạy lại handler Rust sau Node sẽ (a) gọi Graph lần hai, tính vào hạn mức/cửa sổ lỗi của
  ChannelGuard và giới hạn toàn app Meta; (b) ghi DB lần hai (đếm click gấp đôi); (c) đổi lại `code` OAuth đã dùng,
  sinh lỗi và có thể ghi trạng thái kết nối lỗi. Đây là ghi thật vào dữ liệu khách, trái nguyên tắc của chính plan.
- **Đề xuất:** Trong `routes.json` (C02) thêm cột `safe_for_shadow` mặc định `false`; chỉ bật cho GET đã rà là thuần
  đọc. Thêm vào K28: shadow chạy trong giao dịch `READ ONLY` (`SET TRANSACTION READ ONLY`) và với HTTP client ra ngoài
  bị thay bằng client từ chối mọi request; vi phạm thì ghi "không shadow được", không thử lại. Thêm ca test K28: GET
  có ghi thì shadow không đổi DB, không gọi mạng.

---

## QUAN TRỌNG

### I1. `routes.json` thiếu nhiều hành vi khai ở decorator

- **Liên quan:** PLAN 1.2, 4.7, 6.1; C02, K14, K15.
- **Bằng chứng (đếm trong `services`):** 48 `@RequireOrgFeature(` (cổng tính năng, 403 có câu riêng); guard riêng
  `@UseGuards(ApiKeyGuard, PublicApiRateLimiterGuard)`, `@UseGuards(PlanTokenGuard)` (`usage/usage.controller.ts:30`);
  119 `@HttpCode(`; 53 `@Res(` (trả tay, bỏ qua interceptor/filter); 262 `ParseIntPipe`, 2 `ParseUUIDPipe`;
  38 `@Transform(` và 117 `@Type(` (pipe chạy `transform: true`, `service-aware-validation.pipe.ts:48-53`); interceptor
  riêng `webhook-kick.interceptor.ts` và `FileInterceptor` ở 6 controller. Mặc định Nest trả **201** cho POST không có
  `@HttpCode`; axum trả 200.
- **Tác động:** Cổng CI "Rust có đúng tập route, quyền, chế độ validation" xanh trong khi mã trạng thái, cổng tính
  năng, lỗi tham số đường dẫn (`Validation failed (numeric string is expected)`) và chuẩn hoá đầu vào lệch.
- **Đề xuất:** Mở rộng schema `routes.json`: `status_ok` (200/201/204/302), `org_feature`, `guards[]`,
  `raw_response` (có `@Res`), `param_pipes` theo tham số, `transforms` theo trường DTO. K14 kiểm các cột này; K15 thêm
  ca cho 38 `@Transform`. Ghi rõ quy tắc 201 vào PLAN 1.2.

### I2. Giai đoạn lai: "cổng" nội bộ và socket bị chia đôi tiến trình

- **Liên quan:** PLAN 3.4, 4.1 (cổng), 4.10, 10.1 rủi ro 3; G12, K17, K33, M32, X02c–d.
- **Bằng chứng:** `apps/monolith/src/internal-ports/internal-ports.module.ts:25-45` nối `CRM_WS_EMIT_PORT` và
  `PAYROLL_PAYSLIP_NOTIFY_PORT` bằng lời gọi hàm trong tiến trình tới `SubscribersService`. Socket.IO sống ở **một**
  tiến trình. G12 chỉ phát qua `NOTIFY` vô hiệu cache quyền, blacklist, phiên.
- **Tác động:** Khi đợt c (kanban, khách hàng) chạy ở Rust mà socket vẫn ở Node (M32/K33 bật ở đợt d), hoặc ngược
  lại, chuông thông báo realtime và thông báo duyệt phiếu lương mất lặng lẽ.
- **Đề xuất:** Thêm vào G12 kênh `NOTIFY trinity_ws_emit` (payload: company, user ids, notification id; lấy nội dung
  từ DB vì payload `NOTIFY` giới hạn 8 KB) và `trinity_payslip_approved`; bên giữ socket `LISTEN`. Thêm ca test hai
  tiến trình vào tiêu chí G12 và X02c. Ghi vào PLAN 3.4 danh sách đầy đủ state/cổng phải chia sẻ.

### I3. ChannelGuard và rate limit trong RAM bị chia đôi

- **Liên quan:** PLAN 1.12, 3.4, 10.1 rủi ro 13; G12, M45–M51, X02e.
- **Bằng chứng:** Cửa sổ lỗi Graph 60 phút và backoff toàn app nằm trong RAM theo tiến trình (`docs/multi-tenant.md`,
  mục "Graph API error tracking": "per company (in memory, last 60 minutes)", "the instance backs off");
  `FixedWindowLimiter` ở 9 file (`grep -rln "FixedWindowLimiter\|RateLimiter" services`).
- **Tác động:** Khi lời gọi Graph ra đi từ hai tiến trình (route gửi tay ở bên này, job broadcast/flow ở bên kia, hoặc
  tool MCP còn ở Node), mỗi bên chỉ thấy một phần lỗi ⇒ ngưỡng tự tạm dừng (2 lỗi #368, 10 chặn/30%) đến muộn hoặc
  không đến; Meta có thể hạn chế cả app dùng chung. Giới hạn đăng nhập/MCP/OAuth tăng gấp đôi.
- **Đề xuất:** Ràng buộc cứng trong X02e: mọi route và job gọi Graph ra (M46–M55 **và** tool MCP gửi tin M44) chuyển
  trong cùng một lần khởi động; hoặc ghi kết quả gọi Graph vào bảng `channel_events` (đã có) và đọc cửa sổ từ DB.
  Thêm câu này vào rủi ro 3.

### I4. Advisory lock mức phiên trên pool dùng chung

- **Liên quan:** PLAN 3.3, 4.9 ("`pg_try_advisory_lock(hash(job), company)`"); K20, K21.
- **Bằng chứng:** Mã hiện tại chỉ dùng khoá mức giao dịch: 28 lần `pg_advisory_xact_lock`, 0 lần
  `pg_advisory_lock`/`pg_try_advisory_lock` (`grep -rhoE "pg_(try_)?advisory_(xact_)?(un)?lock[a-z_]*" services packages scripts`).
- **Tác động:** Khoá mức phiên giữ trên kết nối của pool; task bị huỷ/panic trước `unlock` thì kết nối về pool vẫn
  giữ khoá ⇒ job của công ty đó bị bỏ qua vĩnh viễn tới khi kết nối đóng. Với pool 4–8 kết nối, còn chiếm kết nối suốt
  budget 30–40 giây.
- **Đề xuất:** Dùng `pg_try_advisory_xact_lock` trong một giao dịch ngắn để "nhận lượt" (ghi `locked_until` vào bảng
  trạng thái job) thay vì giữ khoá suốt lượt; hoặc kết nối riêng ngoài pool cho scheduler. `after_release` gọi
  `pg_advisory_unlock_all()`. Thêm ca test K20: huỷ task giữa chừng, lượt sau vẫn chạy.

### I5. Giữ kết nối pool qua lời gọi mạng

- **Liên quan:** PLAN 4.3 (`Ctx { company, user, db, now }`, pool 8; 1 GB: 4), 9.
- **Bằng chứng:** Nhiều handler gọi Graph/Zalo giữa các truy vấn, ví dụ `facebook-messenger.service.ts:347-352`
  (đọc DB → `syncConversation` gọi Graph → ghi DB). Prisma hiện lấy kết nối theo từng câu.
- **Tác động:** Nếu `Ctx.db` là kết nối đã lấy từ đầu request, 4 request chờ Graph (timeout 15 giây) làm cạn pool trên
  máy 1 GB; đăng nhập và health cũng đứng.
- **Đề xuất:** `Ctx` giữ `TenantDb` (handle lấy kết nối theo nhu cầu), không giữ `TenantConn`; quy tắc lint/test:
  không `await` HTTP ra ngoài khi đang giữ `TenantConn`/`TenantTx`. Đặt `acquire_timeout` và `statement_timeout`.
  Thêm ca tải vào X05: 10 request treo Graph + đăng nhập đồng thời.

### I6. Proxy strangler làm giả được IP văn phòng

- **Liên quan:** PLAN 4.14 ("đặt `x-forwarded-*`"), 10.2 Rate limit; K16, K17.
- **Bằng chứng:** `services/auth/src/auth/login-wifi-check.helper.ts:78-99`: Node tin `x-real-ip` **trước**
  `x-forwarded-for` khi socket đến từ loopback/mạng riêng. Khi Rust đứng trước, mọi request tới Node đều từ loopback.
- **Tác động:** Client gửi `X-Real-IP: <IP văn phòng>` qua Rust ⇒ Node tin ⇒ vượt kiểm Wi-Fi đăng nhập, kiểm IP chấm
  công (M13), rate limit theo IP.
- **Đề xuất:** K17: luôn **xoá** `x-real-ip`, `x-forwarded-for`, `forwarded`, `cf-connecting-ip` do client gửi rồi đặt lại
  từ IP Rust đã xác định (theo K16). Ca test bắt buộc: client gửi `X-Real-IP` giả, Node vẫn thấy IP thật.

### I7. Gỡ thanh toán khi còn giao dịch đang chờ

- **Liên quan:** PLAN 2.3, Q6; R002, G07, G10.
- **Bằng chứng:** 14 endpoint SePay/VNPay/MoMo gồm return/IPN công khai (PLAN 2.1); `PaymentIntent` thành bảng lưu
  trữ. R002 chỉ đếm dòng, không đếm intent đang chờ; webhook SePay do khách tự cấu hình trên trang SePay, script G10
  không gỡ được.
- **Tác động:** Khách trả tiền sau lúc deploy G07 thì IPN/webhook rơi vào 404 ⇒ tiền đã vào tài khoản cửa hàng nhưng
  Trinity không ghi nhận (đụng tiền).
- **Đề xuất:** Tách G07 thành hai bước: (a) chặn tạo yêu cầu thanh toán mới + banner báo, (b) sau N ngày (≥ hạn link
  thanh toán) và khi R002 cho thấy 0 intent `pending` mới gỡ. Endpoint gỡ trả **410** kèm câu rõ thay vì 404. Thêm vào
  R002: đếm `payment_intents`/`store_orders` theo trạng thái. Tương tự cho đơn trang bán hàng (G05).

### I8. Gỡ provider trước migration dọn dữ liệu (G04/G06 trước G09)

- **Liên quan:** PLAN 2.3 bước 4, 2.4; G04, G06, G09.
- **Bằng chứng:** `social/social-posts.service.ts:179,294` lấy provider qua `this.providers.get(network)`;
  `social.config.ts:7` khai 5 mạng. G09 (đổi trạng thái đích chờ, tắt bài lặp/khung giờ) phụ thuộc G02–G08 nên chạy sau
  cùng.
- **Tác động:** Từ lúc deploy G04 tới G09, job `social.publish` gặp đích YouTube/TikTok/GBP/IG chờ đăng mà không có
  provider: lỗi lặp mỗi phút hoặc đánh dấu thất bại không lý do; bài lặp vẫn sinh đích mới.
- **Đề xuất:** Đưa phần dữ liệu của từng mạng vào chính PR gỡ (migration nhỏ trong G04, G06), hoặc code G04 xử lý
  "mạng không còn hỗ trợ ⇒ huỷ kèm lý do" trước khi xoá provider. G09 chỉ còn `COMMENT ON TABLE`.

### I9. Thiếu bản dump trước mỗi đợt bật

- **Liên quan:** PLAN 2.3 bước 7, 6.6; X01, X02a–e.
- **Bằng chứng:** `docs/runbooks/fast-delivery.md:42`: DB chỉ dump "khi diff có migration". Đợt bật Rust đổi toàn bộ
  đường ghi mà không có migration.
- **Tác động:** Lỗi ghi của Rust làm hỏng dữ liệu thì "lui" chỉ đổi đường chạy, không có điểm khôi phục.
- **Đề xuất:** X01 và từng X02: dump toàn bộ DB (mọi schema) + snapshot thư mục `storage`/`uploads` ngay trước khi đổi
  sở hữu; thử khôi phục một lần trên máy thử (thêm vào tiêu chí X01).

### I10. Tiêu chí bật thiếu cỡ mẫu và thiếu kiểm đường ghi trên dữ liệu thật

- **Liên quan:** PLAN 6.5 điểm 2–3; X02a–e, X03.
- **Bằng chứng:** Tiêu chí là "48 giờ shadow, tỉ lệ khác biệt = 0"; không có số mẫu tối thiểu. Đường ghi chỉ được so
  trên DB sạch (C16); trên bản chạy chỉ module lương/POS/gửi tin có bước công ty thử.
- **Tác động:** Bản cài ít người dùng có nhiều route 0 mẫu sau 48 giờ ⇒ tiêu chí đạt rỗng. Lỗi ghi chỉ lộ với dữ liệu
  thật (JSON cũ, dòng thiếu trường) lọt qua.
- **Đề xuất:** Mỗi route GET có `min_samples` (ví dụ 50, hoặc "không áp dụng" có lý do); route chưa đủ mẫu thì chạy
  lại ca hợp đồng trên bản sao DB PROD đã che PII. Mọi module có ghi (không chỉ lương/POS/gửi tin) chạy công ty thử
  24 giờ; thêm bộ kiểm bất biến DB chạy hằng ngày trong giai đoạn lai (đếm theo bảng, `updated_at` không lùi, mã tự
  sinh không trùng, JSON đọc được bằng Node).

### I11. Phụ thuộc thiếu hoặc sai trong ISSUES

- **Liên quan:** ISSUES giai đoạn 4–5.
- **Bằng chứng và đề xuất:**
  - X02a phụ thuộc `M06, K28` nhưng **không** phụ thuộc X01 (runbook lui) ⇒ thêm X01; cũng thêm K31 (CI pg + hợp đồng
    trên Rust).
  - X02d/X02e chuyển job (M23, M24, M32–M34, M50, M51, M54) nhưng không phụ thuộc T01 (cờ tắt job ở Node) ⇒ thêm T01.
  - X06 không phụ thuộc X10 (rà bảo mật) và X07 ⇒ thêm X10.
  - M37 (CIMD tải qua lớp chống SSRF) và M53 (tải media từ URL, `safe-http-get.ts`) cần bộ chống SSRF nhưng bộ này nằm
    trong M34 ⇒ tách issue nền `trinity-kernel::ssrf` (S) cho cả ba.
  - M40/M42 (tool `my_tasks`, ghi việc) dùng `KanbanCardsService` (`tools/tool-types.ts`) ⇒ thêm M16.
  - M06 nhận "2 endpoint của khoá kênh" trong khi M45 cũng là channel-guard ⇒ ghi rõ một chủ.
  - C06 phải phụ thuộc issue mới của B1 và B2.

### I12. Ước lượng thời gian lạc quan

- **Liên quan:** PLAN 0, 11.
- **Bằng chứng:** 94 ngày-agent cho ~82.400 dòng TS + bộ hợp đồng + hạ tầng ⇒ khoảng 875 dòng TS/ngày-agent đã gồm test
  và 3 lượt review. Ví dụ: M13 + M14 = 2 ngày cho `attendance` 6.238 dòng / 40 endpoint / 4 loại xlsx; M44 = 1 ngày cho
  "khoảng 40 tool" phụ thuộc 9 issue; C12 = 1 ngày cho 77 ca dùng nội bộ dispatcher/worker (B1). Không có dòng nào cho
  vòng sửa lệch do shadow/golden phát hiện, mà plan tự nhận là phần không chắc nhất.
- **Đề xuất:** Tách các issue L > 1.500 dòng TS (M13, M14, M30, M44, M47, M53–M55) thành 2–3 PR; thêm 15–20% ngày-agent
  dự phòng "sửa lệch" theo đợt; nêu ước lượng theo mốc (điểm dừng an toàn) thay vì một con số tổng.

### I13. RAM và số kết nối của giai đoạn lai chưa có ngân sách

- **Liên quan:** PLAN 4.3, 7 ("hệ lai chạy ổn định vô thời hạn"), 9; R003.
- **Bằng chứng:** Node mở tới 5 + 30 × 2 = 65 kết nối (PLAN 1.5), cộng Next server, cộng Rust (pool 8) và Postgres.
- **Tác động:** Nếu bản chạy đang ở máy 2 GB, giai đoạn lai có thể hết RAM hoặc chạm `max_connections`; đích 1–2 GB
  của plan chỉ đúng sau X06.
- **Đề xuất:** R003 đo thêm "Node + Next + Rust proxy" và ghi rõ máy chạy giai đoạn lai; trong lai đặt
  `TENANT_MAX_CLIENTS`/`TENANT_CONNECTION_LIMIT` của Node thấp, Rust pool 4; điều kiện dừng: swap > X MB thì lui.

### I14. Lương: số thực JS và `rust_decimal` không cho cùng kết quả

- **Liên quan:** PLAN 4.2 (`rust_decimal`), 10.2 Tiền và số; M29–M31.
- **Bằng chứng:** `services/payroll/src` có 71 chỗ `Math.round`/`Number(`/`toNumber()` trong `payslips` và `tax`, và
  17 chỗ phép toán `Decimal` (`.mul(`, `.plus(`, `new Decimal`). Phép tính đi qua cả `Number` (IEEE double) lẫn
  `Decimal`.
- **Tác động:** Dùng `rust_decimal` cho bước mà Node làm bằng double (hoặc ngược lại) làm lệch 1 đồng ở ca biên
  (x.5, thuế luỹ tiến) ⇒ tiêu chí "100 phiếu khớp từng đồng" có thể không đạt hoặc đạt nhờ mẫu không chạm biên.
- **Đề xuất:** M30: lập bảng từng bước tính (kiểu số, thứ tự phép, hàm làm tròn) từ mã TS rồi tái tạo đúng kiểu
  (`f64` nơi TS dùng `Number`, `Decimal` nơi TS dùng `Decimal`; `Math.round` của JS làm tròn nửa lên về phía +∞, khác
  `f64::round`). Bộ mẫu thêm ca sinh ngẫu nhiên quanh ngưỡng bậc thuế và x.5.

### I15. Phân quyền theo trường (che SĐT) không nằm trong ma trận test

- **Liên quan:** PLAN 6.2 nguồn ca test (2); C14a–f.
- **Bằng chứng:** Hình dạng response đổi theo quyền: `contacts.phone_full` quyết định SĐT đầy đủ hay bị che
  (`contacts/contacts.controller.ts`, mô tả `GET :id`); MCP luôn che (`restrictForAi`).
- **Tác động:** Ca sinh tự động chỉ có "thành công / 401-403 / 400 / ngoài phạm vi" với một người dùng ⇒ Rust trả SĐT đầy
  đủ cho Sale vẫn đạt hợp đồng.
- **Đề xuất:** Golden ghi cho ít nhất 3 vai (Quản trị, Trưởng nhóm, Sale) ở mọi route đọc có dữ liệu khách; liệt kê
  các quyền đổi hình dạng response trong `routes.json` (`shape_permissions`).

### I16. Câu trả lời lỗi do Prisma sinh và hành vi ngầm khi không tìm thấy

- **Liên quan:** PLAN 1.2 hình dạng lỗi, 10.1 rủi ro 8; K05.
- **Bằng chứng:** 36 chỗ bắt mã lỗi Prisma (`P2002`, `P2025`, `P2003`, ví dụ `commerce/src/pos/pos-layout.service.ts:9`);
  chỗ không bắt thì `update`/`delete` trên id không có ném `P2025` ⇒ 500. Bộ lọc lỗi có nhánh riêng cho lỗi trigger đa
  công ty (`packages/logger/src/elk-exception.filter.ts:97-115`).
- **Tác động:** Rust `UPDATE … WHERE id=$1` ảnh hưởng 0 dòng trả thành công, hoặc ánh xạ SQLSTATE khác ⇒ mã HTTP lệch.
- **Đề xuất:** K05 thêm bảng ánh xạ SQLSTATE ↔ mã Prisma (23505↔P2002, 23503↔P2003, "0 dòng"↔P2025) và quy tắc: hàm
  repository `update_*`/`delete_*` trả `NotFound` khi 0 dòng, tầng trên quyết định 404 hay 500 như bản TS (golden có ca).

### I17. Cache dùng chung tiến trình sau G12

- **Liên quan:** PLAN 1.12, 3.4; G12, M07, M20.
- **Bằng chứng:** Cache đếm khách TTL 60 giây (`contacts/contacts.service.ts:154-237`) bị xoá tường minh bằng `SCAN` khắp
  mọi công ty trong `sample-records/sample-records.service.ts:181-182`; cache dashboard tương tự.
- **Tác động:** Sau G12 cache nằm trong RAM từng tiến trình; ghi khách ở Node (MCP, API công khai, webhook vào chạy ở Node
  tới đợt e) không làm mới cache của Rust (đợt c) ⇒ số đếm và dashboard lệch tới 60 giây, và shadow báo khác biệt giả.
- **Đề xuất:** G12 phát `NOTIFY trinity_cache_invalidate (company, key_prefix)` cho cả hai loại cache; shadow loại các
  route có cache khỏi so số đếm trong cửa sổ TTL hoặc tắt cache khi shadow.

---

## NHỎ

| # | Phát hiện | Liên quan | Bằng chứng | Đề xuất |
|---|---|---|---|---|
| N1 | Thư viện `docx` khai trong `services/crm/package.json` nhưng **không file nào import**; hợp đồng chỉ upload/tải file Word | PLAN 1.13, 4.2 (`docx-rs`), M11 ("docx so theo văn bản") | `grep -rln "from ['\"]docx['\"]" --include='*.ts' --exclude-dir=node_modules .` rỗng; `contracts.controller.ts:67-84` chỉ là danh sách MIME | Bỏ `docx-rs`, sửa tiêu chí M11, gỡ dep `docx` ở bản TS (G-phase) |
| N2 | Đếm job trùng: `notification.scheduled` (registry) và "reaper" `@Cron('0 */2 * * * *')` gọi cùng `processScheduled()` | PLAN 0, 1.9 ("13 job, từ 15") | `notifications.service.ts:50-54`, `notifications.scheduler.ts:16-26` | Ghi là một job, chu kỳ 2 phút; sửa con số |
| N3 | Q5 sai: gói `ket_noi` không "giống gói mặc định" sau khi gỡ (`mac_dinh` có mọi tính năng theo gói); `google_sheets` còn nằm trong 4 gói khác | PLAN 2.2, Q5 | `packages/rbac/src/org-features.ts:142,175-200` | Sửa câu hỏi: ket_noi chỉ còn khác ở hạn mức kênh; nêu cả `tro_ly_*` |
| N4 | 33 chỗ định dạng theo locale (`toLocaleString`, `Intl.*`) và 21 `localeCompare`: Rust không có ICU sẵn | PLAN 10.2 Tiếng Việt; K26, M14, M21, M31 | `grep -rnE "toLocale(String|DateString|TimeString)\(|Intl\.(NumberFormat|DateTimeFormat|Collator)" services packages` (xuất xlsx, phiếu lương, ref preview) | K26 thêm hàm `format_vn_number/date` có bảng ca chung; chọn `icu_collator` hoặc chứng minh sắp ở DB |
| N5 | Giờ địa phương phụ thuộc TZ tiến trình: 23 lời gọi `getHours/setHours/getDate…`; Dockerfile không đặt `TZ`; 2 cột `timestamp` không múi giờ (`Contact.deleted_at`, `LoginWifiCheckTarget.created_at`) | PLAN 4.4, 10.2 | `attendance.service.ts:563,570`; `schema.prisma:161,215` | Ghi golden với `TZ=UTC`, xác nhận TZ của bản chạy; Rust và Prisma cùng `TimeZone=UTC` phiên DB; ca test riêng 2 cột này |
| N6 | MCP tự viết thiếu chi tiết vận chuyển: thương lượng `protocolVersion`, header `Mcp-Protocol-Version`, 406/415 theo `Accept`/`Content-Type`, mã lỗi JSON-RPC cho `resources/list`/`prompts/list`, SDK kiểm `structuredContent` theo `outputSchema`, câu lỗi zod, `.slice(0, MAX_TEXT)` đếm UTF-16 | PLAN 4.2, 4.8; M39 | `mcp-server.service.ts:132-138,194`; SDK `^1.32.0` | C03 ghi thêm golden cho các phản hồi vận chuyển này; M39 cắt theo đơn vị UTF-16 |
| N7 | `jsonwebtoken` (Rust) mặc định `leeway = 60` giây; `@nestjs/jwt`/`jsonwebtoken` Node mặc định 0 ⇒ token hết hạn vẫn dùng được thêm 1 phút ở Rust | PLAN 4.6; K11 | `auth.service.ts:518-519,891-892` (15m/7d) | Đặt `Validation::leeway = 0`; ca test token hết hạn 1 giây |
| N8 | Đường lui realtime "`NEXT_PUBLIC_REALTIME_MODE=poll`" là biến lúc build; với web nhúng phải build lại web + binary (hoặc `WEB_DIR`). Tương tự `NEXT_PUBLIC_DS_V2` | PLAN 4.10, 5 | `apps/web/src` dùng `process.env.NEXT_PUBLIC_REALTIME_MODE` | Đưa vào `GET /site-config` (đọc lúc chạy) cùng W03 |
| N9 | CORS lặp header: Rust thêm CORS cho route chuyển tiếp mà Node cũng thêm ⇒ trình duyệt từ chối `Access-Control-Allow-Origin` hai giá trị | PLAN 4.14; K16, K17 | `bootstrap-app.ts` `enableCors({ credentials: true })` | K17: không áp lớp CORS cho route thuộc Node; ca test preflight qua proxy |
| N10 | Spec pg còn import mã sắp gỡ: `saas-abuse.pg.spec.ts:26-32` (connectors, Shopee, VNPay, Store), `pg-harness.ts`; M45 lại lấy "chuyển `saas-abuse.pg.spec`" làm tiêu chí | G05–G07, M45 | `grep -lniE "shopee|vnpay|store_slug" services/crm/src/__pg__/*.ts` | Ghi rõ G05–G07 sửa hai file này; M45 tham chiếu bản đã cắt |
| N11 | Đổi sở hữu bằng "đổi env + khởi động lại": mỗi lần đổi rớt socket, request dở, cần cổng trống (không `SO_REUSEPORT`) | PLAN 4.14, 6.6; K17, K19 | | Nạp lại bảng sở hữu khi nhận `SIGHUP` hoặc đọc từ bảng `platform` mỗi 10 giây; giữ khởi động lại làm đường dự phòng |
| N12 | Lệch cấu trúc giữa công ty trong lúc migrate cuốn (boot migrate nền): statement cache của sqlx + `search_path` đổi có thể gặp `cached plan must not change result type` | PLAN 4.3, 4.5; R005 | `bootstrap-app.ts` gọi `migrateAllCompanies` nền | R005 thêm ca: hai schema khác cột, cùng câu lệnh; cấm `SELECT *`/`RETURNING *`; Rust từ chối phục vụ công ty có `migrated_to` cũ hơn bản biên dịch |
| N13 | `Rust contracts` (bắt buộc trong `ci-ok`) kiểm `.sqlx` không cũ ⇒ cần Postgres trong job bắt buộc, khó giữ ≤ 5 phút | PLAN 8; K02 | `docs/ci.md` mục tiêu ≤ 5 phút | Chuyển kiểm `.sqlx` sang job pg không bắt buộc; `ci-ok` chỉ `cargo check` với `SQLX_OFFLINE=true` |
| N14 | CI web dựa trên đầu ra `.next`: `apps/web/scripts/route-js-size.mjs` + `route-js-budget.json`, Playwright `webServer` chạy `next start` | W02, W04, W05 | `apps/web/package.json` scripts | W02 sửa ngân sách JS theo `out/`; W04 đổi `webServer` |
| N15 | Swagger `/docs` (bật khi không production hoặc `SWAGGER_ENABLED=true`) không có trong plan | PLAN 4.2 (`utoipa`), 6.1 | `apps/monolith/src/main.ts:30` | Quyết định phục vụ `/docs` từ OpenAPI của `utoipa` hay bỏ; ghi vào K27 |
| N16 | X04 lấy "tỉ lệ hoàn thành nhiệm vụ của model" làm tiêu chí: không tất định | X04, PLAN 6.4 | `tests/mcp-e2e/claude-code-roles.mjs` | Chạy ≥ 5 lần mỗi bên, so khoảng tin cậy; tiêu chí cứng chỉ là "0 lời gọi bị từ chối vì schema" |

---

## Rà các mục được yêu cầu kiểm

| Mục | Kết quả |
|---|---|
| Realtime/socket | Có (4.10, K33); thiếu cầu nối hai tiến trình (I2), đường lui poll cần build lại (N8) |
| Upload/storage | Có (4.11, K22, K23); S3 presign (`s3-driver.ts:9` dùng `getSignedUrl`) cần nêu trong K23 |
| Email/notification | Đúng: không có email; thông báo in-app/webhook (M32) |
| PDF/Excel | Có; `docx` thừa (N1); định dạng số theo locale chưa có (N4); so xlsx theo ô bỏ qua định dạng ô (chấp nhận được, nên ghi rõ) |
| i18n | Đúng: không có khung |
| Audit log | Có (1.14, M33) |
| Rate limit | Có; bị chia đôi trong lai (I3) |
| Cron/timezone | Có; đếm trùng (N2), TZ tiến trình (N5) |
| Fold-search, mã tự sinh, xoá mềm | Có (1.4, 10.2) |
| Lead scoring, báo cáo | Có (M24, M20–M21) |
| Lương/thuế decimal | Có nhưng cách tính kiểu số chưa đúng (I14) |
| Chấm công giờ, GPS/Wi-Fi/IP | Có (M13); proxy làm giả IP (I6) |
| Onboarding/setup_build/sample (PR #78) | Có (M19, 11 endpoint khớp) |
| Mời user (PR #87) | Có (M02, `invitations.pg.spec`) |
| ChannelGuard (PR #88) | Có (M45, 10.2); state RAM chia đôi (I3) |
| Platform schema + trigger | Có (1.4, K08) |
| OAuth MCP/CIMD | Có (M37); SSRF guard sai chỗ trong thứ tự (I11) |
| API key `cN.`, public API, webhook ra | Có (M05, M36, M34) |
| Extensions | Gỡ (G02) |
| Sentry/PostHog | Có (K24) |
| Tương thích JWT/refresh/bcrypt/`_prisma_migrations`/JSON | Có; leeway (N7), lỗi Prisma (I16), cột không múi giờ (N5) |
| Gỡ kết nối: menu, cờ, PLANS, MCP, docs, test, migration, PROD, webhook nhà cung cấp | Phần lớn có; thiếu xử lý tiền đang chờ (I7), thứ tự dữ liệu (I8), spec pg (N10) |
| Bảo mật: authz, tenant isolation, chữ ký webhook, CSRF/CORS, secrets | Có; thêm I6, I15, B3, N9 |
| Vận hành: CI, image, deploy, backup, cutover | Có khung; thiếu dump trước đợt (I9), ngân sách RAM lai (I13), đổi sở hữu không rớt (N11) |

## Kết luận

Plan **chưa cover đủ** để bắt đầu giai đoạn 2 và 4. Kiểm kê và số đo đáng tin (khớp mã ở mọi mục đã đếm lại). Ba chỗ
chặn đều nằm ở chiến lược kiểm chứng: (B1) bộ e2e hiện tại không chuyển sang hộp đen được nếu không có API điều khiển
test, (B2) không có chỗ cắm máy chủ giả Graph/Zalo, (B3) shadow GET sẽ ghi DB và gọi Graph trên bản thật. Cả ba sửa
được bằng 2 issue mới (API điều khiển test; base URL Graph/Zalo) và một thay đổi thiết kế K28 (danh sách route an toàn
cho shadow, giao dịch chỉ đọc, chặn HTTP ra). Sau đó cần bổ sung danh sách state/cổng phải chia sẻ trong giai đoạn lai
(I2, I3, I17), sửa các phụ thuộc ở I11, tách G07 theo I7, và đánh lại thời gian (I12) trước khi tạo 150 issue trên
GitHub.
