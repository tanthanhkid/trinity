# Kế hoạch viết lại backend Trinity bằng Rust

Trạng thái: **plan chốt (26/11/2026)**, sau phản biện lượt 1 tới 8 và quyết định của chủ dự án · Ngày: 26/11/2026 · Cơ sở đo: `origin/main` tại commit `fef6dab`.
Danh sách issue: [ISSUES.md](ISSUES.md).

Mọi con số trong tài liệu này đo trực tiếp từ mã (lệnh đo ở [Phụ lục A](#phụ-lục-a--lệnh-đo)). Chỗ nào là **đích** hoặc
**giả thuyết chưa đo** thì ghi rõ như vậy.

## 0. Tóm tắt

- **Đích:** một binary Rust (`trinity`) thay toàn bộ backend Node (NestJS monolith + Next server + Redis): phục vụ API,
  web tĩnh, job nền, webhook, MCP/OAuth, realtime. Postgres giữ nguyên schema và dữ liệu. TLS công khai do Cloudflare
  lo; binary chỉ cần TLS ở origin bằng tệp chứng chỉ (hoặc không, khi dùng Cloudflare Tunnel).
- **Phạm vi kết nối ngoài sau khi gỡ:** Facebook Fanpage (Messenger, bình luận, Lead Ads, đăng bài, Human Agent) và
  Zalo OA (tin, ZNS). Giữ thêm các cổng chung: webhook ra/vào, API công khai bằng API key. Trang bán hàng giữ, thanh
  toán chỉ còn QR VietQR tĩnh và COD. Việc gỡ làm trên bản TS trước (giai đoạn 1).
- **Khối lượng phải viết lại (sau khi gỡ):** khoảng 82.800 dòng TS backend (từ 91.215), 559 endpoint (từ 639),
  101 tool MCP tĩnh (từ 115; con số endpoint giảm thêm 2–4 khi G11 gỡ các route chỉ phục vụ Vercel Blob, chốt ở C02), 107 model (từ 117; 10 model còn lại thành bảng lưu trữ), 12 job nền (từ 14).
- **Cách chuyển:** đóng băng hợp đồng bằng *bản ghi hành vi* (OpenAPI hiện có 0 schema response) → bộ test hợp đồng
  HTTP hộp đen chạy cho cả Node và Rust (máy chủ khởi động theo hồ sơ cấu hình; API điều khiển test chỉ tồn tại ngoài
  production) → Rust đứng trước, chuyển
  tiếp phần chưa viết sang Node (strangler) → viết theo module → shadow các GET đã rà là thuần đọc → bật từng đợt bằng
  tệp sở hữu route/job, lui bằng chính tệp đó mà không mất dữ liệu → gỡ Node/Redis. Backend TS đóng băng tính năng trong lúc chuyển (chỉ sửa lỗi).
- **Quy mô:** 186 issue (37 S, 97 M, 52 L), đồ thị phụ thuộc đã kiểm bằng script (không vòng). Theo quy ước cỡ là
  219,5 ngày-agent (khoảng dưới); ước thực tế **250–300
  ngày-agent**: 24–29 tuần với 3 agent lập trình song song, 16–20 tuần với 5 (mục 11; chỉnh lại sau khi đo tốc độ thật
  ở 5 issue module đầu).
- **Ba rủi ro lớn nhất:** (1) lệch hành vi tinh vi giữa Prisma/JS và SQL/Rust (định dạng JSON, mã trạng thái, thông
  điệp lỗi, múi giờ, làm tròn tiền lương); (2) web Next không xuất tĩnh được sạch với route động; (3) trạng thái trong
  RAM bị chia đôi giữa hai tiến trình trong giai đoạn lai (phiên, cache, chuông, bộ đếm lỗi Graph, job chạy trùng).

## 1. Kiểm kê hiện trạng

### 1.1 Dòng mã và test

| Thành phần | Dòng TS (không tính test) | File test |
|---|---:|---:|
| `services/crm` | 67.099 | 210 |
| `services/payroll` | 6.549 | 20 |
| `services/auth` | 5.826 | 19 |
| `services/commerce` | 3.432 | 26 |
| `services/notification` | 1.870 | 11 |
| `apps/monolith` | 627 | 31 |
| `packages/prisma` (không tính client sinh ra) | 2.101 | 0 |
| `packages/rbac-nest` | 1.531 | 14 |
| `packages/storage` | 979 | 5 |
| `packages/logger` | 597 | 5 |
| `packages/rbac` | 462 | 5 |
| `packages/utils`, `packages/shared-types` | 142 | 0 |
| **Tổng backend** | **91.215** | |
| `apps/web` (TS/TSX, gồm test) | 111.101 | 199 vitest + 20 Playwright |

Test backend: 302 file unit spec, 15 file `*.pg.spec`/`*.db.spec` (Postgres thật), 25 file `*.e2e-spec.ts` trong
`apps/monolith/test/rbac/` với 345 ca (đếm dòng bắt đầu bằng `it(`/`test(`). Các e2e này chạy **trong tiến trình** (supertest trên Nest app, xem
`apps/monolith/test/rbac/harness.ts`), và gọi thẳng vào bên trong: 23 lời gọi `app.get(<Service>)`
(chạy job, xoá cache, đọc Redis) và 362 lời gọi `prisma.<model>` để seed và sửa DB. Ngoài ra 42 chỗ trong 7 file gán hoặc xoá `process.env.*` giữa các ca
(`webhooks-out` 14, `webhooks-in` 7, `mcp` 6, `oauth` 6, `integrations` 4, `extensions` 3, `ai-actions` 2), kể cả đặt
tạm `NODE_ENV = 'production'`; mã Node đọc các biến này mỗi lần gọi nên đổi được, máy chủ hộp đen thì không. Hai file
gọi hàm với giờ cố định (`reapStuckProcessing(NOW)`, `collect(…, NOW)`). Chuyển sang hộp đen vì vậy cần hồ sơ cấu hình,
API điều khiển test và seed bằng SQL với thời gian tương đối, không chỉ thay lớp vận chuyển (mục 6.2).

Kích thước cần chuyển khác của mã: 254 lớp DTO, 2.036 decorator class-validator (414 cái có `message` riêng),
1.927 lời gọi model Prisma, 97 `$queryRaw` + 86 `$executeRaw`, 121 `$transaction`, 1.052 chỗ `throw new …Exception`.

### 1.2 Module và endpoint

Đếm decorator `@Get/@Post/@Put/@Patch/@Delete` trong `services/*/src`: **639** (293 GET, 193 POST, 70 PATCH, 63 DELETE,
20 PUT) trên 96 controller. Tiền tố chung `api/v1` (`apps/monolith/src/bootstrap-app.ts`).

| Service | Module (thư mục `src/`) | Endpoint | Dòng |
|---|---|---:|---:|
| auth | auth (14) + invitations (6) + login-wifi-check-targets (3) | 23 | 2.416 |
| auth | users (10) + pinned-menu (2) | 12 | 1.741 |
| auth | rbac-admin: roles (8), rbac audit (1), catalog (1), user-roles (1) | 11 | 896 |
| auth | api-keys | 5 | 496 |
| auth | teams (2), public-api (1), health (3) | 6 | 212 |
| crm | integrations: webhooks (10), inbound sources (6), hooks/in (1), oauth (5), consent (2), ai-connections (2), ai-actions (7), mcp (3), integrations (2), cron tick (1) | 39 | 13.397 |
| crm | attendance | 40 | 6.238 |
| crm | social (49 + 2 public) | 51 | 5.507 |
| crm | custom-objects (17) + records (8) + refs (4) | 29 | 4.485 |
| crm | facebook (36 + 4 public) | 40 | 3.886 |
| crm | connectors (41, trong đó 14 public) | 41 | 3.588 |
| crm | kanban: boards (10), cards (9), checklist (5), columns (4), field-defs (4), attachments (3) | 35 | 3.455 |
| crm | contacts | 14 | 3.138 |
| crm | reports (8 controller) | 19 | 3.032 |
| crm | employees | 12 | 2.706 |
| crm | extensions | 10 | 1.895 |
| crm | contracts | 13 | 1.508 |
| crm | google | 12 | 1.414 |
| crm | zalo-oa | 11 | 1.098 |
| crm | newsfeed | 13 | 996 |
| crm | recruitment | 10 | 900 |
| crm | briefings | 6 | 881 |
| crm | public-api (contacts 2, deals/work 3) | 5 | 783 |
| crm | teams | 9 | 652 |
| crm | lead-scoring | 4 | 644 |
| crm | settings (4) + org-features (2) | 6 | 581 |
| crm | channel-guard | 2 | 578 |
| crm | setup | 5 | 532 |
| crm | deals | 6 | 512 |
| crm | job-titles | 5 | 452 |
| crm | settings-options | 4 | 419 |
| crm | store | 7 | 399 |
| crm | stale-work | 4 | 379 |
| crm | onboarding (wizard 5, setup build 1) | 6 | 369 |
| crm | interactions | 3 | 269 |
| crm | activities (1), usage (2), telemetry (2), health (3) | 8 | 483 |
| crm | không có route: common, notifications, sample-records, storage, audit, messaging | 0 | 1.384 |
| commerce | pos (4 controller) | 25 | 1.160 |
| commerce | products (8) + categories (6) + attribute-defs (2) | 16 | 1.796 |
| commerce | projects (5), health (3) | 8 | 260 |
| payroll | payslips | 17 | 3.509 |
| payroll | kpi (5), tax (6), salary-rules (4), salary-components (4), insurance (4), employees (4), reports (3), health (3) | 33 | 2.939 |
| notification | notifications (4), templates (5), events (2), health (3), websocket (0) | 14 | 1.813 |

Ghi chú hành vi phải giữ:

- **Mỗi route phải khai quyền.** `@Can`, `@CanAny`, `@AuthOnly`, `@Public`, `@Internal`
  (`packages/rbac-nest/src/decorators.ts`); monolith từ chối khởi động nếu có route chưa khai
  (`route-audit.ts`, `apps/monolith/src/main.ts`).
- **Validation hai chế độ** (`apps/monolith/src/service-aware-validation.pipe.ts`): 12 tiền tố "lenient"
  (`/auth`, `/public/auth`, `/api-keys`, `/users`, `/roles`, `/teams`, `/employees`, `/kpi`, `/payslips`,
  `/salary-rules`, `/notifications`, `/templates`) chỉ bỏ trường lạ; mọi route khác **từ chối** trường lạ
  (`forbidNonWhitelisted`).
- **Hình dạng lỗi** (`packages/logger/src/elk-exception.filter.ts`): `{ statusCode, message, error, errors? }`; lỗi 5xx
  luôn trả `error: "Internal Server Error"`. Web chỉ hiện câu của máy chủ khi câu đó là tiếng Việt
  (`apps/web/src/lib/error-messages.ts`, `serverSentence`).
- **Hành vi khai ở decorator ngoài quyền** (đếm trong `services`): 47 `@RequireOrgFeature` (cổng tính năng, 403 có
  câu riêng), 119 `@HttpCode` (POST không có `@HttpCode` trả **201** theo mặc định của Nest; axum mặc định 200),
  53 handler dùng `@Res` (trả tay, bỏ qua interceptor), 262 `ParseIntPipe` (lỗi tham số đường dẫn có câu riêng),
  38 `@Transform` và 117 `@Type` trên DTO, guard riêng (`ApiKeyGuard`, `PublicApiRateLimiterGuard`, `PlanTokenGuard`),
  interceptor riêng (`webhook-kick.interceptor.ts`). Tất cả phải nằm trong hợp đồng route (mục 6.1).
- **Lỗi do Prisma sinh:** 36 chỗ bắt mã `P2002`/`P2025`/`P2003`; chỗ không bắt thì cập nhật/xoá id không tồn tại
  thành 500. Rust phải tái tạo từng trường hợp (mục 4.4).
- **Body:** JSON và urlencoded tối đa 5 MB, giữ `rawBody` để kiểm chữ ký webhook; `BigInt` trả về dạng số
  (`BigInt.prototype.toJSON`); upload video tới 200 MB (`docs/deployment.md`).

### 1.3 Model Prisma theo module

`packages/prisma/prisma/schema.prisma`: 2.762 dòng, **117 model**, 1 enum (`NewsfeedMediaType`). 21 migration
(`0000_init` … `0020_channel_guard`), 2.967 dòng SQL.

| Nhóm | Số model | Model |
|---|---:|---|
| Auth / RBAC | 10 | User, Role, UserRole, RolePermission, RbacAuditLog, Team, LoginWifiCheckTarget, RevokedSession, UserInvitation, ApiKey |
| CRM lõi | 9 | Contact, ContactRecentView, Activity, Deal, Setting, SettingOption, LeadAiIntent, AuditLog, Briefing |
| Nhân sự | 7 | JobTitle, Employee, EmployeeContract, EmploymentPeriod, ContractTemplate, RecruitmentCandidate, RecruitmentPosition |
| Chấm công | 4 | AttendanceOffice, AttendanceQrSession, AttendanceRecord, AttendanceRequest |
| Lương | 9 | SalaryRule, SalaryRuleDetail, SalaryComponent, InsuranceSetting, TaxBracket, PayrollTaxSetting, KpiConfig, KpiResult, Payslip |
| Bán hàng | 12 | Project, Product, ProductCategory, ProductAttributeDef, PosSettings, PosArea, PosTable, PosModifier, PosShift, PosOrder, PosOrderItem, PosPayment |
| Kanban | 8 | KanbanBoard, KanbanColumn, KanbanFieldDef, KanbanCard, KanbanCardAssignee, KanbanChecklistItem, KanbanCardAttachment, KanbanCardActivity |
| Bảng tuỳ biến | 6 | CustomObject, CustomField, CustomRecord, CustomView, RecordLink, CustomSchemaVersion |
| Bảng tin | 4 | NewsfeedPost, NewsfeedPostImage, NewsfeedPostLike, NewsfeedPostComment |
| Thông báo | 2 | NotificationTemplate, NotificationLog |
| Tích hợp lõi | 10 | IntegrationAuditLog, IntegrationEvent, WebhookEndpoint, WebhookDelivery, WebhookInboundSource, WebhookInboundReceipt, OauthClient, OauthAuthorizationCode, OauthToken, AiActionDraft |
| Facebook | 11 | FacebookPage, FacebookConversation, FacebookMessage, FacebookComment, FacebookCommentRule, FacebookLeadReceipt, FacebookChatLink, FacebookFlow, FacebookFlowRun, FacebookBroadcast, FacebookBroadcastRecipient |
| Zalo OA | 4 | ZaloOaConnection, ZaloOaOauthState, ZaloOaThread, ZaloOaMessage |
| Đăng bài | 8 | SocialAccount, SocialPost, SocialPostTarget, SocialDraft, SocialRecurrence, SocialQueueSlot, SocialSnippet, SocialMediaAsset |
| Chống lạm dụng kênh | 2 | ChannelUsage, ChannelEvent |
| Trang bán hàng | 1 | StoreOrder |
| **Sẽ gỡ (thành bảng lưu trữ)** | 10 | GoogleConnection, GoogleSheetSync, GoogleSheetSyncRun, Extension, ExtensionVersion, ExtensionRun, ConnectorAccount, ConnectorEvent, ConnectorRecord, PaymentIntent |

Đặc điểm kiểu dữ liệu ảnh hưởng tới tương thích JSON: 61 trường `@updatedAt` (Prisma đặt ở **client**, không phải DB:
Rust phải tự gán `updated_at`), 62 trường `BigInt`, 12 `Decimal`, 56 `Json`, 272 `Timestamptz(3)`, 10 `@db.Date`,
97 trường mảng, 28 quan hệ `onDelete: Cascade`, 80 `@relation` (nhiều liên kết là soft-FK có chủ đích, xem chú thích
trong schema).

### 1.4 SQL thô, trigger, sequence

- `0000_init/migration.sql`: 7 hàm (`trinity_core_code`, `trinity_code_num`, `trinity_pick_code_prefix`,
  `trinity_code_prefix_taken`, `trinity_reserved_code_prefixes`, `trinity_custom_objects_code_prefix`,
  `trinity_custom_records_code`), 5 trigger `BEFORE INSERT` (contacts, deals, kanban_cards, custom_objects,
  custom_records), 3 sequence (`contacts_code_seq`, `deals_code_seq`, `kanban_cards_code_seq`), 10 partial index
  (`CREATE … INDEX … WHERE`). Mã tự sinh (KH-0001…) do **trigger DB** tạo, nên Rust chỉ cần `INSERT … RETURNING`.
- Không dùng extension Postgres nào (`CREATE EXTENSION` = 0). Tìm tiếng Việt bỏ dấu dùng `translate(lower(x), …)` trong
  SQL (`services/crm/src/common/helpers/fold-search.helper.ts`, `custom-objects/refs/fold-vi.ts`), không dùng `unaccent`.
- Schema `platform` tạo ngoài migration (`packages/prisma/src/tenant/platform.ts`): 3 bảng (`companies`,
  `company_logins`, `company_routes`), 3 hàm trigger cài vào **mỗi** schema công ty
  (`trinity_platform_sync_login`, `…_facebook_page`, `…_zalo_oa`), phiên bản `trinity-sync-v3`; advisory lock
  `726354001` (boot) và `726354002` (đăng ký theo email).
- Advisory lock / `FOR UPDATE` / `SKIP LOCKED` có ở 30 file (đăng bài, webhook delivery, chấm công, bản ghi tuỳ biến,
  POS, hạn mức gói…). Danh sách: lệnh ở Phụ lục A.

### 1.5 Đa công ty (schema-per-company)

Nguồn: `docs/multi-tenant.md`, `packages/prisma/src/tenant/{context,clients,platform,provision}.ts`,
`packages/rbac-nest/src/{jwt-auth.guard,company-token,tenant-resolve,cron-registry}.ts`.

| Việc | Cách hiện tại |
|---|---|
| Schema | Công ty 1 = `public`; công ty N = `c_N`. Bảng, SQL thô, trigger, sequence đều theo công ty |
| Định tuyến truy vấn | `PrismaService` là proxy; công ty lấy từ `AsyncLocalStorage`; không có công ty ⇒ ném `MissingCompanyContextError` (fail-closed) |
| Kết nối | Một `PrismaClient` mỗi schema (`?schema=c_N`), LRU `TENANT_MAX_CLIENTS` = 30, mỗi client `TENANT_CONNECTION_LIMIT` = 2, cộng pool chính 5. Từ chối URL pooler transaction-mode |
| Request đã đăng nhập | JWT mang `cid`; thiếu `cid` = công ty 1 |
| Đăng nhập | `platform.company_logins` (email → công ty) |
| API key, mã/token OAuth MCP, token lời mời | Tiền tố `cN.`; không tiền tố = công ty 1 |
| Webhook Facebook / Zalo | `platform.company_routes` theo Page id / OA id |
| Callback OAuth | `state` ghi vào `company_routes` (`oauth_state`), hết hạn sau 1 ngày |
| Link công khai | `?cid=N` hoặc header `x-trinity-company`; không có thì công ty 1 (fallback) |
| Job nền | `runForEachCompany` với `budgetMs` và con trỏ tiếp tục theo từng job |
| State ngoài DB | Khoá theo công ty bằng `tenantKey()` (`c<id>:<key>`, công ty 1 giữ khoá cũ) |
| Migration | `prisma migrate deploy` chạy bằng tiến trình con cho từng schema, 4 schema một lúc; `platform.companies.migrated_to` ghi bản mới nhất |
| Khoá kênh | `platform.companies.channels_locked` (+ lý do, giờ), cache 10 giây; CLI `channel:lock` |

### 1.6 Auth, phiên, mật khẩu

- JWT HS256 ký bằng `JWT_SECRET` (`@nestjs/jwt` mặc định). Access token 15 phút, payload `{ sub, email, sid?, cid? }`;
  refresh token 7 ngày, `type: 'refresh'`, có id phiên; thu hồi lưu bảng `revoked_sessions`
  (`services/auth/src/auth/auth.service.ts`).
- Mật khẩu: `bcryptjs`, cost 10.
- Trong RAM: `TokenBlacklistService` (15 phút), `ActiveSessionService` (một phiên một người khi
  `SINGLE_SESSION_ENABLED`), `RbacCache` (TTL 60 giây).
- Web giữ access/refresh token trong `localStorage` và gửi qua header `Authorization`; cookie `access_token` (không
  HttpOnly, `SameSite=Lax`, 15 phút) và `has_session` chỉ để chặn điều hướng (`apps/web/src/lib/token-storage.ts`,
  `apps/web/src/proxy.ts`).
- `@Internal`: header `x-service-secret` so với `INTERNAL_SERVICE_SECRET` / `SERVICE_SECRET`.
- API key: lưu SHA-256 + tiền tố (`services/crm/src/public-api/api-key.guard.ts`).

### 1.7 RBAC

- Catalog 64 quyền, 21 tiền tố nhóm (`packages/rbac/src/catalog.ts`); phạm vi `own | team | subtree | all`
  (`grants.ts`); `ScopeService` theo cây quản lý (`packages/rbac-nest/src/scope.service.ts`, `scope-where.ts`).
- 22 công tắc tính năng trong 5 nhóm, 6 gói (`packages/rbac/src/org-features.ts`); hạn mức người dùng theo gói
  (`plan-limits.ts`); mẫu ngành (`industry-presets.ts`).
- `packages/rbac` được **web import trực tiếp** (`@trinity/rbac`), nên catalog phải có một nguồn dùng chung cho cả web
  (TS) và Rust.

### 1.8 MCP và OAuth

- MCP: `POST /api/v1/mcp`, streamable HTTP ở chế độ **không phiên, trả JSON** (`enableJsonResponse: true`,
  `sessionIdGenerator: undefined`), không nhận batch; `GET`/`DELETE` trả 405
  (`services/crm/src/integrations/mcp/mcp.controller.ts`, `mcp-server.service.ts`). Kiểm `Origin` theo danh sách cho
  phép; ba giới hạn: 240 request/phút/người, 60 lời gọi tool/phút/người, 30 lần xác thực sai/phút/IP.
- **115 tool tĩnh** (đếm `name: '…'` trong `mcp/tools/*.ts` và `mcp/actions/*.ts`), cộng tool động của chương trình con.
  Con số "khoảng 131" từng được nêu không khớp phép đếm này; con số chính thức sẽ là kết quả `tools/list` đóng băng ở
  issue C03.

  | Nhóm | Số tool |
  |---|---:|
  | Lõi (search, fetch, contacts, deals, dashboard, tasks, options, report, schema, records, code, templates, screen types, AI activity, setup, features, channels, interactions, briefing, leads, trạng thái thao tác) | 31 |
  | Ghi qua khung "action" (contact, task, record, field, object, view, menu, template, version, workspace, import, link) | 23 |
  | Đăng bài (17 đọc/ghi trực tiếp + 9 action) | 26 |
  | Fanpage: bình luận 5, chat link 2, kịch bản 3, gửi hàng loạt 3, huỷ 2 | 15 |
  | Hộp thư 4, lời mời 3 | 7 |
  | Chương trình con 8, Google review 2, thanh toán 2, đơn bán hàng 1 | 13 → gỡ; cộng `list_youtube_playlists` trong nhóm đăng bài là 14 (mục 2) |

- Tool ghi chạy ngay theo quyền người dùng, hoặc tạo `ai_action_drafts` khi bật "Yêu cầu duyệt thay đổi do AI";
  mọi lời gọi ghi `integration_audit_logs`.
- OAuth 2.1: metadata, DCR (`kind='dcr'`), CIMD (`kind='cimd'`), PKCE S256, mã 60 giây, access 1 giờ, refresh 30 ngày,
  consent ký HMAC dẫn xuất từ `JWT_SECRET` (`integrations/oauth/*`, 1.348 dòng).
- Bí mật lưu DB mã hoá AES-256-GCM, định dạng `v1.<iv>.<tag>.<ct>` base64url, AAD `trinity-webhook-secret/v1`, khoá
  `INTEGRATIONS_SECRET_KEY` (`integrations/webhooks/secret-crypto.ts`).

### 1.9 Job nền

13 job đăng ký `cronRegistry` (`packages/rbac-nest/src/cron-registry.ts`), cộng vòng lặp của chương trình con: 14 job.
Mỗi job chạy theo từng công ty. `notification.scheduled` có hai đường kích hoạt cho cùng hàm `processScheduled()`:
`@Cron` 2 phút ở server thường và registry cho serverless; tính là **một** job.

| Job | Chu kỳ | Budget | File |
|---|---|---|---|
| `integrations.webhook-dispatch` | 10 giây | 30 s | `integrations/webhooks/webhook-dispatcher.service.ts` (Rust: `trinity-integrations::webhooks::dispatcher`, M34) |
| `facebook.flows` | 60 giây | 30 s | `facebook/facebook-flows.job.ts` |
| `facebook.broadcasts` | 60 giây | 30 s | `facebook/facebook-broadcasts.job.ts` |
| `social.publish` | 60 giây | 40 s | `social/social-publish.job.ts` |
| `social.metrics` | 15 phút | 25 s | `social/social-publish.job.ts` |
| `briefings.run-due` | 60 giây | 40 s | `briefings/briefings.scheduler.ts` |
| `google.sheet-sync` (gỡ) | 60 giây | 35 s | `google/google-sync.scheduler.ts` |
| `lead-scoring.run` | 10 phút | 25 s | `lead-scoring/lead-scoring.job.ts` |
| `stale-work.digest` | 15 phút | 25 s | `stale-work/stale-work.job.ts` |
| `integrations.ai-action-expiry` | 10 phút | 20 s | `integrations/mcp/actions/ai-action-expiry.service.ts` |
| `integrations.outbox-purge` | 6 giờ | 20 s | `integrations/integration-outbox-purge.service.ts` |
| `integrations.oauth-purge` | 6 giờ | 20 s | `integrations/oauth/oauth-purge.service.ts` |
| `notification.scheduled` | 2 phút (`@Cron('0 */2 * * * *')`) | 30 s | `services/notification/src/notifications/notifications.{service,scheduler}.ts` |
| Vòng lặp chương trình con (gỡ) | 30 giây | | `extensions/extensions.runtime.ts` |

Ba job tắt mặc định bằng env: `LEAD_SCORING_ENABLED`, `STALE_REMINDERS_ENABLED`, `BRIEFING_CRON_ENABLED`.

Ghi chú M23 (`mod-briefings`, bản Rust của `briefings.run-due`): job chỉ đăng ký khi `BRIEFING_CRON_ENABLED=true` và không ở chế độ API điều khiển test; một lượt giữ tối đa MỘT kết nối pool (đọc và dựng nội dung xong mới ghi), mỗi người nhận ghi bản tin, thông báo trong app và danh sách kênh trong MỘT giao dịch; trần 500 người nhận mỗi lượt, người đã nhận bị loại trước khi cắt trần; slot hẹn gần nửa đêm chạy trễ qua 00:00 (trong 4 giờ bù) mang NGÀY của slot (khoá `(user, slot, ngày)` và khung số liệu thuộc ngày đó); bảng "nổi bật" chỉ gồm người bán trong phạm vi quyền. Phần RBAC (người nhận, phạm vi `reports.overview`, cờ `ai_briefing`) đi qua trait `Ports` cho tới khi `trinity-rbac` có.
Có 6 chỗ gọi "bắn rồi quên" (`void this.…`) và 25 `setTimeout` cần rà khi chuyển.
Giờ địa phương: 23 lời gọi `getHours/setHours/getDate…` phụ thuộc múi giờ của tiến trình; `Dockerfile` không đặt `TZ`.

**Webhook ra ở Rust (M34).** Cùng một job `integrations.webhook-dispatch` (tên khớp `KNOWN_JOBS` và tệp sở hữu), 10 giây một lượt, budget 30 s:
outbox → delivery → nhận việc → gửi. Hàng đợi vẫn là chính bảng `webhook_deliveries` (nhận bằng `FOR UPDATE SKIP LOCKED`, lease 120 s,
trần 7 lần gửi), không phải `platform.jobs` (K21): bản Node đọc bảng này suốt giai đoạn lai nên hai bên phải chia một hàng đợi. Worker
thả kết nối DB trước khi chờ HTTP (hạn 10 s), chỉ lấy lại để ghi nhật ký và kết quả; còn dưới 11 s của budget thì không nhận thêm việc và
trả lại việc đã nhận mà chưa kịp gửi (`attempts` về như cũ). Tắt endpoint commit trước, thông báo cho người tạo ở giao dịch riêng: lỗi
thông báo không làm mất việc tắt.

### 1.10 Webhook vào

| Đường | Xác thực | Định tuyến công ty |
|---|---|---|
| `GET/POST /facebook/webhook` | `X-Hub-Signature-256` = HMAC-SHA256(app secret, raw body); `hub.verify_token` | Page id → `company_routes`; chuyển tiếp nguyên body + chữ ký sang bản cài khác nếu đặt `FACEBOOK_WEBHOOK_FORWARD_URL` |
| `POST /zalo-oa/webhook` | `X-ZEvent-Signature` = SHA-256(appId + raw body + timestamp + secret) | OA id → `company_routes` |
| `POST /hooks/in/:token` | Token bí mật theo nguồn, tuỳ chọn chữ ký `t=…,v1=…` | Tiền tố `cN.` của token |
| `GET /facebook/oauth/callback`, `GET /zalo-oa/oauth/callback`, `GET /social/oauth/callback/:network` | `state` | `oauth_state` |
| `GET /facebook/go/:code` | Mã link | `?cid=` |

| 14 đường public của `connectors`, 1 của `google` | Theo từng nhà cung cấp | Gỡ (mục 2) |
| 3 đường public của `store` | Không (giới hạn tốc độ theo IP) | Địa chỉ cửa hàng → `company_routes` (`store_slug`) hoặc `?cid=` |

Một số GET **có ghi hoặc gọi ra ngoài**: `GET /facebook/conversations/:id/messages` (lấy tin từ Graph, đặt
`unread_count = 0`), `GET /zalo-oa/threads/:id/messages` (đánh dấu đã đọc), `GET /facebook/go/:code` (tăng lượt mở),
ba callback OAuth (đổi `code` lấy token). Vì vậy "GET" không đồng nghĩa "an toàn để chạy lại" (mục 4.14).

### 1.11 Lời gọi ra ngoài

16 file có lời gọi HTTP ra ngoài. Giữ: `facebook/graph-client.ts` (Graph API, mặc định `v25.0`),
`facebook/facebook-webhook.service.ts` (chuyển tiếp), `social/providers/facebook.provider.ts`,
`social/facebook-first-comment.ts`, `zalo-oa/zalo-oa-api.client.ts`, webhook ra do người dùng cấu hình
(`integrations/webhooks/webhook-http-client.ts`, có `ssrf-guard.ts`), kênh webhook của thông báo
(`notification/.../safe-webhook-target.ts`), `integrations/common/safe-http-get.ts` (tải media/CIMD),
`packages/logger/src/product-events.ts` (PostHog, tắt mặc định) và Sentry.
Gỡ: `google/*`, `social/providers/{youtube,tiktok,google-business,instagram}.provider.ts`, `connectors/*`,
`extensions/runner/*`, `services/crm/ext-deno/*`.

### 1.12 State ngoài DB

| Loại | Chi tiết | Nguồn |
|---|---|---|
| Redis: cache đếm | `crm:contacts:count:*` (TTL) | `contacts/contacts.service.ts`, `sample-records/sample-records.service.ts` |
| Redis: cache dashboard | stats hôm nay, trend, overview (TTL) | `reports/dashboard-{stats-today,trend,overview}.service.ts` |
| Redis: rate limit MCP | `mcp:rl:*` (`INCR` + `EXPIRE 70`) | `integrations/mcp/mcp-rate-limiter.ts` |
| Redis: pub/sub | kênh `rbac:invalidate` | `packages/rbac-nest/src/rbac-cache.ts` |
| RAM | cache quyền, blacklist token, phiên đang hoạt động, cache công ty 30 giây, cache khoá kênh 10 giây, con trỏ job, các `FixedWindowLimiter` (MCP, OAuth, API công khai, webhook vào, trang bán hàng, đăng nhập), cửa sổ lỗi Graph 60 phút của `channel-guard/graph-observer.ts` | |
| Socket | Socket.IO, path `/notif-ws`, namespace `/notifications/ws`; room `user_<id>` hoặc `c<cid>:user_<id>`; sự kiện `notification:new`, `notification:count`; xác thực bằng JWT trong `handshake.auth.token` | `services/notification/src/websocket/notifications.gateway.ts` |
| File | `STORAGE_LOCAL_ROOT` (tài liệu, theo `storage_key`), thư mục `uploads/` phục vụ ở `/uploads` (avatar, ảnh sản phẩm, bảng tin), `EMPLOYEE_AVATAR_DIR`; driver S3/MinIO và Vercel Blob | `packages/storage/src/*` |

Redis **đã là tuỳ chọn** ở một phần mã: `RbacCache` chạy chỉ bằng RAM khi thiếu `REDIS_URL`; `MemoryRedis`
(`packages/rbac-nest/src/memory-redis.ts`) thay Redis khi chạy serverless. Bỏ Redis vì vậy là việc nhỏ.

### 1.13 Upload, tài liệu, ảnh

- Upload multipart ở 7 controller (avatar, sản phẩm, chấm công, hợp đồng, bảng tin, đăng bài, phiếu lương).
- Trả file / `Content-Disposition` ở 12 controller.
- Thư viện phải có tương đương (17 file dùng): `exceljs` (xuất/nhập xlsx), `pdfkit` (phiếu lương, font
  `services/payroll/src/assets/fonts/Tinos-{Regular,Bold}.ttf`), `sharp` (3 chỗ: avatar, ảnh nhân viên, bảng tin),
  `handlebars` (mẫu thông báo, không có helper tự đăng ký). Gói `docx` (không file nào import) đã gỡ
  khỏi crm và monolith ở G10; hợp đồng chỉ tải lên/tải xuống tệp Word. Không cần tương đương.
- Bộ tính công thức của bảng tuỳ biến: `custom-objects/formula/formula-parser.ts` (310 dòng: phân tích, thẩm định kiểu,
  tính giá trị; `round` dựa trên `Math.round` và `Number.EPSILON`, ngày theo UTC+7, câu lỗi tiếng Việt trả 400). Giá trị
  được tính mỗi lần trả bản ghi và khi xuất tệp; spec hiện chỉ 11 ca.
- Xuất CSV/xlsx có chống chèn công thức (`custom-objects/csv-format.ts`).
- Định dạng theo locale: 33 chỗ `toLocale*`/`Intl.*` (xuất xlsx, phiếu lương, xem trước liên kết) và 21 `localeCompare`.

### 1.14 Thông báo, email, i18n, audit, rate limit

- Thông báo: kênh in-app, webhook, push (FCM chưa tích hợp, luôn trả "bỏ qua"). **Không có email**
  (`docs/multi-tenant.md`: lời mời là link tự gửi).
- i18n: không có khung i18n. Giao diện và câu lỗi máy chủ là tiếng Việt viết thẳng trong mã; mô tả tool MCP song ngữ.
- Audit: `audit_logs`, `rbac_audit_log`, `integration_audit_logs`, cộng `kanban_card_activities` và
  `ai_action_drafts`.
- Rate limit: toàn bộ là cửa sổ cố định trong RAM, riêng MCP dùng Redis (rơi về RAM).

### 1.15 Web

`apps/web`: Next 16.3.8, React 19.2.4, `output: "standalone"`. 40 `page.tsx` (8 trang có đoạn động), 3 `layout.tsx`,
4 route handler, 1 middleware (`src/proxy.ts`). Chi tiết và việc phải sửa ở mục 5.

### 1.16 Triển khai hiện tại

- Docker: hai image `trinity-api`, `trinity-web` + Postgres 16 + Redis 7 (`docker-compose.yml`, `Dockerfile`).
- **Vercel serverless** là "Option 1" trong README: NestJS chạy trong function của Next
  (`apps/web/src/lib/nest-bridge.ts`, `scripts/vercel/*`, `TRINITY_RUNTIME=serverless`, `/internal/cron/tick`).
  Một binary Rust không chạy được theo đường này; chủ dự án đã quyết bỏ hẳn (issue G11).
- CI: `docs/ci.md`. `ci-ok` = Lint + Typecheck + Unit + gitleaks.

## 2. Gỡ kết nối ngoài (làm trên bản TS trước)

### 2.1 Giữ và gỡ

| Giữ | Ghi chú |
|---|---|
| Facebook Fanpage: Messenger (nhận, trả lời, 24 giờ và thẻ `HUMAN_AGENT`), bình luận và luật tự động, Lead Ads, chat link + QR, kịch bản nhắn, gửi hàng loạt, đăng bài Fanpage + bình luận đầu + số liệu | `facebook/*`, `social/providers/facebook.provider.ts`, `social/facebook-first-comment.ts` |
| Zalo OA: kết nối OAuth, tin tư vấn, ZNS, webhook, ghép khách | `zalo-oa/*` |
| Khung đăng bài (nháp, hàng đợi khung giờ, mẫu chữ, bài lặp, CSV, thư viện media) chỉ còn mạng `facebook` | `social/*` trừ 4 provider |
| Webhook ra, nguồn webhook vào, API công khai bằng API key, thư mục mẫu `integrations/n8n` | Đã quyết giữ (nền cho n8n/Zapier/Make) |
| **Trang bán hàng** (`store/*`, 7 endpoint, `/s/<tên>`, subdomain `STORE_DOMAIN`, công tắc `online_store`, sự kiện `store_order.created`, model `StoreOrder`) | Đã quyết giữ, **viết lại phần thanh toán**: QR VietQR tĩnh + COD, không cổng thanh toán, không tự khớp tiền (xem dưới) |
| MCP + OAuth MCP; chống lạm dụng kênh; Sentry/PostHog (tắt mặc định); driver lưu trữ S3 | |

| Gỡ | Endpoint | Tool MCP | Model thành lưu trữ | Công tắc tính năng | Job |
|---|---:|---|---|---|---|
| Chương trình con (extensions + Deno) | 10 | 8 tĩnh + tool động | Extension, ExtensionVersion, ExtensionRun | (env `EXTENSIONS_ENABLED`); 3 quyền `extensions.*` | vòng lặp 30 giây |
| Google Sheets + OAuth Google | 12 | 0 | GoogleConnection, GoogleSheetSync, GoogleSheetSyncRun | `google_sheets` (cũng là tính năng theo gói) | `google.sheet-sync` |
| YouTube, TikTok, Google Business Profile (bài + đánh giá), Instagram | 4 | `list_youtube_playlists`, `list_google_reviews`, `reply_to_google_review` | (dòng trong `social_accounts`, `social_post_targets`) | | |
| Shopee, Lazada, KiotViet, Sapo, WooCommerce, MISA (iPOS chưa có mã); gồm 4 đường chung của `connectors` | 27 | `list_sales_orders` | ConnectorAccount, ConnectorEvent, ConnectorRecord | `commerce_connectors` | |
| SePay, VNPay, MoMo (đối soát yêu cầu cũ / tự khớp tiền về) | 14 | `list_payment_requests` (`create_payment_request` gỡ ở G07a) | PaymentIntent | `payments` | |
| Đường Vercel serverless | 1 (`internal/cron/tick`), cộng 2–4 route chỉ phục vụ Vercel Blob (`social/media/upload-token`, `social/media/register`, token video bảng tin; hiện luôn trả 400 khi không có Blob), chốt số ở C02 | | | | |
| **Tổng** | **68** | **14** | **10** | **3** | **2** |

Sau khi gỡ: 571 endpoint; gộp 5 bộ health trùng đường dẫn thành một, phần Rust phải có là **559** endpoint. Tool MCP
tĩnh còn **101**. Mã backend giảm khoảng 8.400 dòng (connectors 3.588, extensions 1.815 + `ext-deno`, google 1.286 sau
khi tách helper số điện thoại, 4 provider 1.083, 6 file tool MCP 637).

**Trang bán hàng sau khi sửa (G05, đã làm).** Trước G05 `store.service.ts` import ba service của `connectors` và chuyển
khoản cần kết nối SePay. Sau G05 (`store/vietqr.ts` sinh chuỗi, bảng ánh xạ tên ngân hàng → BIN dùng chung cho migration
`0022_store_vietqr`; ghép khách qua `PublicApiService`; sự kiện `store_order.created` phát lúc tạo đơn cho cả hai cách):

- Cấu hình cửa hàng (`settings.online_store`, JSON) thêm mã ngân hàng, số tài khoản, tên chủ tài khoản.
- Máy chủ sinh **chuỗi VietQR** theo chuẩn EMVCo (có số tiền và nội dung = mã đơn, CRC16) bằng một hàm thuần;
  trình duyệt vẽ QR (web đã vẽ QR ở chat link và POS). Không gọi dịch vụ nào bên ngoài.
- Không tự khớp tiền: đơn chuyển khoản ở trạng thái chờ cho tới khi nhân viên xác nhận bằng `PATCH store/orders/:id`
  (đường đã có).
- Migration dữ liệu: cửa hàng đang bật chuyển khoản thì chép thông tin tài khoản từ cấu hình SePay cũ nếu đọc được;
  không đọc được thì tắt chuyển khoản (COD vẫn chạy) và hiện nhắc chủ cửa hàng nhập tài khoản.
- Đơn chuyển khoản cũ đang chờ theo luồng SePay: giữ nguyên dòng, nhân viên xác nhận tay.

### 2.2 Ảnh hưởng ngoài mã backend

- **Phụ thuộc đã tách (G01):** `normalizePhone`, `phoneVariants` nằm ở `common/helpers/phone.helper.ts` — bộ chuẩn hoá SĐT
  duy nhất (`normalizeVnPhone` của webhook vào uỷ quyền cho nó; các bản `phoneVariants` cục bộ ở Fanpage, webhook vào,
  nhập Sheet, Zalo OA đã bỏ); `google/` không còn bị `contacts`, `public-api`, `connectors`, tool MCP import. Bản Rust
  port đúng một hàm này (luật: `+84`, `84`, `0084`, `+84 (0)`; 9 số không mã nước chỉ nhận đầu di động 3/5/7/8/9).
- **Web:** số file nhắc tới từng thứ (đếm `grep -l`): YouTube 25, payments 20, TikTok 19, SePay 16, extensions 16,
  Google Sheets 10, KiotViet 8, Google Business 7, Shopee/Lazada/Sapo/WooCommerce/MISA/VNPay/Instagram 6 mỗi thứ,
  MoMo 5. Gồm: trang `/extensions`, trang `/connections`, panel tích hợp trong Cài đặt, tuỳ chọn TikTok/YouTube ở màn
  Đăng đa kênh, biểu tượng kênh. Trang bán hàng (56 file) giữ, chỉ sửa màn cấu hình thanh toán và bước thanh toán.
- **Menu và công tắc:** bỏ 3 khoá (`payments`, `commerce_connectors`, `google_sheets`) khỏi `ORG_FEATURES`;
  `resolveOrgFeatures` chỉ duyệt khoá còn trong catalog nên JSON cũ có khoá thừa không gây lỗi. Sửa
  `industry-presets.ts` (3 mẫu có `payments`, 1 mẫu có `google_sheets`), mô tả `social_posting` ("Fanpage và YouTube"),
  `online_store` ("chuyển khoản QR").
- **Gói:** `google_sheets` nằm trong `PLAN_GATED_FEATURES` và trong danh sách tính năng của 5 gói (`ket_noi`, ba gói
  `tro_ly_*`, và qua `PLAN_GATED_FEATURES` ở `mac_dinh`/`custom`). Bỏ khỏi tất cả. Gói `ket_noi` sau đó không còn
  tính năng theo gói nào (khác `mac_dinh` vốn có mọi tính năng theo gói) và chỉ còn khác ở hạn mức kênh và số người
  dùng; giữ khoá gói như cũ theo quyết định.
- **Quyền:** bỏ 3 quyền `extensions.*` khỏi catalog. Dòng `role_permissions` cũ giữ nguyên; `normalizeGrant` trả `null`
  cho quyền không còn trong catalog nên chúng bị bỏ qua (`packages/rbac/src/grants.ts`).
- **Sự kiện webhook ra:** bỏ `payment.received` khỏi `event-catalog.ts` (giữ `store_order.created`). Endpoint của
  người dùng đang đăng ký sự kiện đã bỏ giữ nguyên dòng, chỉ không còn nhận.
- **Định tuyến công ty:** bỏ loại route `shopee_shop`, `lazada_seller`; giữ `store_slug`. `backfillSettingRoutes` chỉ
  còn nhánh `store_slug`. Bỏ nhánh nhận cid cho link thanh toán.
- **MCP:** bỏ 14 tool; sửa `MCP_SERVER_INSTRUCTIONS` (đoạn "CHƯƠNG TRÌNH CON", nhắc YouTube), `docs/integrations/mcp.md`.
- **Test pg còn import mã sắp gỡ:** `services/crm/src/__pg__/saas-abuse.pg.spec.ts` (connectors, Shopee, VNPay, Store)
  và `pg-harness.ts`: sửa trong G05–G07b.
- **Tài liệu:** `README.md` (bảng Features: add-ons, Payments, Sales connectors, Online store, Multi-channel posting;
  mục "How far it is tested"; bảng "Connectors and how far each is tested"; ảnh `payments.png`; sơ đồ có "Add-ons (Deno
  sandbox)"; dòng Tech stack; nút Deploy và mục Option 1 Vercel), `README.vi.md`, `docs/integrations/status.md`,
  `social.md`, `docs/runbooks/addons.md`, `docs/store/README.md` (thanh toán mới), `docs/architecture.md`,
  `docs/deployment.md`, `ROADMAP.md`, `CHANGELOG.md`, `.env.example` (mục Google, social, connectors, add-ons,
  serverless), `docker-compose.yml` (biến MISA/Shopee/Lazada, `EXTENSIONS_ENABLED`), `Dockerfile` (stage `deno-bin`),
  `PRIVACY.md` nếu có nêu nhà cung cấp.

### 2.3 Dữ liệu cũ ở bản đang chạy

Nguyên tắc của repo: không xoá dữ liệu khách hàng. Theo quyết định của chủ dự án, **chỉ gỡ mã**; không chạy script
ngắt webhook hay thu hồi token phía nhà cung cấp, không ghi đè token đã lưu.

1. **Kiểm kê trước** (issue R002, chỉ đọc): với mỗi schema công ty, đếm dòng của 10 bảng sẽ lưu trữ, `social_accounts`
   và `social_post_targets` theo `network`, bài hẹn giờ và bài lặp còn hiệu lực trên mạng sắp gỡ, `payment_intents` và
   `store_orders` theo trạng thái (đang chờ, hết hạn), khoá `online_store` và `org_features` trong `settings`,
   `platform.company_routes` theo `kind`.
2. **Thanh toán gỡ hai bước** vì đụng tiền của khách:
   - G07a: chặn tạo yêu cầu thanh toán mới, bỏ 2 tool MCP; các đường nhận tiền (IPN VNPay/MoMo, trang return, webhook
     SePay) **vẫn chạy** để ghi nhận giao dịch đang chờ. Không cần báo trước (đã quyết: hiện chỉ chủ dự án dùng).
   - G07b: làm ngay khi R002 báo 0 yêu cầu `pending` chưa hết hạn ở mọi công ty. Sau đó các đường nhận tiền trả
     **410** kèm câu rõ. Truy vấn chỉ đọc `payment_intents` khi dọn dữ liệu mẫu (`sample-records.service.ts` dòng 144)
     giữ lại như ngoại lệ có ghi chú, ở cả bản TS và Rust.
3. **Đường webhook/push/callback của kết nối đã gỡ trả 410, không phải 404.** Vì không ngắt phía nhà cung cấp, KiotViet,
   Sapo, WooCommerce, Shopee, Lazada sẽ còn bắn tới; 410 là tín hiệu chuẩn để phía gửi ngừng thử lại. Rủi ro còn lại
   được chấp nhận: token cũ nằm lại trong DB (đã mã hoá AES-256-GCM, không còn mã dùng) và webhook đăng ký ở nhà cung
   cấp tự hết khi họ gặp lỗi liên tiếp.
4. **Không `DROP` bảng nào.** 10 model giữ trong `schema.prisma` dưới mục "LƯU TRỮ" (để `prisma migrate` không sinh
   lệnh drop do lệch schema), không còn mã đọc/ghi. Rust không sinh struct cho các bảng này.
5. **Dữ liệu của từng mạng được xử lý trong chính PR gỡ mạng đó**, không dồn về cuối: G04 có migration huỷ đích đăng
   bài đang chờ trên 4 mạng (kèm lý do), tắt bài lặp và khung giờ chỉ nhắm các mạng đó, đặt `social_accounts` về
   `disabled`; G06 đặt kết nối bán hàng về `disconnected`. Nếu làm sau, job `social.publish` sẽ gặp đích không còn
   provider (`social-posts.service.ts` dòng 179, 294) mỗi phút. Số migration đặt trước để các PR song song không giành
   nhau: G04 `0021`, G05 `0022`, G06 `0023`, G09 `0024` (chỉ còn `COMMENT ON TABLE`); PR nào merge sau thì rebase và
   đổi tên nếu thứ tự thực tế khác.
6. **File:** media trong thư viện đăng bài giữ nguyên. Mã và bản build chương trình con trong DB giữ nguyên.
7. Trước mỗi lần deploy có migration: dump toàn bộ DB (mọi schema), theo `docs/runbooks/fast-delivery.md`.

### 2.4 Thứ tự PR gỡ

Mỗi PR gồm backend + web + MCP + test + tài liệu cùng lúc (luật repo). Các PR đụng chung vài file
(`mcp-tools.registry.ts`, `org-features.ts`, trang `/connections`, README) nên PR chạy song song phải rebase.

| Thứ tự | PR | Phụ thuộc | Song song |
|---|---|---|---|
| 1 | G01 tách helper số điện thoại khỏi `google/` | | có |
| 1 | G02 gỡ chương trình con | | có |
| 1 | G04 gỡ YouTube/TikTok/Google Business/Instagram (kèm migration dữ liệu) | | có |
| 1 | G05 trang bán hàng sang QR VietQR tĩnh + COD (hết phụ thuộc `connectors`) | | có |
| 1 | G10 gỡ dep `docx`; G11 bỏ đường Vercel; G15 env địa chỉ gốc Graph/Zalo | | có |
| 2 | G03 gỡ Google Sheets | G01 | có |
| 2 | G06 gỡ 6 kết nối bán hàng (kèm migration dữ liệu) | G05 | với G07a |
| 2 | G07a ngừng tạo yêu cầu thanh toán mới | G05 | với G06 |
| 2 | G12a bỏ Redis ở bản TS; G12b đồng bộ state qua Postgres `NOTIFY` | | có |
| 3 | G07b gỡ SePay/VNPay/MoMo (ngay khi hết giao dịch đang chờ) | G07a, R002 | |
| 4 | G08 xoá vỏ `connectors`, dọn dashboard kênh, catalog sự kiện, loại route | G06, G07b | |
| 5 | G09 migration `0024` (ghi chú bảng lưu trữ) | G02–G08 | |
| 6 | G13 quét tài liệu, G14 kiểm "không còn tham chiếu" trong CI | G02–G09 | |

G07b có thể bị chờ. Giai đoạn 2 **không phụ thuộc G07b hay G08**: các issue xuất hợp đồng (C01, C02, C04) chỉ cần
G06 và G07a; 14 route thanh toán vào `routes.json` với `deprecated: true` ngay từ C02 (Rust không viết lại, Node tiếp
tục phục vụ chúng qua proxy cho tới G07b); G07b và G08 cập nhật lại `routes.json`/`events.json` khi merge. Ảnh chụp
schema (C05) sinh sau G04–G06 và được G09 cập nhật.

G11 còn kéo theo bản demo công khai đang chạy theo đường serverless (`docs/runbooks/fast-delivery.md`): chuyển sang
máy chủ tự quản hoặc tắt có thông báo, và sửa runbook, trong cùng issue.

## 3. Phản biện cách chuyển được đề xuất

Giữ khung đề xuất (đóng băng hợp đồng → test hợp đồng → strangler → theo module → shadow → bật → gỡ Node), có bảy
điều chỉnh:

1. **Hợp đồng là bản ghi hành vi, không phải OpenAPI.** Swagger hiện có 590 `@ApiOperation` nhưng **0**
   `@ApiResponse` có `type`: OpenAPI sinh ra chỉ cho biết route và DTO request, không mô tả response. OpenAPI dùng làm
   bảng kiểm route; hành vi được đóng băng bằng test hộp đen và golden response ghi từ Node.
2. **Shadow chỉ cho GET.** Ghi hai lần vào cùng DB sẽ nhân đôi dữ liệu. Đường ghi được kiểm bằng cách chạy cùng kịch
   bản trên hai DB sạch (Node, Rust) rồi so bản dump đã chuẩn hoá (issue C16).
3. **Job và route chuyển quyền sở hữu riêng, qua một tệp chung.** Trong lúc hai tiến trình cùng chạy, mỗi job chỉ một
   bên chạy. Sở hữu ghi trong tệp `TRINITY_OWNERSHIP_FILE` mà cả hai tiến trình đọc (mục 4.14), không phải biến môi
   trường: tiến trình không đọc lại được env của chính nó, và đổi env của Node nghĩa là khởi động lại, làm rớt socket.
   Node không có khoá chéo tiến trình (`cron-registry.ts` chỉ có con trỏ trong RAM) và kế hoạch không thêm: dựa vào việc
   các job hiện có nhận việc nguyên tử theo dòng, nên chồng một lượt khi đổi chủ là chấp nhận được; trống thì không,
   vì vậy thứ tự luôn là bên mới nhận trong cùng lần ghi tệp mà bên cũ nhả. Phía Rust có thêm bước nhận lượt qua
   `platform.job_runs` (mục 4.9). **Ngoại lệ có tên:** `stale-work.digest` không nhận việc nguyên tử (đọc dấu "đã gửi hôm
   nay", gửi cho mọi người, rồi mới ghi dấu: `stale-work.service.ts` dòng 131–145); chồng một lượt là gửi trùng bản
   tổng hợp cho cả công ty. Chặn: job này chỉ đổi chủ khi script của X01 kiểm trên DB thấy, với **mọi** công ty bật
   `stale_reminders`, hoặc giờ Việt Nam còn trước `digest_hour` của công ty đó, hoặc dấu gửi hôm nay đã được ghi
   (`digest_hour` là cài đặt từng công ty; job gửi ở mọi lượt từ giờ đó tới khi ghi được dấu), và bản Rust nhận lượt qua `platform.job_runs` trước khi gửi (M24). Hai việc nền của Node nằm ngoài
   `cronRegistry` cũng theo tệp sở hữu (T01): `@Cron` của thông báo và migrate nền lúc boot.
4. **State và "cổng" trong RAM phải dùng chung trong giai đoạn lai.** Danh sách đầy đủ và cách xử lý (issue G12a/G12b phía
   TS, K11/K12/K33/M45 phía Rust; mọi kênh đi qua Postgres `LISTEN/NOTIFY`, payload chỉ mang khoá vì giới hạn 8 KB):

   | State / cổng | Hiện ở đâu | Trong giai đoạn lai |
   |---|---|---|
   | Vô hiệu cache quyền | `RbacCache` + Redis pub/sub | `NOTIFY` (thay Redis) |
   | Blacklist token, phiên đang hoạt động | RAM | `NOTIFY`; cụm auth bật cùng lúc |
   | Cache đếm khách, cache dashboard | Redis, xoá bằng `SCAN` | RAM từng tiến trình + `NOTIFY` vô hiệu theo `(company, key_prefix)` |
   | Phát chuông tới socket (`CRM_WS_EMIT_PORT`) | Lời gọi hàm trong tiến trình (`internal-ports.module.ts`) | `NOTIFY` `(company, user ids, notification id)`; bên giữ socket nghe và đọc nội dung từ DB |
   | Báo duyệt phiếu lương (`PAYROLL_PAYSLIP_NOTIFY_PORT`) | Lời gọi hàm trong tiến trình | `NOTIFY` |
   | Cửa sổ lỗi Graph 60 phút và backoff toàn app của ChannelGuard | RAM | Mỗi kết quả gọi Graph ra phát qua `NOTIFY`, hai bên cùng cộng; **và** mọi route/job/tool MCP gọi Graph chuyển trong một lần đổi sở hữu (X02e) |
   | Giới hạn tốc độ (`FixedWindowLimiter`, 9 file) | RAM | **Không chia sẻ** (xem "Lịch sử phản biện"): giới hạn hiệu dụng có thể gấp đôi trong vài tuần; giới hạn đăng nhập không bị ảnh hưởng vì cụm auth chỉ ở một bên |
   | "Đá" bộ phát webhook ra (`webhook-kick.interceptor.ts`) | Ở máy chủ thường là **no-op**: `kick()` thoát ngay khi không phải serverless (`webhook-dispatcher.service.ts` dòng 92–93); độ trễ thật là tick 10 giây | Không chia sẻ gì; giữ tick 10 giây. G11 xoá interceptor (mã chết sau khi bỏ serverless) |
   | Ghi outbox sự kiện tích hợp, tạo thông báo | Hàm dùng chung, gọi từ 9 module trong cùng giao dịch nghiệp vụ | Phía Rust là crate nền K36, có trước mọi module của đợt c |
   | Con trỏ job, cache công ty 30 giây, cache khoá kênh 10 giây | RAM | Không cần chia sẻ (tự hết hạn, mỗi job chỉ một bên chạy) |
5. **Đóng băng tính năng backend TS** (đã quyết): trong lúc chuyển chỉ sửa lỗi. Bản sửa lỗi nào đổi hành vi nhìn thấy
   qua HTTP phải kèm ca test hợp đồng và, nếu module đã có ở Rust, bản sửa tương ứng.
6. **Shadow chỉ cho GET đã rà là thuần đọc**, không phải mọi GET: một số GET ghi DB hoặc gọi Graph (mục 1.10). Danh
   sách an toàn nằm trong hợp đồng route; handler shadow chạy trong giao dịch chỉ đọc và bị chặn gọi mạng (mục 4.14).
7. **Web tĩnh tách khỏi lộ trình API.** Rust phục vụ web tĩnh được bật độc lập, sớm, vì web chỉ nói chuyện với API qua
   HTTP cùng origin.

Đã cân nhắc và bỏ: (a) viết lại rồi chuyển một lần, không proxy: không có đường lui theo từng module; (b) Node đứng
trước, chuyển tiếp sang Rust: lớp proxy nằm ở phần sẽ bị bỏ; (c) nhúng Node vào binary: không đạt đích RAM.

## 4. Kiến trúc Rust

### 4.1 Vị trí và bố cục crate

Thư mục `server/` ở gốc repo, một Cargo workspace. Chia nhiều crate nhỏ để biên dịch song song, để mỗi issue đụng ít
crate và để `cargo check -p <crate>` rẻ.

```
server/
  Cargo.toml  rust-toolchain.toml  deny.toml  .sqlx/        # .sqlx = dữ liệu kiểm truy vấn offline
  contracts/                      # hợp đồng đóng băng (mục 6), dùng chung với test Node
  xtask/                          # codegen model, kiểm route, xuất OpenAPI
  crates/
    trinity-bin        # CLI: serve | migrate [--companies] | seed | channel-lock | healthcheck
    trinity-kernel     # config, lỗi → JSON, giờ VN, fold_vi, số điện thoại, tiền, serializer JSON
    trinity-db         # pool, TenantDb/PlatformDb, migrator, platform, provision, model sinh tự động
    trinity-auth       # JWT, mật khẩu, phiên, API key, internal secret, tiền tố token công ty
    trinity-rbac       # catalog, grants, scope, org features, gói, hạn mức, cache quyền
    trinity-http       # router, middleware, validation, rate limit, web tĩnh, strangler proxy, shadow, TLS;
                       # HTTP ra tới địa chỉ người dùng nhập: chống SSRF + GET an toàn (`outbound`, K35);
                       # biên: CORS, giới hạn body, raw body, multipart, IP thật theo TRUSTED_PROXY (`edge`, K16)
    trinity-jobs       # scheduler theo công ty, advisory lock, hàng đợi SKIP LOCKED
    trinity-storage    # local, S3, uploads, range
    trinity-realtime   # Socket.IO tương thích, cổng phát thông báo
    trinity-docgen     # xlsx, pdf, ảnh
    trinity-obs        # log JSON, Sentry, sự kiện sản phẩm, che PII
    mod-auth  mod-settings  mod-contacts  mod-hr  mod-attendance  mod-kanban  mod-custom
    mod-reports  mod-commerce  mod-payroll  mod-notify  mod-integrations  mod-mcp
    mod-channel-guard  mod-facebook  mod-zalo  mod-social  mod-store
```

Hai việc mà gần như mọi module ghi đều làm nằm ở crate nền, không ở module `notify`/`integrations` (issue K36): ghi
outbox sự kiện tích hợp trong cùng giao dịch nghiệp vụ (`publishIntegrationEvent` hiện được gọi từ `contacts`, `deals`,
`custom-objects`, `pos`, `store`, `public-api`, `social`, `facebook`, `zalo-oa`) và tạo thông báo cho người dùng. Nếu
để ở M32/M33 (bật ở đợt d/e) thì module của đợt c phải tự viết lại, sinh hai bản lệch nhau.

Module gọi nhau qua trait "cổng" khai trong `trinity-kernel` (tương đương `apps/monolith/src/internal-ports`):
phát sự kiện tích hợp, gửi thông báo, phát realtime. `mod-mcp` phụ thuộc các `mod-*` khác, không có chiều ngược lại.

### 4.2 Thư viện

Phiên bản là bản ổn định mới nhất trên crates.io ngày 26/11/2026; `Cargo.lock` ghim chính xác ở issue K01.

| Việc | Crate | Phiên bản | Lý do |
|---|---|---|---|
| Runtime | `tokio` | 1.54 | Chuẩn; đặt `worker_threads` theo số vCPU, giới hạn blocking pool |
| HTTP | `axum` + `hyper` + `tower-http` | 0.8 / 1.13 / 0.7 | Extractor kiểu tĩnh hợp với "mỗi route khai quyền"; có sẵn giới hạn body, nén, CORS, trace |
| TLS ở origin | `rustls` (provider `ring`) | 0.23 | Không cần OpenSSL hay cmake; nạp tệp Cloudflare Origin Certificate. Không ACME (TLS công khai do Cloudflare) |
| Postgres | `sqlx` (postgres, rustls, macros, chế độ offline) | 0.9 | Truy vấn kiểm lúc biên dịch, không ORM (lý do ở 4.4) |
| JSON | `serde`, `serde_json` | 1.0 | |
| JWT | `jsonwebtoken` | 12 | HS256 tương thích token đang phát |
| Mật khẩu | `bcrypt` | 0.19 | Kiểm được hash `$2a$`/`$2b$` của bcryptjs |
| Mã hoá | `aes-gcm`, `hmac`, `sha2`, `subtle` | 0.11 / 0.13 / 0.11 / 2.6 | Khớp `secret-crypto.ts`, chữ ký webhook, PKCE |
| HTTP client | `reqwest` (rustls) | 0.13 | Graph API, Zalo, webhook ra |
| Validation | `garde` | 0.23 | Luật theo trường, thông điệp tuỳ biến; bọc trong extractor riêng để trả đúng dạng lỗi của Nest |
| JSON Schema | `jsonschema` | 0.63 | Kiểm đối số tool MCP theo schema đóng băng |
| Số thập phân | `rust_decimal` | 1.43 | 12 trường `Decimal`. **Không** dùng cho bước mà mã TS tính bằng `Number`: xem mục 10.3 |
| Thời gian | `chrono` + `chrono-tz` | 0.4 / 0.10 | `Asia/Ho_Chi_Minh` xuất hiện 42 lần trong mã TS |
| So sánh chuỗi tiếng Việt | `icu_collator` (chỉ khi cần) | chốt ở K26 | 21 chỗ `localeCompare`: chỗ nào chuyển được về `ORDER BY` của DB thì không cần |
| Cache RAM | `moka` | 0.12 | TTL + giới hạn kích thước |
| Realtime | `socketioxide` | 0.18 | Giữ nguyên client Socket.IO của web (lý do ở 4.10) |
| Lưu trữ S3 | `object_store` | 0.14 | Nhẹ hơn AWS SDK |
| xlsx | `rust_xlsxwriter` (ghi), `calamine` (đọc) | 0.104 / 0.38 | Thay exceljs |
| pdf | `printpdf` | 0.13 | Thay pdfkit; nhúng font Tinos có sẵn trong repo |
| Ảnh | `image` (+ `webp` cho WebP có mất dữ liệu) | 0.25 / 0.3 | Thay sharp ở 3 chỗ: avatar và ảnh nhân viên JPEG 200×200, ảnh bảng tin WebP cạnh dài ≤ 1920 (K30; `image` chỉ mã hoá WebP lossless nên cần libwebp) |
| Mẫu chữ | `handlebars` | 6.4 | Cùng cú pháp với mẫu thông báo |
| Web nhúng | `rust-embed` | 8.14 | Một binary; có thể đè bằng thư mục ngoài |
| Log / lỗi | `tracing`, `sentry` | 0.1 / 0.49 | |
| OpenAPI | `utoipa` | 6.0 | Sinh từ mã Rust để so với bảng route đóng băng |
| CLI | `clap` | 4.6 | |
| Bộ cấp phát | `mimalloc` | 0.1 | Giảm phân mảnh khi chạy lâu; chốt lại bằng số đo ở X05 |
| Test | `insta`, `wiremock` | 1.49 / 0.6 | Snapshot; giả Graph/Zalo |

MCP **không** dùng SDK `rmcp` (3.11): máy chủ hiện chạy không phiên, trả JSON, chỉ cần 5 phương thức JSON-RPC
(`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`). Tự viết phần này (ước vài trăm dòng)
cho phép trả đúng từng byte danh sách tool đã đóng băng và không phụ thuộc nhịp đổi của SDK. Cái giá là phải tự tái
tạo chi tiết vận chuyển mà SDK TS đang làm hộ (mục 4.8).

### 4.3 Định tuyến công ty với `search_path`

- **Một pool dùng chung** cho mọi công ty (mặc định 8 kết nối, `DB_POOL_SIZE`; đọc `PRISMA_CONNECTION_LIMIT` nếu có).
  Hiện Node mở tới 5 + 30 × 2 = 65 kết nối; mỗi backend Postgres tốn vài MB, quá nặng cho máy 1 GB.
- `after_connect`: đặt `search_path` về một schema không tồn tại. Kết nối chưa gắn công ty mà chạy truy vấn không định
  danh schema sẽ **lỗi** (fail-closed, tương đương `MissingCompanyContextError`).
- `TenantDb::acquire(company)` lấy kết nối, chạy `SELECT set_config('search_path', $1, false)` với **chỉ** schema của
  công ty (không thêm `public`: nếu thêm, bảng thiếu ở `c_N` sẽ rơi sang dữ liệu công ty 1), trả về `TenantConn`.
  `after_release`: đặt lại schema không tồn tại. Luôn đặt khi lấy, không tin trạng thái cũ.
- **Kiểu dữ liệu ép phải có công ty:** hàm repository nhận `&mut TenantConn` hoặc `&mut TenantTx`; không có cách tạo
  hai kiểu này nếu thiếu `CompanyRef`. Truy vấn bảng dùng chung đi qua `PlatformDb` và luôn viết `platform.<bảng>`.
  Lỗi "quên chọn công ty" thành lỗi biên dịch thay vì lỗi lúc chạy.
- Tên schema chỉ nhận `public` hoặc khớp `^c_[0-9]+$` (như `clients.ts`).
- Prepared statement: Postgres (từ 9.3) phân tích lại statement đã chuẩn bị khi `search_path` khác lúc chuẩn bị, nên
  statement cache theo kết nối của sqlx không trỏ nhầm schema. **Giữ statement cache bật.** Kết luận spike R005
  (test pg `server/crates/trinity-db/tests/search_path.rs`, Postgres 16.14, sqlx 0.9.1):
  - 1.000 lượt xen kẽ hai công ty trên **một** kết nối (pool 1 kết nối, cùng `pg_backend_pid`), cùng câu lệnh liệt kê
    cột: 0 dòng sai công ty; `pg_prepared_statements` chỉ có **một** statement cho câu đó. Thêm 8 task × 250 lượt
    trên pool 4 kết nối: 0 dòng sai.
  - Hai schema khác cột (một bên thêm cột, thứ tự cột khác) với câu liệt kê cột, cả `UPDATE … RETURNING <cột>`, xen kẽ
    trong và ngoài giao dịch: không gặp `cached plan must not change result type`.
  - Kiểu kết quả **đổi** giữa hai schema (`SELECT *` khi khác cột, hoặc cùng tên cột khác kiểu như `text` ↔
    `varchar(40)`): Postgres báo 0A000. sqlx 0.9.1 tự xử lý **ngoài giao dịch** (bỏ statement, chuẩn bị lại một lần:
    đúng dữ liệu nhưng tốn thêm vòng gọi mỗi lần đổi công ty); **trong giao dịch** thì trả lỗi và giao dịch hỏng
    (25P02), phải rollback. Vì vậy vẫn cấm `SELECT *`/`RETURNING *` và vẫn từ chối công ty có `migrated_to` cũ (mục
    dưới): migration đổi kiểu cột là ca còn lại mà lint không bắt được.
  - Kết nối mới (sau `after_connect`) và kết nối vừa trả về pool (sau `after_release`) chạy truy vấn không định danh
    schema thì lỗi 42P01: fail-closed đạt.
  - Cạm bẫy: `set_config('search_path', …, false)` chạy **trong** giao dịch mà giao dịch rollback thì bị hoàn tác.
    `TenantTx` đặt `search_path` trước `BEGIN`; không đổi công ty giữa giao dịch.
- Vẫn từ chối URL pooler transaction-mode, như hiện tại.
- Ngữ cảnh request: struct `Ctx { company, user, db, now }` truyền tường minh; không dùng task-local ẩn. `db` là
  `TenantDb` (**handle**, lấy kết nối theo từng nhóm truy vấn), không phải kết nối giữ suốt request: nhiều handler gọi
  Graph/Zalo giữa hai lần truy vấn (ví dụ `facebook-messenger.service.ts` dòng 347–352), giữ kết nối qua lời gọi mạng
  15 giây sẽ làm cạn pool 4–8 kết nối. Lint trong `xtask` cấm `await` HTTP ra ngoài khi đang giữ `TenantConn`/`TenantTx`.
- Pool đặt `acquire_timeout` và `statement_timeout`; phiên DB đặt `TimeZone=UTC`; khi trả kết nối gọi thêm
  `pg_advisory_unlock_all()`.
- Cấm `SELECT *` và `RETURNING *` (lint): trong lúc migrate cuốn, hai schema có thể khác cột, cộng với statement cache
  sẽ gặp `cached plan must not change result type`. Rust từ chối phục vụ công ty có `migrated_to` cũ hơn bản migration
  mà binary được biên dịch cùng (trả 503 có câu rõ) cho tới khi migrate nền xong.
- Chế độ một công ty (`MULTI_TENANT` khác `true`): công ty luôn là 1, schema `public`; trong `platform` chỉ có hai bảng
  của job (`jobs`, `job_runs`, mục 4.9), không có bảng công ty/định tuyến.
- Kiểm "đã migrate chưa" cho công ty 1: `platform.companies.migrated_to` không được ghi cho công ty 1
  (`provision.ts` lọc `id <> 1`), nên đọc `_prisma_migrations` của `public`.
- **Đã làm ở K06** (`server/crates/trinity-db/src/tenant.rs`): `Db` (pool), `Db::tenant(CompanyRef)` → `TenantDb`
  (handle) → `TenantConn`/`TenantTx`; `PlatformDb` → `PlatformConn`/`PlatformTx`. `search_path` không tồn tại,
  `TimeZone=UTC`, `statement_timeout` gửi trong gói khởi động (thay cho `after_connect`, không thêm vòng gọi); trả kết
  nối thì `ROLLBACK; RESET ALL; DISCARD TEMP; UNLISTEN *; SELECT pg_advisory_unlock_all()` (RESET ALL về đúng giá trị
  khởi động, xoá mọi `SET` của handler; DISCARD TEMP vì `pg_temp` đứng đầu đường tìm bảng, bảng tạm cùng tên của công
  ty trước sẽ che bảng thật của công ty sau; không `DISCARD ALL` vì nó xoá prepared statement của statement cache),
  lỗi thì đóng kết nối. Cổng migrate: tên migration lớn nhất của thư mục Prisma ghi vào binary lúc biên
  dịch (`LATEST_MIGRATION`); công ty N so `platform.companies.migrated_to`, công ty 1 so tên lớn nhất đã chạy xong
  trong `public._prisma_migrations`; thiếu ⇒ `DbError::CompanyNotMigrated` (HTTP 503). Công ty khác 1 còn phải có
  `status = 'active'` (như `findActiveCompany`), không thì `CompanyInactive`. Chỉ nhớ kết quả đạt, trong 10 giây. Env: `DATABASE_URL` (đa công ty: `TENANT_DATABASE_URL`, `DIRECT_DATABASE_URL` trước),
  `DB_POOL_SIZE` (mặc định 8, không có thì `PRISMA_CONNECTION_LIMIT`), `DB_ACQUIRE_TIMEOUT_MS` (10 000),
  `DB_STATEMENT_TIMEOUT_MS` (30 000), `MULTI_TENANT`; tham số riêng của Prisma trong URL (`schema`,
  `connection_limit`…) bị bỏ. URL pooler (`pgbouncer=true`, host `-pooler.`) không dùng được kể cả bản một công ty
  (Rust giữ `search_path` theo phiên): bản một công ty có `DATABASE_URL` pooled thì lấy `DIRECT_DATABASE_URL`. Lint `cargo xtask lint` (job clippy
  của CI): `sql-star` (cả `schema.bảng.*`) và `http-hold` (theo cú pháp: biến từ `<db>.acquire()`/`.begin()` hoặc
  khai kiểu/tham số `TenantConn`/`TenantTx`/`PlatformConn`/`PlatformTx`, tới câu lệnh cấp cao nhất `drop`/`commit`/
  `rollback`; HTTP = `reqwest::…` hoặc `.send()` sau builder `.get/.post/…`; ngoại lệ `// trinity-lint: allow-http-hold`).

### 4.4 Tầng dữ liệu

- **Không ORM.** Lý do: lịch sử schema thuộc về thư mục migration hiện có; schema-per-company cần tên bảng không định
  danh; 56 cột Json và 183 câu SQL thô đã có sẵn dạng SQL; ORM thêm RAM và thời gian biên dịch.
- Truy vấn tĩnh dùng `sqlx::query!`/`query_as!` với `SQLX_OFFLINE=true`: dữ liệu kiểm nằm trong `server/.sqlx/` (một
  tệp mỗi truy vấn, commit vào repo), nên CI và `cargo check` không cần DB. Nhưng **mỗi truy vấn mới hoặc sửa** phải
  được `cargo sqlx prepare` sinh lại dữ liệu, việc này cần một Postgres đã migrate. Chốt: máy phát triển có Postgres 16
  cài thường (không Docker), migrate bằng Prisma, dùng cho `prepare` và cho `cargo sqlx prepare --check` trước khi đẩy;
  job pg trên CI kiểm lại. Truy vấn có bộ lọc động dùng `QueryBuilder`/`query_as` không macro với giá trị bind (không
  nối chuỗi giá trị), không có kiểm lúc biên dịch nên bắt buộc có test pg. Hướng dẫn nằm trong `server/README.md` (K01).
- Struct model sinh bằng `xtask gen-models` từ `schema.prisma` (107 model còn dùng), kèm serializer thống nhất:
  thời gian → ISO 8601 UTC luôn 3 chữ số mili giây và `Z`; `@db.Date` → nửa đêm UTC dạng ISO đầy đủ (như Prisma);
  `Decimal` → chuỗi đã chuẩn hoá (bỏ số 0 thừa); `BigInt` → số JSON.
  Số thực in như `Number.prototype.toString` (`serde_json` bật `float_roundtrip`: `106.66009616851807` đọc về đúng bit).
  Cột mảng NULL → `[]` (kiểu bọc `PgList`, vì Prisma tạo cột `TEXT[]` không NOT NULL và client đọc NULL ra `[]`).
  Cột `Json` đọc từ chữ JSON bằng đường số khoan dung: số ngoài khoảng f64 (`1e999`) → `null`; bản Node/Prisma thì lỗi
  cả dòng ở số đó (đã đo), nên đây là chỗ Rust chịu lỗi hơn, không lệch dữ liệu hợp lệ.
  Quy trình `gen-models`: sửa `schema.prisma` → `cargo xtask gen-models` → commit `models.rs` (test `models_rs_khop_schema`
  đỏ khi tệp cũ). Generator ánh xạ `@@map`/`@map` (cột, enum, giá trị enum), đổi tên từ khoá Rust (`r#type`; `self`,
  `super`, `crate`, `Self` thành `self_`… với `rename` giữ tên JSON/cột), bỏ `@ignore`/`@@ignore`, và **báo lỗi** với
  `@db.*` hoặc kiểu chưa hỗ trợ (`Bytes`, `Real`, `Time`, `Money`, `Xml`…), không đoán. Thêm kiểu mới = thêm kiểu bọc
  trong `trinity-db/src/types.rs` + ca trong `server/contracts/cases/serializer.json` (sinh cột `out` từ Node bằng
  `UPDATE_SERIALIZER_CASES=1`). `cargo xtask lint` cấm `serde_json::to_value` (đổi model sang `Value` làm mất chữ
  số thực và đảo thứ tự khoá); ghi JSON bằng `serde_json::to_string`.
- Module nghiệp vụ (`server/crates/mod-*`, mẫu đầu tiên `mod-commerce`, M28/M25): hàm repository nhận `&mut PgConnection`
  (deref từ `TenantConn`/`TenantTx`), trả `AppError`; truy vấn cố định dùng `query_as!`/`query_scalar!` (kiểu cột
  bọc K10 khai bằng `AS "col: Type"`) và `cargo sqlx prepare`, chỉ bộ lọc động dùng `QueryBuilder` kèm test pg;
  `trinity_db::pg_error::{db_error, app_error}` đổi `sqlx::Error` thành `DbError` của kernel; unique violation chỉ bắt
  đúng tên ràng buộc (vd `projects_code_key`). Luật DTO không có trong `contracts/dto/schema.json` được viết thành hàm
  `validate()` cùng câu và thứ tự lỗi class-validator, cho tới khi DTO vào schema khi route được nối (K14/K11).
- Thông báo (`mod-notify`, M32): mẫu render bằng `handlebars` Rust nhưng AST được viết lại để in đúng chữ của handlebars.js (mảng
  `a,b`, đối tượng `[object Object]`, số kiểu JS, thoát `& < > " ' ` =`), gỡ các helper Rust thêm (`eq`, `and`, `len`…) và
  từ chối helper ngoài `if/each/with/unless/lookup/log` ngay khi lưu; bảng ca `contracts/cases/notify-templates.json` do
  handlebars.js sinh và Rust phải khớp từng byte. Phân trang `/notifications` giữ câu SQL của Prisma cursor + `skip: 1`
  (`created_at <= (con trỏ)`, bỏ dòng đầu). Không có cache số chưa đọc 5 phút trong bộ nhớ (đếm thẳng DB). Phân phối không giữ
  kết nối khi gọi webhook (qua lớp SSRF K35); thử lại `4^n × 250 ms` tối đa 3 lần, `retry_count` cộng dồn qua các lần kẹt/thử (để reaper chạm trần); job `notification.scheduled` 2 phút/lần gồm reaper, claim và giao từng dòng (lượt bị cắt chỉ kẹt tối đa một dòng). `scheduled_at` sai dạng ISO 8601 là 400. Khác handlebars.js: section `{{#ten}}` bị từ chối khi lưu.
- `updated_at`: mọi `UPDATE` do Rust viết phải gán `updated_at = now()`. Kiểm bằng lint trong `xtask` (câu `UPDATE`
  trên bảng có cột này mà thiếu gán thì báo lỗi) và bằng test so trạng thái DB.
- Lỗi DB: bảng ánh xạ SQLSTATE sang hành vi của bản TS nằm ở một chỗ (K05): 23505 ↔ `P2002`, 23503 ↔ `P2003`,
  cập nhật/xoá ảnh hưởng 0 dòng ↔ `P2025`. Hàm repository `update_*`/`delete_*` trả `NotFound` khi 0 dòng; tầng trên
  quyết định 404 hay 500 **giống bản TS ở đúng chỗ đó** (36 chỗ bắt lỗi hiện có, golden có ca). Lỗi do trigger đa công
  ty ném (`TRINITY_EMAIL_TAKEN`, `TRINITY_ROUTE_TAKEN`) ánh xạ như `elk-exception.filter.ts`.
- Hai cột `timestamp` không múi giờ (`contacts.deleted_at`, `login_wifi_check_targets.created_at`) có serializer và ca
  test riêng.
- Con trỏ phân trang (`encodeCursor`/`next_cursor` có ở 30 file ngoài mã sắp gỡ) có **ít nhất ba dạng**, mỗi dạng phải
  được tái tạo đúng, kể cả chỗ chưa hoàn hảo:
  1. base64url của JSON `{v, id}` (`custom-objects/record-query.ts` dòng 44–82): giống **từng byte**, gồm thứ tự khoá
     JSON và dạng chuỗi của giá trị sắp xếp kiểu numeric, timestamptz;
  2. con trỏ kiểu Prisma `cursor: {id}` + `skip: 1` trên thứ tự sắp theo cột **không duy nhất** (`contacts.service.ts`
     dòng 357–397; chính mã ghi chú là trang 2 có thể sót hoặc lặp): Rust phải cho cùng kết quả trang 2 với cùng dữ
     liệu, không "sửa cho đúng" trong đợt chuyển;
  3. id thô: `id < cursor` (`pos-orders.service.ts` dòng 100–105) hoặc id số + bỏ một dòng (`notifications.service.ts`
     dòng 78–101).
  Client đang lật trang lúc đổi sở hữu sẽ gửi con trỏ do Node phát cho Rust. Bộ chuẩn hoá của test không được coi con
  trỏ là token. Mỗi issue module ghi dạng con trỏ của các route của mình; tiêu chí chung của issue module có ca trang 2
  với khoá sắp trùng giá trị và ca con trỏ chéo Node ↔ Rust.
- Giao dịch: `TenantTx` bọc `sqlx::Transaction`; hàm nghiệp vụ nhận executor chung để chạy được trong và ngoài giao
  dịch. Advisory lock giữ nguyên khoá số hiện có.

### 4.5 Migration

**Quyết định: giữ một lịch sử duy nhất ở định dạng thư mục Prisma, Rust có migrator riêng tương thích bảng
`_prisma_migrations`. Không dùng `sqlx migrate`.**

- `sqlx migrate` dùng bảng `_sqlx_migrations` và quy ước tên file khác. Dùng nó nghĩa là hai sổ theo dõi cho cùng một
  DB, phải "baseline" từng schema công ty, và mất khả năng quay lại Node.
- Migrator Rust: đọc `packages/prisma/prisma/migrations/*/migration.sql` theo thứ tự tên; với mỗi schema, so với
  `_prisma_migrations` của schema đó; chạy phần thiếu; ghi dòng mới đúng các cột Prisma ghi (`id`, `checksum`,
  `migration_name`, `started_at`, `finished_at`, `applied_steps_count`, `logs`, `rolled_back_at`); giữ cùng advisory
  lock mà Prisma dùng khi migrate để hai công cụ không chạy chồng nhau.
- Cách tính `checksum` và số của advisory lock lấy từ mã nguồn Prisma đúng phiên bản đang dùng (6.19) và được **khoá
  bằng test hai chiều** ở R005/K07: (a) DB do Prisma migrate → Rust báo không còn gì phải chạy, checksum khớp;
  (b) DB do Rust migrate → `prisma migrate status` báo đã cập nhật.
- **Kết luận spike R005** (bản mẫu `server/crates/trinity-db/src/prisma_migrate.rs`, test
  `server/crates/trinity-db/tests/prisma_compat.rs`; nguồn: `prisma-engines` commit `c2990dca…` đi kèm `prisma` 6.19.3,
  tệp `schema-connector/src/checksum.rs`, `sql-schema-connector/src/flavour/postgres.rs`,
  `sql_migration_persistence.rs`, `commands/apply_migrations.rs`):
  - `checksum` = SHA-256 của nội dung `migration.sql` nguyên văn, hex thường 64 ký tự. Khi so, Prisma chấp nhận cả bản
    đổi `\r\n` ↔ `\n` và dạng hex cũ không đệm số 0 (prisma-engines#1887); Rust làm y hệt.
  - Advisory lock: `pg_advisory_lock(72707369)`, chờ tối đa 10 giây rồi lỗi P1002, **một khoá cho cả DB** (không theo
    schema), không mở khoá tường minh (nhả khi đóng kết nối). Hệ quả cho bản TS hiện tại: 4 tiến trình
    `prisma migrate deploy` song song trong `migrateAllCompanies` thực chất chạy lần lượt, và tiến trình nào chờ quá
    10 giây thì lỗi P1002 (công ty đó migrate lại ở lượt sau).
  - Ghi sổ: bảng `_prisma_migrations` đúng DDL của Prisma; mỗi migration một dòng lúc bắt đầu (`id` uuid v4,
    `checksum`, `started_at`, `migration_name`), chạy script bằng simple query (nhiều câu; script không có `BEGIN`
    riêng thì là một giao dịch ngầm, lỗi không để lại phần đã chạy), thành công thì `applied_steps_count + 1` rồi
    `finished_at`, lỗi thì ghi `logs` và dừng. Script có khối `BEGIN; … COMMIT;` riêng (Prisma sinh khi đổi enum) lỗi
    giữa khối thì phiên ở giao dịch hỏng (25P02): migrator Rust `ROLLBACK` trước khi ghi `logs` và nhả khoá (có test với
    migration enum dạng Prisma). Lỗi migration luôn được trả về, lỗi khi dọn (nhả khoá, đặt lại `search_path`) không
    che nó; xong (kể cả lỗi) `search_path` về schema không tồn tại.
    Schema đã có bảng mà chưa có `_prisma_migrations` ⇒ từ chối (P3005); có dòng lỗi dở dang ⇒ từ chối (P3009).
  - Kết quả test hai chiều (Postgres 16.14, 22 migration của repo): (a) Prisma migrate → Rust: 22/22 checksum khớp
    **từng ký tự**, không còn gì phải chạy, `deploy` lần nữa rỗng; (b) Rust migrate → `prisma migrate status`: "Database
    schema is up to date", `prisma migrate deploy`: "No pending migrations to apply", và `prisma migrate diff` giữa
    schema do Rust migrate và schema cùng tên do Prisma migrate (DB khác) là migration rỗng; (c) migration hỏng do Rust
    ghi thì Prisma đọc ra P3009 đúng tên.
  - **Khoá của Rust:** `pg_advisory_lock_shared(72707369)` cộng khoá exclusive theo schema
    `pg_advisory_lock(72707369::int4, hashtext(<schema>))` (không gian khoá hai số, không đụng khoá một số), chờ tối đa
    10 giây bằng `lock_timeout` rồi trả `lock_timeout` về giá trị cũ của phiên; lỗi hay xong đều chỉ nhả đúng hai khoá
    này (không `pg_advisory_unlock_all()`, để không nhả khoá khác của phiên). Test đo được: Rust giữ khoá ⇒ Prisma chờ 10 giây rồi P1002; phiên giữ khoá exclusive
    như Prisma ⇒ Rust lỗi 55P03; hai worker Rust khác schema giữ khoá cùng lúc được, cùng schema thì không. Nhờ vậy
    `TENANT_MIGRATE_CONCURRENCY` của Rust chạy song song thật mà vẫn loại trừ Prisma.
  - Cạm bẫy đo được: Prisma hết 10 giây thì thoát, nhưng backend Postgres của nó vẫn **xếp hàng chờ khoá exclusive**
    (Postgres không biết client đã đi khi đang chờ khoá) cho tới khi người đang giữ nhả; trong lúc đó mọi yêu cầu
    shared mới của Rust xếp sau nó và cũng hết giờ. Đặt `client_connection_check_interval` (Postgres 14+) ở DB làm hàng
    chờ mồ côi tự hết vài giây sau khi tiến trình schema engine thoát. K07: worker Rust giữ khoá theo **từng schema**
    (không giữ suốt lượt) và thử lại khi 55P03; tài liệu triển khai ghi khuyến nghị `client_connection_check_interval`.
- **Đã làm ở K07** (`server/crates/trinity-db/src/migrate.rs`, lệnh `trinity migrate`): migration nhúng nguyên văn
  vào binary lúc biên dịch (`build.rs`, `include_str!`, test so từng byte với thư mục), nên máy chủ không cần mã nguồn;
  `--dir` đọc thư mục khác. `trinity migrate` = schema `public` (bước deploy của Node), `--schema <public|c_N>`,
  `--companies` (cần `MULTI_TENANT=true`) thay `migrate-companies.cjs`, `--status` chỉ in trạng thái (mã 1 khi còn
  thiếu/lỗi). Kết nối migrate không có `statement_timeout`. Lấy khoá hết giờ (55P03) thì thử lại, tổng cộng tối đa 3 lần
  thử (tính cả lần đầu), mỗi lần chờ 10 giây. `--companies`: chỉ công ty có `migrated_to` rỗng hoặc **nhỏ hơn** bản nhúng (TS chạy lại cả công
  ty có `migrated_to` lớn hơn rồi ghi lùi về bản cũ khi binary cũ chạy trên DB mới), `schema_name` phải đúng
  `c_<id>`, `migrated_to` chỉ ghi tiến và so **theo byte** (`COLLATE "C"`, như so chuỗi của Rust; collation kiểu
  glibc `en_US` bỏ qua `_` nên `0020_x` "lớn hơn" `0020a_y`, cổng của K06 cũng lấy `max(… COLLATE "C")`); song song
  tối đa `min(TENANT_MIGRATE_CONCURRENCY, 16, số công ty)`; mỗi công ty một task (panic thành lỗi của công ty đó);
  một công ty lỗi không chặn công ty khác, thoát mã 1 và liệt kê lỗi; `--status` cũng mã 1 khi nội dung migration đã
  sửa sau khi chạy. `platform.companies` vẫn do `ensurePlatform` tạo (khởi động bản Node với `MULTI_TENANT=true`)
  cho tới khi Rust có bước tương đương (K08); chưa có bảng thì `--companies` báo không có công ty nào. Test
  hai chiều: Prisma migrate `public` ⇒ `trinity migrate --status` đã cập nhật và `trinity migrate` rỗng; `trinity
  migrate --schema`/`--companies` ⇒ `prisma migrate status` báo đã cập nhật; migrate lại là thao tác rỗng.
- Trong giai đoạn lai, Prisma vẫn là công cụ migrate cho **schema đã có** (bước deploy của Node). Ngoại lệ có chủ đích:
  từ đợt b, đăng ký công ty chạy ở Rust, nên migrator Rust **ghi** `_prisma_migrations` của schema công ty **mới**
  (bản TS làm việc này bằng `prisma migrate deploy` trong `provisionCompany`). Vì vậy test hai chiều của K07 là điều
  kiện của X02b, không đợi tới X06. Migrate nền lúc boot chỉ một bên chạy, theo tệp sở hữu. Từ X06 Rust migrate tất cả.
- Cho tới X06, mọi migration mới phải **chỉ cộng thêm** và chạy được với mã Node (để còn đường lui).
- `trinity migrate --companies` thay `scripts/migrate-companies.cjs`: 4 schema một lúc
  (`TENANT_MIGRATE_CONCURRENCY`), ghi `platform.companies.migrated_to`, một công ty lỗi không chặn công ty khác, thoát
  mã khác 0 nếu có lỗi. Lúc boot chạy nền cho công ty còn chậm, như hiện tại.
- `ensurePlatform`, trigger đồng bộ (`trinity-sync-v3`), `provisionCompany`, dọn đăng ký bỏ dở sau 15 phút: chuyển
  nguyên SQL, giữ nguyên số advisory lock.
  **Đã làm ở K08** (`server/crates/trinity-db/src/platform.rs`): `Platform` (`ensure`, tra công ty/email/mã ngoài,
  `state` OAuth, nhận/nhả mã, khoá kênh, cache 30 giây/10 giây như Node), `install_sync_triggers` cho provision (K09),
  `conflict_from_trigger` (câu 409 của `elk-exception.filter.ts`). Truy vấn không dùng macro vì `platform` nằm ngoài
  migration Prisma. Bản đóng băng `tests/fixtures/platform-schema.txt` sinh bằng mã Node
  (`scripts/gen-platform-fixture.cjs`); test pg so từng byte với kết quả của Rust trên cùng dàn dựng. `C05` gộp phần
  này vào `schema.sql` chung.
  **Đã làm ở K09** (`server/crates/trinity-db/src/provision.rs`): `provision_company` (khoá `SIGNUP_LOCK` theo email, migrate bằng K07, trigger K08,
  dữ liệu đầu trong MỘT giao dịch), `reap_stale_provisioning` (15 phút), `migrate::boot_migrate_companies` (chỉ chạy khi tệp sở hữu
  giao migrate cho Rust). Test pg: `server/crates/trinity-db/tests/provision.rs`.
- Sau X06: thư mục migration chuyển về `server/migrations/` (đổi đường dẫn, không đổi nội dung nên checksum không
  đổi); `schema.prisma` bỏ, struct model sửa tay theo migration.

### 4.6 Auth tương thích

- `jsonwebtoken` kiểm HS256 với cùng `JWT_SECRET`, cùng payload, cùng thời hạn, và `leeway = 0` (mặc định của crate là
  60 giây, của bản Node là 0; để mặc định thì token hết hạn vẫn dùng được thêm 1 phút). **Người đang đăng nhập không bị đăng
  xuất** khi chuyển: token do Node phát vẫn hợp lệ ở Rust và ngược lại. Điều này là một ca trong test hợp đồng (token
  phát bởi bên này, dùng ở bên kia).
- Thứ tự kiểm của guard giữ nguyên (`jwt-auth.guard.ts`): loại refresh token → công ty còn hoạt động → blacklist →
  phiên hiện hành → trạng thái tài khoản trong DB. Câu lỗi giữ nguyên văn.
- Mật khẩu: `bcrypt::verify` chạy trong `spawn_blocking` (cost 10 chiếm CPU đáng kể trên máy dùng chung lõi); hash mới
  vẫn cost 10 để Node đọc được nếu phải quay lại.
- Blacklist và phiên đang hoạt động: trong RAM như hiện tại, cộng `NOTIFY` trong giai đoạn hai tiến trình. Sau X06 chỉ
  còn một tiến trình. Hành vi "khởi động lại thì quên" giữ như cũ (không tệ hơn hiện tại).
- **Đã làm ở K11** (`server/crates/trinity-auth`): `jwt` (HS256, `leeway = 0`; jsonwebtoken 12 không có provider mặc định nên cài provider
  HMAC-SHA256 riêng từ `hmac`/`sha2`, tránh `rsa` bị `cargo deny` chặn và `aws_lc_rs` cần cmake), `password` (bcrypt trong `spawn_blocking`),
  `security` (blacklist + phiên: RAM, bảng `token_blacklist`/`active_sessions`, `NOTIFY trinity_sync` kind `token`/`session`, nạp lại khi khởi
  động và sau khi nối lại kênh), `guard` (`Authenticator::authenticate`, 9 câu 401 nguyên văn, `check_service_secret`). Test pg:
  `server/crates/trinity-auth/tests/pg_auth.rs`. Header JWT do Rust ghi `typ` trước `alg` (Node: `alg` trước); không ảnh hưởng việc kiểm ở hai phía.
- Token mang tiền tố công ty (`cN.`), API key SHA-256, `x-service-secret`, consent HMAC: chuyển nguyên thuật toán.

### 4.7 RBAC

- Nguồn chung: `packages/rbac` xuất `contracts/rbac.json` (catalog, phạm vi, tính năng, gói, mẫu ngành) ở issue C04.
  Rust nhúng file này lúc biên dịch; web tiếp tục import gói TS. CI kiểm file JSON khớp gói TS.
- Mỗi route đăng ký qua một hàm bắt buộc nhận `Access` (`Can`, `CanAny`, `AuthOnly`, `Public`, `Internal`); không có
  API thêm route mà thiếu tham số này. Lúc khởi động (`check-config`/`serve`) và khi chạy test cục bộ, bảng route của Rust được so với `contracts/routes.json`
  (đường dẫn, phương thức, loại truy cập, danh sách quyền, chế độ validation, mã trạng thái thành công, cổng tính năng,
  guard riêng, pipe của tham số).
- **Đã làm ở K14** (`server/crates/trinity-http/src/router`): `ApiRouter::route(RouteSpec, handler)` là cách DUY NHẤT thêm route; `RouteSpec::new`
  bắt buộc `Access` (`Can`, `CanAny`, `AuthOnly`, `Public`, `Internal`) nên thiếu khai báo không biên dịch được (doctest `compile_fail`); phương thức
  lấy từ spec; phương thức không khai trên một đường dẫn đã có, hay đường dẫn lạ, trả 404 dạng Nest TRƯỚC mọi guard. Lớp thực thi theo
  `permission.guard.ts` (xác thực → nạp quyền → admin qua hết → 403 câu nguyên văn; lỗi DB khi nạp quyền là 500 như Node, không phải 401), rồi
  `OrgFeatureGate` (K25 cài đặt) và guard riêng theo tên (`AccessDeps.guards`), pipe tham số (`ParseIntPipe`, `ParseInt4Pipe`, `ParseUUIDPipe`) và áp
  `status_ok`. Mọi tên guard/pipe chưa có cài đặt, và `org_feature` trên route `Public`/`Internal` (chưa có công ty đã resolve), làm `ApiRouter::route`
  dừng lúc khởi động. `router::check` so bảng đã khai với `routes.json` (`access`, `permissions`, `permission_mode`, `status_ok`, `org_feature`,
  `guards`, `param_pipes`) và tự kiểm hợp đồng (quyền, tính năng có trong catalog; `validation` khớp bảng lenient/strict K15; dòng trùng phải giống hệt:
  health/live/ready lặp 5 lần ở 5 service cũ). Kiểm chạy ở: test đơn vị `trinity-bin` (`routes::tests`), `trinity check-config` (chạy thử lúc khởi động,
  gọi `routes::boot_check`), `trinity check-routes [--require-all]` / `cargo xtask check-routes`; lệnh `serve` (chưa có) gọi `boot_check` trước khi mở
  cổng. CI hiện đã tắt (chủ dự án: tự test local), nên đây là kiểm cục bộ, không phải job CI. `--require-all` là cổng cuối X06. Module nào có route
  đầu tiên thêm `routes()` vào `declared_routes()` của `trinity-bin`. `resolvePublicRouteCompany` chuyển cùng module đầu tiên cần nó.
- **Đã làm ở M02** (`server/crates/mod-auth/src/invitations.rs`): đăng ký công ty (`register`, dựng schema bằng migrator Rust K07/K09, trả token như đăng nhập) và lời mời nhân viên
  (tạo, danh sách, huỷ, vai trò mời được, xem, nhận): token `cN.` + 32 byte base64url, DB chỉ giữ SHA-256, hạn 7 ngày, một lần; hạn mức gói theo
  `rbac.json` (`Catalog::resolve_plan_for_company`, công ty ≥ 2 thiếu dòng gói = gói đăng ký mặc định 10 người); khoá advisory theo công ty
  (`USER_SLOT_LOCK`) là câu ĐẦU của mọi giao dịch đụng lời mời hoặc đếm chỗ; mời lại thay link cũ; luật chống leo thang quyền; phạm vi `users.manage`;
  hàm thu hồi cho đường thêm người, khoá người dùng và xoá vai trò. Lớp logic + DB như M01 (nối route ở router). `invitations.pg.spec` chuyển thành
  `tests/invitations.rs` (10 ca).
- **Đã làm ở M10** (`server/crates/mod-hr/src/employees*.rs`, `routes.rs`): 12 route `management/employees`; DTO kiểm bằng metadata class-validator thật (`contracts/dto/schema.json`, 5 DTO nhân viên thêm vào `dto-validation-contract.spec.ts`); khoá/mở khoá/xoá/đổi `status` đóng/mở `employment_periods`, khoảng bị khoá không tính lại vào chấm công, lương cũ; ngày nhận đủ dạng `@IsDateString` (`YYYY`, `YYYY-MM`, `HH:MMZ`, `±HHmm`, dấu cách); từ khoá tìm escape `\ % _`; xlsx qua K29 có một dòng trống giữa tiêu đề và tiêu đề cột.
- **Đã làm ở M11** (`server/crates/mod-hr/src/contracts.rs`, `contract_dto.rs`, `routes.rs`): 13 route `management/contracts*` (danh sách theo nhân viên, thống kê, CRUD, tệp hợp đồng, hồ sơ mẫu); 4 DTO hợp đồng thêm vào `dto-validation-contract.spec.ts`; tệp tải lên/xuống qua `ContractStore` (đĩa hoặc S3, cùng khoá `contracts/<nv>/<id>/<ms>_<tên>` và `contract-templates/<ms>_<tên>`), tải xuống đúng từng byte, kiểm MIME như `fileFilter` của multer (PDF/JPG/PNG/WEBP cho hợp đồng; PDF/Word/Excel cho mẫu; ≤ 20 MB). `tests/contracts_http.rs` (4 ca) chạy router K14 thật.
- **Đã làm ở M13a** (`server/crates/mod-attendance`): 11 route `management/attendance` phần cấu hình (văn phòng CRUD, đặt lại thiết bị, cấu hình ca, thứ 7 đi làm, giới hạn đơn); 5 DTO thêm vào `dto-validation-contract.spec.ts`; cấu hình lưu ở `settings` (`attendance_shift_config`, `attendance_request_config`, `attendance_working_saturdays`) đọc rác ⇒ mặc định, ghi kiểm lại như TS; `null` ở trường bắt buộc ⇒ 400, số giới hạn ngoài int4 ⇒ 400. Không có endpoint QR: bảng `attendance_qr_sessions` không còn route nào dùng ở bản TS. `tests/attendance_http.rs` (2 ca) chạy router K14 thật.
- **Đã làm ở M19** (`server/crates/mod-setup`): 11 route `setup/*` (trạng thái, prompt nối agent, màn hướng dẫn, hoàn tất, dựng hệ thống, wizard + cấu hình) và 2 route mẫu bảng `custom-objects/templates*` mà M17 để lại. Danh mục mẫu bảng (thực thể, trường, bản ghi mẫu với `{today}`/`$add_months`), ngành + phân hệ gợi ý và prompt từng agent nhúng từ `contracts/setup/catalog.json`, sinh bởi `setup-catalog-contract.spec.ts` từ mã TS (không chép tay); 4 DTO (`ApplyTemplateDto`, `BuildSystemDto`, `WizardStepDto`, `WizardConfigDto`) thêm vào `dto-validation-contract.spec.ts`. "Dựng hệ thống" ghi MỌI thứ (bảng, mẫu, phân hệ, ngành, dấu đã dựng, trạng thái) trong MỘT giao dịch, khoá danh sách mẫu (`7375`) lấy đầu giao dịch nên hai lần dựng đồng thời không sinh mẫu trùng. Bản ghi mẫu tự xoá mềm khi có bản ghi thật đầu tiên (mẫu đã sửa hoặc đang được liên kết thì giữ); truy vấn chỉ đọc `payment_intents` giữ như bản TS (G07b). Việc dọn mẫu không bao giờ làm hỏng việc chính (`purge_if_real` nuốt lỗi, ghi log). Chưa nối ở tầng serve: gọi `samples::purge_if_real` sau khi tạo khách/bản ghi, `Ctx::contacts_changed` để xoá cache đếm khách, sự kiện sản phẩm `onboarding_step`/`table_created`/`workspace_built`. Lệch nhỏ so với Node: `PUT wizard/config` giữ khoá không gửi (Node có thể đặt lại về mặc định); giờ không múi của bản ghi mẫu coi là UTC.
- `ScopeService` và bộ dựng điều kiện phạm vi chuyển kèm test pg hiện có (`scope.service.spec.ts`).
- **Đã làm ở K12** (`server/crates/trinity-rbac`): `catalog` (nhúng `contracts/rbac.json`), `grants` (`normalize_grant`, `merge_grants`, `can`,
  `scope_of`, `is_subset`; bảng ca dùng chung `contracts/cases/rbac.json` do `packages/rbac/src/grants-cases.spec.ts` sinh, Rust chạy lại ở
  `tests/shared_cases.rs`), `service` (`PermissionService::grants_for`, `ScopeService::owner_ids` theo cây `manager_id`), `cache` (TTL 60 giây theo
  (công ty, người dùng), `invalidate_users` xoá ngay rồi `NOTIFY trinity_sync` kind `rbac`; nhận tin `rbac` (`c < 1` hoặc thiếu ⇒ bỏ, `ids` nhận cả chuỗi số); mọi lần đọc DB chụp bộ đếm thế hệ trước và chỉ ghi cache khi không có vô hiệu xen giữa; chỉ gọi `invalidate_users` sau khi commit; nối lại
  kênh thì xoá hết). Bộ dựng điều kiện phạm vi (`scope-where.ts`) chuyển cùng module đầu tiên dùng nó (M-issue), không ở K12. Test pg: `tests/pg_rbac.rs`.
- Cache quyền TTL 60 giây bằng `moka`, khoá theo công ty; vô hiệu ngay trong tiến trình khi sửa vai trò.

### 4.8 MCP và OAuth

- Danh sách tool, mô tả, `inputSchema`, `outputSchema`, annotations và instructions phục vụ từ
  `contracts/mcp/tools.json` (đóng băng từ Node, issue C03). Đối số được kiểm bằng `jsonschema` theo chính schema đó,
  rồi giải mã sang struct serde của từng tool. Nhờ vậy client đã lưu danh sách tool không thấy khác biệt.
- Giữ: kiểm `Origin`, ba giới hạn tốc độ, header `WWW-Authenticate` với `resource_metadata`, che số điện thoại
  (`restrictForAi`, `sanitizeForAi`), từ chối tìm theo chuỗi nhiều chữ số, cắt kết quả 40.000 ký tự, ghi audit mỗi lời
  gọi, ánh xạ lỗi sang `isError` với câu song ngữ như `mcp-server.service.ts`.
- Chi tiết vận chuyển phải tái tạo và có golden (C03): thương lượng `protocolVersion`, header `Mcp-Protocol-Version`,
  406/415 theo `Accept`/`Content-Type`, mã lỗi JSON-RPC cho phương thức không hỗ trợ (`resources/list`,
  `prompts/list`), kiểm `structuredContent` theo `outputSchema`, câu lỗi khi đối số sai. Cắt kết quả 40.000 theo đơn
  vị UTF-16 như `.slice()` của JS, không theo byte hay ký tự Unicode.
- Luật sản phẩm giữ nguyên và có test: không có tool xoá; hành động công khai cần `confirmed_by_user`; tính năng mới
  phải có tool.
- OAuth: metadata ở `/.well-known/oauth-authorization-server` và `/.well-known/oauth-protected-resource` do Rust trả
  trực tiếp (hiện là rewrite của Next); DCR, CIMD (tải qua lớp chống SSRF), PKCE S256, xoay refresh token, thu hồi,
  dọn định kỳ. Issuer không bao giờ suy từ header `Host` (như `oauth-config.ts`).

### 4.9 Job nền không Redis

Hai cơ chế, cả hai chỉ dùng Postgres:

1. **Scheduler theo công ty** (thay `cronRegistry` và các `setInterval`): mỗi job khai tên, chu kỳ, budget. Mỗi lượt
   duyệt công ty đang hoạt động với con trỏ tiếp tục và budget như `runForEachCompany`; công ty lỗi không chặn công ty
   khác. **Nhận lượt** cho một cặp (job, công ty) bằng một giao dịch ngắn: `pg_try_advisory_xact_lock` rồi ghi
   `locked_until` vào `platform.job_runs`; lượt khác thấy `locked_until` chưa qua thì bỏ qua. Không giữ advisory lock
   mức phiên suốt lượt chạy: mã hiện tại chỉ dùng khoá mức giao dịch (27 lần `pg_advisory_xact_lock`, 0 lần mức phiên),
   và khoá mức phiên trên pool dùng chung sẽ kẹt lại khi task bị huỷ, đồng thời chiếm một kết nối suốt budget 30–40
   giây. Các job hiện có đã tự "nhận việc" nguyên tử trên bảng nghiệp vụ (webhook delivery, người nhận broadcast, lượt
   chạy kịch bản, đích đăng bài), phần đó chuyển nguyên SQL.
2. **Hàng đợi `platform.jobs`** cho việc một lần: cột `id, company_id, kind, payload jsonb, run_at, attempts,
   max_attempts, locked_at, locked_by, last_error, dedupe_key unique`. Worker lấy việc bằng
   `SELECT … FOR UPDATE SKIP LOCKED`, thử lại có backoff, quá số lần thì giữ lại ở trạng thái lỗi để xem. Dùng một bảng
   chung (có `company_id`) thay vì một bảng mỗi schema để chỉ cần **một** câu thăm dò cho mọi công ty. Bảng tạo lúc boot
   bằng DDL idempotent như `ensurePlatform`, ở cả chế độ một công ty; Node không đọc schema `platform` khi
   `MULTI_TENANT` tắt nên không ảnh hưởng đường lui.
   Dùng cho: 6 chỗ "bắn rồi quên" hiện có, migrate công ty lúc boot, tải video nhiều phần lên Facebook.
   Xử lý webhook Facebook/Zalo **giữ nguyên kiểu đồng bộ trong request** ở lần chuyển đầu (đúng hành vi hiện tại);
   chuyển sang "ghi nhận rồi xử lý qua hàng đợi" là cải tiến sau X06, không thuộc phạm vi tương thích.

**Đã làm ở K20** (`server/crates/trinity-jobs/src/scheduler.rs`): `Scheduler` (đăng ký `JobSpec`, `tick`, `run` theo chu kỳ), con trỏ theo job trong RAM,
nhận lượt `pg_try_advisory_xact_lock(hashtext('job_runs:<job>'), company)` + `locked_until = budget` rồi commit ngay (job chạy ngoài kết nối),
`ensure_job_tables` (cả bản một công ty), chủ job từ `Ownership::job` (`set_ownership`/`reload_ownership`). Test pg: `tests/scheduler.rs`.

**Đã làm ở K21** (`server/crates/trinity-jobs/src/queue.rs`): `Queue` (`enqueue` + `dedupe_key`, `claim` bằng một câu `UPDATE … FOR UPDATE SKIP LOCKED`, `complete`/`fail` khớp token lần nhận,
backoff 5 giây × 2^(n-1) trần 1 giờ, việc quá số lần giữ `failed`, `list_failed`/`requeue_failed`), `Worker` (bộ xử lý theo `kind`, panic thành lỗi). Worker chết thì hết `locked_until` việc được nhận lại; `attempts` tăng lúc nhận. Test pg: `tests/queue.rs`.

Sở hữu job trong giai đoạn lai nằm trong tệp sở hữu chung (mục 4.14): Rust nạp lại khi nhận `SIGHUP` (K20), Node đọc
lại tệp ở đầu mỗi lượt tick mà không cần khởi động lại (T01). `platform.job_runs` tồn tại cả ở chế độ một công ty.

### 4.10 Realtime

Dùng `socketioxide` giữ nguyên giao thức: path `/notif-ws`, namespace `/notifications/ws`, xác thực JWT ở handshake,
room theo công ty, hai sự kiện. Web không phải sửa. Đường lui: web đã hỗ trợ chế độ thăm dò; cờ này hiện là biến
lúc build (`NEXT_PUBLIC_REALTIME_MODE`), nên được chuyển sang đọc lúc chạy từ `GET /site-config` (W03) để đổi không
cần build lại web và binary. Spike R006 kiểm tương thích với `socket.io-client` 4.7 trước khi chốt; nếu không
đạt, chuyển sang SSE và sửa `apps/web/src/components/notification-socket.tsx`.

**Quyết định R006 (27/11/2026): giữ Socket.IO bằng `socketioxide` 0.18, không chuyển SSE.** Mã spike ở
`docs/rust/spikes/r006/` (axum 0.8 + socketioxide 0.18 + jsonwebtoken 12; ngoài workspace `server/`), kiểm bằng
`socket.io-client` 4.8.3 (bản `pnpm-lock.yaml` đang khoá; `^4.7.5` trong `package.json`), cùng tuỳ chọn như
`notification-socket.tsx` (`path: '/notif-ws'`, `transports: ['websocket']`, `auth` dạng hàm). Kết quả:

| Ca | Kết quả |
|---|---|
| Handshake có JWT hợp lệ (`auth.token`, HS256, `sub`, `cid`) rồi vào room `user_<id>` / `c<cid>:user_<id>` | đạt |
| Nhận `notification:new` và `notification:count` (đúng payload của gateway Nest) | đạt: Node, Chrome (Playwright, trang khác origin, có CORS), WebKit 18.2 (engine của Safari) |
| Không token / token sai | máy chủ ngắt, client nhận `io server disconnect`, y hệt `client.disconnect()` của Nest |
| Cách ly | user khác và công ty khác không nhận; công ty 2 chỉ nhận tin gửi vào room của nó |

Điều cần nhớ khi làm thật (K-cổng realtime):

- `Data<T>` của handler namespace nhận `auth`; lỗi xác thực dùng `disconnect()` trong handler như spike (khớp hành vi Nest, đã đo). Dùng middleware
  từ chối kết nối thì client nhận `connect_error` thay vì `disconnect`: chưa thử, phải kiểm lại với bộ bắt `connect_error` của web.
- Tính đa công ty ở room, vì `currentCompanyId()` của Nest không có tương đương ngoài request: bên phát phải truyền `cid` rõ ràng.
- Phát từ ngoài kết nối (job, API) đi qua `io.of(ns).to(room).emit(...)`; một tiến trình duy nhất nên không cần adapter Redis.
- Chưa đo: Safari bản máy thật (chỉ WebKit của Playwright), proxy ngược cắt WebSocket nhàn rỗi (cần ping của Socket.IO, mặc định 25 s
  vẫn giữ kết nối), tải nhiều kết nối. Đường lui SSE giữ nguyên (cờ thăm dò đang có sẵn).

Đã làm ở K33 (`server/crates/trinity-realtime`): `NotifSocket::new` dựng layer socketioxide giữ đúng giao thức trên (path, namespace,
room, hai sự kiện; JWT kiểm bằng `trinity_auth::jwt::verify`, cùng luật gateway Nest: chỉ chữ ký + hạn, `cid` ≤ 0 hoặc một công ty ⇒ công ty
1; không token/sai ⇒ `disconnect()`). Bên phát truyền `company` rõ ràng (`send_to_user`, `emit_unread`, `push_local`). Chuông từ tiến
trình kia: `spawn_bell_listener` nghe `trinity_sync` kind `bell`, đọc `notification_logs` theo id `n` rồi phát `notification:new` +
`notification:count` (3 số như `emitUnreadCounts`, nhóm tin nhắn theo `MESSAGE_EVENT_TYPES`), như `onRemoteBell` của Node; thông báo tạo ở
Rust (`create_notification`, K36) đẩy socket cục bộ bằng `push_local` và Node nhận qua `NOTIFY`. `cors_layer` làm lại `buildWsCorsOrigin`.
Ca test dùng WebSocket thô (Engine.IO v4 / Socket.IO v5), không cần client Node. Chi tiết sau review: socketioxide gửi gói xác nhận
kết nối **trước** khi chạy handler nên `join` nằm ở middleware (không từ chối, để vẫn là `io server disconnect`) và handler ngắt
khi xác thực hỏng; handshake từ chối refresh token và `sid` đã bị phiên khác thay (cả hai bên Node và Rust); tin `bell` có `c` ≤ 0
ở đa công ty bị bỏ; chỉ một bên nghe `trinity_sync`, `spawn_bell_listener` chuyển tiếp mọi tin khác và `Resync` sang bên dùng
khác, `Resync` phát lại số chưa đọc cho mọi user đang nối.

### 4.11 Lưu trữ

Driver local (ghi nguyên tử, chống thoát thư mục, phục vụ `Range`) và S3 qua `object_store`. `/uploads/*` do Rust phục
vụ trực tiếp với cùng header (`nosniff`, cache 1 ngày). Driver S3 hỗ trợ URL ký sẵn như `getSignedUrl` hiện có. Driver Vercel Blob bỏ cùng đường Vercel. Giữ nguyên
`storage_key` và bố cục thư mục để file cũ đọc được.

Đã làm ở K22 (`server/crates/trinity-storage`):

- Driver đĩa `LocalDiskDriver` chuyển nguyên `packages/storage`: `resolve_safe_key` (chặn rỗng, null byte, `\`,
  đường dẫn tuyệt đối, `..` thoát gốc theo `posix.normalize`), ghi nguyên tử `<đích>.tmp-<16 hex>` rồi `rename`,
  `Content-Type` ở `<key>.meta.json` dạng `{"contentType":"…"}` (Rust ghi giống từng byte `JSON.stringify`),
  `parse_range` như `range.ts` (Range lạ ⇒ 200 cả file, không có 416), xoá không lỗi khi không có, `init` ghi thử.
  Spec TS chuyển sang test Rust; file do driver Node ghi (`tests/fixtures/node-written`, sinh bằng
  `scripts/gen-node-fixture.cjs` từ `packages/storage/dist`) đọc đúng nội dung, `Content-Type` và `Range`.
- Kho `uploads` (`LocalUploadsStore`): `<UPLOADS_LOCAL_ROOT hoặc cwd/uploads>/<thư mục>/<tên>`, không có meta. Ghi
  nguyên tử (TS ghi thẳng; kết quả trên đĩa như nhau). Bản TS **phục vụ** từ `<cwd>/uploads` bất kể
  `UPLOADS_LOCAL_ROOT`; Rust phục vụ từ cùng gốc với chỗ ghi.
- Route `/uploads/*` (`uploads_router`) trả như trình duyệt thấy qua route Next + `express.static` của monolith:
  `Content-Type` theo bảng mime 1.6 mà `send` 0.19 dùng (sinh vào `mime_db.rs`, kèm `; charset=UTF-8` cho kiểu chữ),
  `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=86400, immutable`; 400 cho segment rỗng, `.`,
  `..`, chứa `/` hoặc `\` sau giải mã; 404 cho dotfile ở segment cuối, null byte, không có file, `ENOTDIR`; thư mục
  phục vụ `index.html` nếu có; 308 bỏ `/` cuối. Golden status, `Content-Type` và thân lấy từ `express.static` thật
  (`tests/fixtures/node-uploads-golden.json`).
- **Khác có chủ đích:** header `Range` hợp lệ ở `/uploads` được trả 206 (`Content-Range`) và mọi phản hồi có file kèm
  `Accept-Ranges: bytes`; bản Node bỏ qua `Range` (route Next không chuyển tiếp) và luôn trả 200 cả file. Tệp tạm
  `<tên>.tmp-<16 hex>` của ghi nguyên tử trả 404 (Node phục vụ được). Key chuẩn hoá về chính root (`a/..`) bị từ chối
  (TS trả root). `init` dọn tệp tạm mồ côi cũ hơn 1 giờ (để không xoá tệp đang ghi dở của tiến trình Node chạy song
  song). Kích thước lấy từ tệp đã mở, không lệch khi bị ghi đè chen giữa. Rust stream thân file thay vì đệm cả file
  vào RAM như route Next.
- Driver S3 (`object_store`, URL ký sẵn) thuộc K23.

### 4.12 Observability

- Log JSON ra stdout qua `tracing` (trường: correlation id, phương thức, đường dẫn đã che token, mã trạng thái, thời
  lượng, id người dùng đã băm). Bỏ transport Elasticsearch của winston và đường `/api/fe-logging`; ai cần thì thu stdout.
- Sentry: chỉ lỗi 5xx và trace theo `SENTRY_TRACES_SAMPLE_RATE`; bộ lọc PII như `docs/deployment.md` (bỏ body, cookie,
  header, query; che email và số điện thoại). PostHog: 7 sự kiện máy chủ hiện có, gửi không chờ.
- `GET /api/v1/telemetry/config`, `/api/build-id`, health giữ nguyên đường dẫn và hình dạng.
- Tài liệu API `/docs`: phục vụ OpenAPI do `utoipa` sinh, cùng điều kiện bật như hiện tại (ngoài production hoặc
  `SWAGGER_ENABLED=true`).
- **Đã làm ở K27** (`server/crates/mod-system`): `health`/`ready`/`live` (một bộ, `service: "auth-service"` như monolith Nest), `telemetry/config` và
  `telemetry/identity` giữ hình dạng bản TS (bảng ca dùng chung `contracts/cases/telemetry.json` do `telemetry-cases.spec.ts` sinh từ
  `buildTelemetryConfig`, Rust chạy lại ở `tests/shared_cases.rs`), `GET /api/v1/site-config` (chỉ có ở Rust: `legal.*` từ `LEGAL_*`,
  `realtime_mode` từ `REALTIME_MODE` hoặc `NEXT_PUBLIC_REALTIME_MODE`, `ds_v2` từ `DS_V2_ENABLED` hoặc `NEXT_PUBLIC_DS_V2`; khai ở
  `RUST_ONLY_ROUTES` của `router::check`, bắt buộc `Public`), `GET /api/build-id` (`TRINITY_BUILD_ID` lúc chạy, rồi lúc biên dịch, rồi
  `unknown`; `no-store`), `/docs` + `/docs-json` do `utoipa` sinh, bật theo `NODE_ENV != production` hoặc `SWAGGER_ENABLED=true` (404 nếu không).
  Đợt a trong tệp sở hữu: mẫu `server/contracts/ownership-wave-a.json` (chỉ các route dưới `/api/v1`); `site-config` phải thuộc `rust` vì bản TS không có (có test). `/api/build-id` (Next) và `/docs`, `/docs-json` (Node) KHÔNG vào đợt a: do Next/Node phục vụ tới khi nhả (có test khẳng định chúng thuộc `node`).
  Chưa nối vào `serve` (chưa có); `trinity-bin` đã lấy `mod_system::routes()` vào `declared_routes()`.
- Endpoint nội bộ `GET /internal/metrics` (cần `x-service-secret`): RSS, số kết nối pool, độ trễ job, độ dài hàng đợi.

**M37 (đã làm, crate `mod-oauth`):** 9 route (7 OAuth + `GET`/`DELETE /integrations/ai-connections`) khớp `routes.json`; metadata, DCR, CIMD (tải qua `safe_get_json`), consent token HMAC cùng công thức byte với Node (token ký ở Node xác minh được ở Rust và ngược lại), PKCE S256, xoay refresh (cửa sổ đồng thời 10 giây), thu hồi, `OauthCtx::verify_access_token` cho MCP (M39). Job dọn dùng `trinity_integrations::oauth_purge_job` (K35). **Lệch/chưa làm:** chưa có `serve` nên chưa chạy được `tests/contract` và `tests/mcp-e2e/run.mjs` trên binary Rust; 29 ca pg chuyển từ C13a chạy bằng router thật + Postgres thật (`crates/mod-oauth/tests/oauth_http.rs`), `verifyAccessToken` gọi trực tiếp thay cho bước "gọi MCP bằng chính token" cho tới khi M39 xong; `/integrations/status` thuộc M33 (chưa nối route) nên ca trạng thái chưa chuyển. Metadata ở `/.well-known/...` gốc (rewrite của Next) do issue ownership/X lo, route ở đây giữ đường `/api/v1/oauth/...` như Node. **Lệch Node (có chủ ý, có test):** hai request refresh song song trong cửa sổ 10 giây vẫn cùng nhận token (như Node) nhưng khi một đầu xoay thì đầu còn lại bị đánh dấu đã dùng, nên chuỗi không còn hai đầu sống song song; trần peer được kiểm trước xô theo `client_id` (kẻ lạ không đốt được xô của client công khai); danh sách tên miền CIMD áp cả ở token/thu hồi. Giới hạn tốc độ (đăng ký 10/giờ, token+thu hồi 60/phút, consent 30/phút) nằm trong RAM của `OauthCtx`, không chia sẻ với Node (I3).

**M36 (đã làm, crate `mod-public-api`):** 5 route `/api/v1/public/{contacts,contacts/sources,deals,tasks,tasks/columns}` khớp `routes.json`, guard `ApiKeyGuard` (qua `mod_apikeys::api_keys::validate`, thêm kiểm chủ khoá còn hoạt động như guard CRM) và `PublicApiRateLimiterGuard` (100 yêu cầu/phút/khoá, khoá theo công ty; 429 giữ nguyên body `{statusCode, message, retryAfter}`) đăng ký bằng `mod_public_api::named_guards`. Thêm `PublicCreateDealDto`, `PublicCreateTaskDto` vào `schema.json` và golden. **Lệch/chưa làm:** tạo thương vụ gọi `mod_deals::deals::create` (M08); mọi kiểm phạm vi chạy TRƯỚC khi có thể tạo khách mới (không để khách mồ côi); `SampleRecordsService.purgeIfReal` chưa có bản Rust nên chưa dọn bản ghi mẫu sau khách thật đầu tiên; `last_used_*` của khoá ghi trước bước kiểm chủ khoá (một lần ghi thừa khi chủ khoá bị khoá).

**M39 (đã làm, crate `mod-mcp`):** lõi máy chủ MCP không phiên, trả JSON, 3 route `/api/v1/mcp` khớp `routes.json` (`POST` JSON-RPC, `GET`/`DELETE` ⇒ 405 kèm `Allow`). `tools/list` (104 tool) và `instructions` phục vụ nguyên văn từ `contracts/mcp/` (khớp từng byte, test dựng lại `tools.json` từ phản hồi); 16 ca `transport/*.json` khớp từng byte (thứ tự khoá `result`, `jsonrpc`, `id` do dựng chuỗi tay); xác thực bằng token OAuth của M37 (`OauthCtx::verify_access_token`, rồi `integrations.ai_connect`, scope `crm.read`; AI bị gỡ mọi `*.phone_full`); lỗi DB khi đọc quyền ⇒ 500 (không phải 401: không challenge, không đếm lần sai, không ghi `denied`); `Origin` theo danh sách; `WWW-Authenticate` với `resource_metadata` và `scope="crm.read crm.write"` (bỏ dấu tiếng Việt cho header); ba giới hạn 240 request/phút/người, 60 lời gọi/phút/người, 30 lần xác thực sai/phút/IP (RAM, không chia sẻ với Node, I3; IP không tin được thì dùng CHUNG trần peer 600/phút với OAuth, khoá xác thực sai băm sha256[..24] như OAuth); nhật ký mỗi lời gọi với `args` đã che SĐT (`ai_output::sanitize_for_ai` port đủ `ai-output.ts`); cắt kết quả 40.000 theo UTF-16; ánh xạ lỗi sang `isError` song ngữ như `mcp-server.service.ts`. Test: `tests/mcp_contract.rs` (11 ca, không cần DB), `tests/mcp_pg.rs` (token OAuth thật trên công ty thứ hai: thiếu/rác/công ty lạ/hết hạn/thu hồi/sai audience/thiếu scope/mất quyền/người dùng bị khoá, nhật ký, router). **Lệch/chưa làm:** (1) chưa có tool nào đăng ký: `ToolRegistry` rỗng nên `tools/call` tool trong hợp đồng trả "chưa sẵn sàng" (các nhóm tool là việc của M40–M42, mỗi nhóm khai `ToolSpec` gồm scope và quyền, vì hợp đồng đóng băng không chứa chúng); (2) chưa có `serve` nên chưa chạy được `tests/mcp-e2e/run.mjs` trên binary Rust; (3) câu lỗi của các trường hợp chưa có ca đóng băng (JSON-RPC hỏng cấu trúc, `params` sai kiểu, đối số sai schema, `structuredContent` sai `outputSchema`) là bản gần đúng của SDK/zod (cùng mã và khung, không phải từng chữ); (4) schema đóng băng có `additionalProperties: false` nhưng zod BỎ khoá lạ, nên khoá lạ bị bỏ (`strip_unknown`) rồi mới kiểm trên schema đã gỡ `additionalProperties: false`; union (`anyOf`/`oneOf`) không bỏ khoá lạ bên trong; (5) thứ tự khoá trong `structuredContent` theo bộ serialize của tool, không bảo đảm như zod; (6) hợp đồng đóng băng có 104 tool (con số thay cho 101/115 ở các mục trên). Phần kiểm "thân là một thông điệp JSON-RPC (không batch)" của controller nằm trong `endpoint`; JSON hỏng ở body-parser Nest sẽ khác (Rust trả -32700 như ca `json-hong` đóng băng).

**K25 (đã làm, phần logic thuần):** `trinity_http::rate_limit::FixedWindowLimiter` (RAM, thời gian là tham số, khoá theo công ty) và `trinity_rbac::plan` (khoá/nhãn tính năng, 6 gói, `require_org_feature` trả 403, `check_user_slot` trả 409, `plan_from_setting` có `trim()` kiểu JS còn `resolve_plan_for_company` không trim như TS). Bảng ca dùng chung `server/contracts/cases/plan.json` (cột kết quả sinh bằng `OrgFeatureGuard`, `assertUserSlotAvailable`, `FixedWindowLimiter` thật). **Lệch so với mô tả ban đầu:** chưa có middleware axum, chưa nạp `org_features`/`org_plan` từ DB và chưa đếm người; các limiter cụ thể (MCP, OAuth, API công khai, webhook, trang bán hàng, đăng nhập) do issue của từng route tạo.

**M06 (đã làm, phần logic và bảng route):** crate `mod-settings` (12 endpoint cài đặt, tuỳ chọn, tính năng, gói, mức dùng; hai đường `channel-guard` thuộc M45). Quyết định: (1) **đường ghi không fail-open**: `PUT /settings/org-features` đọc cấu hình bằng đường có lỗi, lỗi DB ⇒ 500 "Không cập nhật được tính năng của tổ chức" và không ghi lại từ mặc định (chỉ `GET` fail-open, như Node); đổi gói cũng không giả định `custom` khi đọc gói lỗi. (2) `set_plan` ghi dòng `org_plan` và `audit_logs` trong một giao dịch (savepoint nếu người gọi đã ở trong giao dịch). (3) `null` ở khoá của `PUT org-features` đặt lại về mặc định (phản hồi trả `null`, đọc lại là mặc định). (4) `?group=` rỗng không lọc; `sort_order` ngoài `int4` báo phạm vi (400) thay vì lỗi DB 500 của Node. (5) Chưa có cổng đo: tầng serve gọi `trackProductEvent` (`plan_changed` sau `set_plan`, `feature_toggled` theo `Updated::changed` sau `update`). (6) Bản Node không có giá gói trong các phản hồi này; giá không thuộc API. Bốn DTO chưa có trong `contracts/dto/schema.json` kiểm tay, đối chiếu `ValidationPipe` thật bằng `mod-settings/tests/fixtures/dto.json` (sinh bởi `settings-dto-golden.spec.ts`).

**M12 (đã làm, phần logic và bảng route):** `mod-hr::recruitment` (10 endpoint `/management/recruitment/*`; `recruitment-overview` thuộc báo cáo). Dữ liệu vào đi qua bộ kiểm chung K15: thêm 6 DTO (`UpdateCandidateDto`, `CreatePositionDto`, `UpdatePositionDto`, `QueryCandidatesDto`, `QueryRecruitmentStatsDto`, `QueryPositionsDto`) vào `SAMPLES` của `dto-validation-contract.spec.ts` nên `schema.json` và `validation.golden.json` có metadata thật (golden 33 DTO khớp `ValidationPipe`). `search` KHÔNG thoát `%`/`_` (đã đo bằng Prisma thật: `contains: '%'` khớp mọi dòng), nên Rust dùng `ILIKE '%…%'` không thoát. Ngày lưu vào cột `date` là phần ngày UTC của thời điểm đọc từ chuỗi ISO như `new Date()` của V8 (`parse_instant`: `YYYY`, `YYYY-MM`, dấu cách thay `T`, `±hhmm`, `24:00`, ngày 31 ở mọi tháng; golden `dates.json` sinh từ Node thật). Số ngoài `int4` ⇒ 400 (không lưu NULL, không xoá giá trị cũ); trang quá lớn ⇒ trang rỗng (nhân bão hoà). Khoá của `by_source`/`by_stage`/… theo chữ cái (Node theo thứ tự `GROUP BY`, không xác định).

### 4.13 Cấu hình

Giữ nguyên tên biến trong `.env.example`. Biến không còn dùng (`REDIS_URL`, `BACKEND_URL`, `MONOLITH_INTERNAL_URL`,
`AUTH_SERVICE_URL`, `TENANT_MAX_CLIENTS`, `TENANT_CONNECTION_LIMIT`, biến của kết nối đã gỡ) được bỏ qua kèm một dòng
cảnh báo lúc khởi động. Biến mới: `TLS_MODE` (`off | files`), `TLS_CERT_FILE`, `TLS_KEY_FILE`, `FACEBOOK_GRAPH_BASE_URL`,
`ZALO_OAUTH_BASE_URL`, `ZALO_OPENAPI_BASE_URL`, `ZALO_ZNS_BASE_URL` (thêm ở bản TS trước, G15), `DB_POOL_SIZE`, `WEB_DIR`, `NODE_FALLBACK_URL`, `TRINITY_OWNERSHIP_FILE`
(đường dẫn tệp sở hữu route và job; `TRINITY_RUST_ROUTES` chỉ là giá trị khởi tạo khi chưa có tệp),
`SHADOW_SAMPLE_RATE`, `WORKER_THREADS`, `TRINITY_HTTP_PORT`, `COMPAT_API_PORT`, `TRUSTED_PROXY`, `CLOUDFLARE_IP_RANGES`,
`SOCIAL_MAX_VIDEO_MB`, `WEB_BIND` (phía host của compose), `HOSTNAME` (địa chỉ nghe của Next, dùng cho tunnel),
`NODE_OPTIONS` phần web (nạp tệp ghi địa chỉ kết nối). Mỗi biến vào `.env.example` ở issue thêm nó (G15, G16a/b, X06). Kiểm bí mật không an toàn lúc khởi động như
`insecureSecrets()`. Cổng chính của binary đọc từ `TRINITY_HTTP_PORT` (mặc định 3000). Biến `PORT` của bản Node
(`PORT=4000` trong `.env.example`) thuộc nhóm bị bỏ qua kèm cảnh báo: nếu đọc nó, bản cài dùng lại `.env` cũ sẽ nghe
4000, trùng cổng tương thích và mất đích của luật reverse proxy "trang → 3000". Binary dừng với lỗi rõ khi cổng chính
trùng cổng tương thích.

**Xác định IP của khách** (dùng chung cho bản TS sau G16a/G16b và cho Rust ở K16). Kiểm IP chấm công ảnh hưởng tới
lương, kiểm Wi-Fi đăng nhập và các giới hạn tốc độ đều dựa vào IP này. Bản TS hiện đọc IP ở 7 chỗ theo 5 cách khác
nhau, có chỗ tin `cf-connecting-ip` vô điều kiện khi bật cờ, có chỗ tin `x-real-ip` hễ nguồn là loopback/mạng riêng
(mà sau Next hay sau Caddy/nginx thì nguồn luôn là vậy), có chỗ lấy phần tử đầu của `x-forwarded-for`; route handler
của Next chép nguyên header của client sang API. Thiết kế mới chỉ có ba ý:

1. **Một cấu hình tường minh duy nhất, `TRUSTED_PROXY`,** áp cho **peer TCP** của kết nối:

   | Giá trị | IP khách |
   |---|---|
   | `none` (mặc định) | IP peer. Không header nào được tin |
   | `cloudflare` | `cf-connecting-ip`, chỉ khi peer ∈ `CLOUDFLARE_IP_RANGES` (mặc định theo danh sách Cloudflare công bố, tài liệu ghi cách cập nhật); peer ngoài dải thì IP peer |
   | `cloudflare-tunnel` | `cf-connecting-ip`. Bắt buộc cổng ứng dụng chỉ nghe loopback: **tiến trình từ chối khởi động** nếu địa chỉ nghe không phải loopback (kể cả một IP cụ thể của máy hay của container) |
   | `cidr:<danh sách>` | Phần tử **phải cùng** của `X-Forwarded-For`, chỉ khi peer ∈ danh sách. Caddy luôn tự ghi phần tử này. **nginx thì không**: mọi `location` trỏ vào ứng dụng phải có `proxy_set_header X-Forwarded-For $remote_addr;` (ghi đè, không nối), thiếu là sai cấu hình và client giả được. Chỉ dùng `cidr:` khi thật sự có proxy phía trước và ứng dụng nghe loopback. Danh sách nhận từ khoá `docker-gateway` (giải từ `/proc/net/route`), vì dải mạng compose do Docker cấp và có thể đổi. `X-Real-IP` chỉ được đọc khi ghi tường minh `;header=x-real-ip` (Caddy mặc định và Cloudflare không ghi đè header này) |
   | `cloudflare-behind:<cidr proxy nội bộ>` | Cho đường Cloudflare → Caddy/nginx → ứng dụng (đường TLS chính của bản TS: Origin Certificate nằm ở Caddy/nginx). Khi peer ∈ cidr: lấy phần tử phải cùng của `X-Forwarded-For` (do proxy nội bộ ghi = địa chỉ đã nối tới nó); nếu phần tử đó ∈ `CLOUDFLARE_IP_RANGES` thì dùng `cf-connecting-ip`, không thì dùng chính phần tử đó. Mẫu Caddy: `trusted_proxies static <dải Cloudflare>`. Mẫu nginx: `proxy_set_header X-Forwarded-For $remote_addr;` + `proxy_set_header X-Real-IP "";`, **không** dùng `set_real_ip_from` một mình (mặc định `real_ip_header` là `X-Real-IP`, tức tin header client); nếu dùng thì bắt buộc kèm `real_ip_header CF-Connecting-IP` chỉ cho dải Cloudflare. Khuyên proxy chỉ nhận kết nối từ dải Cloudflare |

   **Cờ cũ không được ánh xạ ngầm.** `…_TRUST_PROXY_HEADERS=true` vốn dành cho proxy nối từ địa chỉ công khai,
   `…_TRUST_CF_IP=true` vốn dùng sau Caddy; ánh xạ máy móc sang giá trị mới sẽ khoá nhầm hoặc mở nhầm. Thấy cờ cũ mà chưa
   có `TRUSTED_PROXY` thì tiến trình dừng khởi động với thông báo liệt kê giá trị ứng với từng cách triển khai.
2. **Tiến trình nhận kết nối đầu tiên (tiến trình biên) xác định IP, một lần, ngay khi nhận header** (trước khi đọc
   body). Nó xoá mọi header IP do client gửi (`x-real-ip`, `x-forwarded-for`, `forwarded`, `cf-connecting-ip`,
   `x-trinity-*`) rồi truyền kết quả vào trong bằng `x-trinity-client-ip` có chữ ký: HMAC-SHA256 trên IP nối với thời
   điểm, khoá dẫn bằng HKDF từ bí mật nội bộ đang hiệu lực (`INTERNAL_SERVICE_SECRET`, rồi `SERVICE_SECRET`, cùng thứ tự
   với guard `@Internal`), hạn ±60 giây. Hai quy tắc về thời điểm, để body chậm không làm chữ ký hết hạn: bên gửi **ký
   ngay trước khi gửi header** sang tiến trình trong; bên nhận **kiểm ngay khi nhận header**, trong middleware đứng
   trước body-parser và multer, rồi lưu kết quả vào request. **Có header mà chữ ký sai hoặc quá hạn ⇒ trả 400**: đó là
   bất thường, không phải thiếu cấu hình, và không được "cho qua".

   | Cách triển khai | Tiến trình biên | `TRUSTED_PROXY` (đặt ở tiến trình biên) | Cần bí mật nội bộ ở |
   |---|---|---|---|
   | Trình quản lý tiến trình, Caddy/nginx cùng máy → Next → API | Next | `cidr:127.0.0.1/32` | Next, API |
   | Như trên, có Cloudflare phía trước Caddy/nginx | Next | `cloudflare-behind:127.0.0.1/32` | Next, API |
   | Compose, cổng `web` công bố thẳng | Next (`web`) | `none` | `web`, `api` |
   | Compose, Cloudflare nối thẳng cổng `web` | Next (`web`) | `cloudflare` | `web`, `api` |
   | Compose sau Caddy/nginx trên host (có hoặc không có Cloudflare) | Next (`web`) | `cidr:` hoặc `cloudflare-behind:` với cổng mặc định của mạng Docker; cổng công bố ở `127.0.0.1` | `web`, `api` |
   | Compose với Cloudflare Tunnel (tệp ghép `docker-compose.tunnel.yml`) | Next (`web`) | `cloudflare-tunnel`; không công bố cổng, `HOSTNAME=127.0.0.1`; cần Docker Compose ≥ 2.24; ingress có luật `/notif-ws` → `http://api:4000` | `web`, `api` |
   | Cấu hình lai (D01) | Rust | theo đường vào của Rust, như các dòng trên | `trinity`, `api`, và Next (để giữ header có chữ ký của Rust thay vì tự xác định lại) |
   | Sau X06 | Rust | như trên | không cần cho việc này |

   **Next làm biên thế nào.** Next 16 không cho route handler biết địa chỉ kết nối: nó chỉ điền `x-forwarded-for` từ
   socket khi client **không** gửi header đó (`next/dist/server/base-server.js` dòng 612). G16b thêm một tệp nạp trước
   (`NODE_OPTIONS=--require …`) bọc `http.createServer`: xoá `x-trinity-*` của client ở **mọi** request, xác định IP từ
   `socket.remoteAddress`, và đưa kết quả vào `AsyncLocalStorage`. Peer **không** đi qua header: nếu đi qua header thì
   bản cài quên tệp nạp trước (lệnh chạy của trình quản lý tiến trình nằm ngoài repo) sẽ để client tự khai peer. Route
   handler không thấy store ⇒ không đọc header nào, gửi dấu "không tin được" và ghi lỗi cấu hình. Tệp nạp trước cũng
   kiểm địa chỉ nghe cho `cloudflare-tunnel` và từ chối khởi động với bí mật mẫu.
3. **Không có IP tin được thì nói ra, không đoán.** Luật này áp lên **kết quả cuối, ở mọi giá trị `TRUSTED_PROXY`**:
   IP xác định ra là loopback, là cổng mặc định của container (nhận ra bằng tuyến mặc định trong `/proc/net/route`),
   hoặc mang dấu "không tin được" (thiếu tệp nạp trước, không có bí mật nội bộ) thì **không bao giờ** được coi là IP
   khách và không đem so với IP văn phòng. Ví dụ: `cidr:` ghi sai dải mạng Docker, hay Cloudflare nối origin bằng IPv6
   qua `docker-proxy` nên peer thành cổng mặc định. Địa chỉ IPv4-mapped (`::ffff:a.b.c.d`) được chuẩn hoá trước mọi so khớp. Khi đó kiểm Wi-Fi đăng nhập và kiểm IP chấm công **không tắt lặng lẽ** và **không khoá
   người dùng**: cho qua, ghi lỗi cấu hình vào log và hiện **dải cảnh báo trên mọi trang quản trị** cho tới khi sửa
   (hiện bản TS tắt lặng lẽ ở trường hợp loopback, `auth.service.ts` dòng 279–285). Giới hạn tốc độ khi đó dùng IP
   peer, tức một xô chung cho mọi khách: hạn chế này ghi rõ trong tài liệu. Khác với trường hợp chữ ký sai ở điểm 2,
   vốn bị từ chối.

**Đổi hành vi khi nâng cấp, phải nói rõ.** Bản cài theo tài liệu hiện tại (Caddy → Next → API, không đặt cờ) đang lấy
được IP thật qua Caddy (dù giả được). Sau G16a/G16b mặc định là `none`, peer là `127.0.0.1`, nên kiểm Wi-Fi và kiểm IP
chấm công ở trạng thái "cho qua + cảnh báo" cho tới khi quản trị đặt `TRUSTED_PROXY`. Vì chấm công ảnh hưởng lương:
`CHANGELOG` có mục "hành động bắt buộc khi nâng cấp", `install.sh` chỉ hỏi khi có tty và không sửa `.env` có sẵn, nên có thêm `scripts/migrate-env.sh` cho bản đang chạy; bản
chạy bằng trình quản lý tiến trình có cờ cũ sẽ không lên cho tới khi đặt `TRUSTED_PROXY` (bản Docker thì cờ cũ chưa
từng vào container, chỉ có cảnh báo); cổng sức khoẻ có một lời gọi `/api/v1/health` **qua Next** để lệch bí mật giữa
web và API (mọi request thành 400) làm deploy tự lui; API kiểm chữ ký với khoá dẫn từ cả hai bí mật mà guard `@Internal`
chấp nhận. Tài liệu nâng
cấp đặt đoạn Caddyfile/nginx cũ và mới cạnh nhau.

Mọi chỗ đọc IP chuyển về một hàm dùng chung (danh sách file và dòng ở issue G16a; tiêu chí là `grep` không còn chỗ nào
đọc header IP ngoài hàm đó, trừ thư mục test). Rust không tái tạo 7 cách cũ. G16a/G16b là sửa lỗi bảo mật (được phép
trong lúc đóng băng). Ca test bắt buộc ở cả hai bên: gửi thẳng cổng công bố kèm mọi loại header giả; chạy Next không có
tệp nạp trước; Caddyfile mặc định với `X-Real-IP` giả; Cloudflare giả → Caddy → ứng dụng; peer trong và ngoài dải
Cloudflare; tunnel với địa chỉ nghe không phải loopback; body nhỏ giọt 61 giây; hai client khác IP có bộ đếm riêng.
Tài liệu triển khai vẫn khuyên chỉ mở cổng origin cho dải IP của Cloudflare hoặc dùng Tunnel (lớp chặn thứ hai).

**Giới hạn của proxy Cloudflare** (gói Free/Pro, cả Tunnel): body request tối đa 100 MB, chờ origin tối đa 100 giây
(lỗi 524). Hai chỗ của bản hiện tại vượt: video đăng bài tới 200 MB qua multipart (`social.config.ts` dòng 57,
`POST /social/media`) và timeout 120 giây cho `/export`. Chốt:

- Trong đợt chuyển (giữ tương thích): giới hạn video đọc từ env `SOCIAL_MAX_VIDEO_MB` (mặc định 200 như hiện tại); bản
  cài sau proxy Cloudflare đặt 95, để người dùng nhận câu lỗi rõ của Trinity thay vì lỗi 413 của Cloudflare. Biến này
  thêm ngay ở bản TS (G15), vì `POST /social/media` còn do Node xử lý tới đợt e. Tới khi có tải theo phần (X15a), video
  trên 95 MB không tải lên được qua proxy; kế hoạch **không** gợi ý tên miền không bật proxy trỏ thẳng origin: làm vậy
  buộc mở origin cho mọi IP (phá lớp chặn ở trên), cần chứng chỉ công khai mà binary không tự xin, và web tải lên cùng
  origin nên còn cần CORS.
- X05 đo tệp xuất lớn nhất; đích dưới 100 giây.
- Sau X06 (không thuộc phạm vi tương thích): X15a tải video theo phần ≤ 50 MB (máy chủ + web); X15b chuyển các route
  xuất mà X05 đo được trên 60 giây sang chạy nền qua `platform.jobs` rồi tải về sau.

**Cổng tương thích 4000.** `docs/deployment.md` hiện bắt reverse proxy trỏ `/notif-ws` thẳng vào API ở cổng 4000 (Next
không chuyển tiếp WebSocket). Sau X06 không còn gì nghe ở đó và chuông realtime sẽ mất lặng lẽ. Binary vì vậy nghe
thêm một cổng tương thích cho `/notif-ws` và `/api/v1`, giữ tới hết bản phát hành lớn kế tiếp; tài liệu mới chỉ còn
một cổng. Chi tiết: biến riêng `COMPAT_API_PORT` (mặc định 4000) cho cổng binary nghe; `API_PORT` giữ nguyên nghĩa cũ là biến
**phía host** của compose (`127.0.0.1:${API_PORT:-4000}`), vì có người đã đổi nó và trỏ `/notif-ws` vào cổng đó; chỉ bật khi không còn Node (trong cấu hình lai Node đang giữ cổng 4000 trong cùng network namespace). Trong
container binary nghe `0.0.0.0:4000` và compose công bố `127.0.0.1:${API_PORT:-4000}` ở host (loopback của container không tới
được từ host); chạy ngoài Docker thì nghe loopback. Với `TRUSTED_PROXY=cloudflare-tunnel`, cổng tương thích chỉ nghe loopback hoặc tắt
(tunnel chỉ trỏ cổng chính), để khớp ràng buộc loopback ở trên. Trong cấu hình lai, `/notif-ws` đi qua Rust (D01). Cũng trong cấu hình lai, Next chung
network namespace với Rust nên đổi sang cổng nội bộ khác (`PORT=3001`) để không trùng cổng 3000 của Rust.

### 4.14 Strangler proxy và shadow

- Rust nghe cổng origin. Bộ đọc tệp sở hữu là một mô-đun dùng chung (K03) cho cả route (K17) và job (K20); luật khớp:
  **tiền tố dài nhất + phương thức**, vì có tiền tố lồng nhau thuộc hai đợt khác nhau (`settings` ở đợt a và
  `settings/channel-guard` ở đợt e; `public/auth` ở đợt b và `public/contacts` ở đợt e). **Tệp sở hữu** (`TRINITY_OWNERSHIP_FILE`, JSON) ghi chủ của từng nhóm route (tiền tố +
  phương thức → `rust | node`) và từng job (tên → `rust | node`), cùng chủ của migrate nền. Đổi sở hữu: ghi tệp mới
  (đổi tên nguyên tử) rồi gửi `SIGHUP` cho Rust; Rust nạp lại mà không rớt kết nối, socket hay request dở; Node tự đọc
  lại ở lượt tick kế. Tệp hỏng thì giữ bảng đang dùng và ghi lỗi. Biến môi trường không dùng được cho việc này: tiến
  trình không thấy giá trị env mới nếu không khởi động lại.
- Trong cấu hình lai, Node và Next **chỉ nghe loopback** và Rust gọi chúng qua loopback (issue D01). Trong compose
  điều này cần ba container dùng chung network namespace (`network_mode: service:trinity`), không phải mạng nội bộ
  thông thường của compose, để cổng của Node và Next không tới được từ ngoài. Vì chung namespace nên tên `api` không
  phân giải được: `web` dựng với `BACKEND_URL` và `MONOLITH_INTERNAL_URL` (nhúng lúc build vào rewrite `/.well-known`)
  = `http://127.0.0.1:4000`, và Rust chuyển `/uploads`, `/.well-known` thẳng sang Node.
- Phần thuộc Node được chuyển tiếp tới `NODE_FALLBACK_URL`: truyền body dạng stream không đệm (upload 200 MB), giữ
  nguyên từng byte (chữ ký webhook), chuyển nâng cấp WebSocket, giữ timeout 15 giây và 120 giây cho `/export` như
  route handler hiện tại (sau proxy Cloudflare giới hạn thật là 100 MB và 100 giây, mục 4.13).
- **Header IP:** trong cấu hình lai Rust là tiến trình biên (mục 4.13): xoá mọi header IP do client gửi rồi truyền IP
  đã xác định sang Node bằng `x-trinity-client-ip` có chữ ký. Next không còn là biên.
- **CORS:** lớp CORS của Rust không áp cho route thuộc Node (Node tự thêm); nếu cả hai cùng thêm, trình duyệt từ chối
  `Access-Control-Allow-Origin` hai giá trị.
- Cho tới khi K18 bật và W02b xong, đường không phải API (trang, `/uploads`, `/.well-known`) được chuyển tiếp tới Next
  hoặc Node. Cấu hình lai (D01) vì vậy **không cần web tĩnh**. Thứ tự triển khai trong lai: migrate (Prisma) → khởi
  động Node → thay binary Rust, vì Rust trả 503 cho công ty chưa migrate tới bản nó biên dịch cùng.
- **Đã làm ở K17** (`server/crates/trinity-http/src/strangler`): `OwnershipTable` (tệp `TRINITY_OWNERSHIP_FILE` luôn được giữ đường dẫn; tệp chưa có
  lúc khởi động thì dùng `TRINITY_RUST_ROUTES` làm giá trị khởi tạo, không lỗi, và `reload` nạp khi tệp xuất hiện; tệp có mà hỏng lúc khởi động thì
  lỗi, lúc `reload` thì giữ bảng cũ và ghi lỗi; `spawn_sighup_reloader`; `initial_from_routes_env`: danh sách tiền tố thuộc Rust), `NodeProxy`
  (stream không đệm, giữ nguyên byte, nâng cấp WebSocket hai chiều, timeout 15 giây tính từ lúc request gửi xong và 120 giây cho `/export`, cộng
  `body_idle` cắt khi một bên im lặng giữa hai mảnh body, 502/504 dạng Nest; pool hyper bỏ kết nối rảnh sau 4 giây, ngắn hơn `keepAliveTimeout` 5 giây của
  Node). Header: xoá `x-real-ip`, `x-forwarded-for`, `forwarded`, `cf-connecting-ip`, `true-client-ip`, `x-forwarded-proto/host/port`,
  `x-trinity-client-ip`, `x-trinity-peer-ip` và mọi header `Connection` liệt kê (cả response) của phía kia; đặt lại `x-forwarded-proto` theo listener thật,
  `x-forwarded-host` và `Host` theo host gốc (HTTP/2 lấy từ authority); gửi `x-trinity-client-ip` ký NGAY lúc gửi header. Định tuyến đích: chỉ `/api/v1`,
  `/notif-ws`, `/uploads`, `/docs` đi Node; `/.well-known/oauth-authorization-server` và `/oauth-protected-resource` được rewrite như `next.config` sang
  `/api/v1/oauth/...` rồi đi Node (Node không có `/.well-known`); còn lại (`/api/build-id`, `/api/fe-logging`, trang) đi Next nếu cấu hình `web`, không thì Node.
  `dispatcher`: `client_ip_layer` một lần ở ngoài cùng; lớp CORS và mọi lớp khác của Rust chỉ nằm trong router thuộc Rust nên route của Node chỉ có CORS của
  Node. Chưa nối vào binary vì chưa có lệnh `serve`; biến cho địa chỉ Next (`web`) và `ListenerScheme` thêm khi nối.
- **Shadow:** chỉ cho route có `safe_for_shadow = true` trong `routes.json` (mặc định `false`; bật từng route sau khi
  rà mã là thuần đọc). Sau khi đã trả response của Node, theo tỉ lệ lấy mẫu, Rust tính response của mình với ba hàng
  rào: (1) phiên DB chỉ đọc, đặt ở mức phiên khi lấy kết nối cho shadow (`default_transaction_read_only = on`), vì
  `TenantDb` lấy kết nối theo nhu cầu chứ không bọc cả handler trong một giao dịch; (2) HTTP client ra ngoài được thay
  bằng client từ chối mọi request; (3) cache đếm/dashboard của Rust bị bỏ qua. Riêng route có cache đọc (`cached: true`
  trong `routes.json`: đếm khách, dashboard, số liệu "hôm nay"): response của **Node** vẫn có thể đến từ cache tới 60
  giây, nên trên lưu lượng thật chỉ so hình dạng, không so số; so chặt các route này làm ở X13, nơi cache tắt ở cả hai
  bên (Node bằng `TRINITY_DISABLE_READ_CACHE`, thêm ở G12a). Handler vi phạm (1) hoặc (2) được ghi "không shadow được" và không thử lại. Hai response
  được chuẩn hoá rồi so; chỉ ghi: đường dẫn mẫu (id thay bằng `:id`), mã trạng thái hai bên, danh sách đường dẫn JSON
  khác nhau, và số mẫu theo route. Không ghi giá trị (tránh đưa dữ liệu khách vào log).

## 5. Web: xuất tĩnh

Đích: `next build` với `output: 'export'`, kết quả nhúng vào binary; giao diện React giữ nguyên.

| Chỗ phải sửa | Hiện tại | Sau |
|---|---|---|
| Middleware `src/proxy.ts` | Chuyển hướng `/` → `/dashboard` hoặc `/login` theo cookie; chặn trang cần đăng nhập; header `no-store`; rewrite subdomain trang bán hàng | Rust làm đúng các luật này khi phục vụ HTML (đọc cookie `access_token` / `has_session`), gồm cả rewrite `<tên>.<STORE_DOMAIN>` → `/s/<tên>` |
| `app/api/v1/[...path]/route.ts` | Proxy tới monolith (hoặc chạy Nest trong function) | Xoá; trình duyệt gọi `/api/v1` cùng origin |
| `app/uploads/[...path]/route.ts` | Proxy file | Xoá; Rust phục vụ |
| `app/api/build-id/route.ts` | Đọc `.next/BUILD_ID` | Rust trả build id nhúng lúc build |
| `app/api/fe-logging/route.ts` | Đẩy log trình duyệt sang Elasticsearch | Bỏ (theo quyết định về log); lỗi trình duyệt đã có đường Sentry tuỳ chọn |
| `rewrites` (`/.well-known/oauth-*`) | Next rewrite sang monolith | Rust trả trực tiếp ở gốc |
| `redirects` (`/assistant` → `/settings?tab=integrations`) | Next | Rust |
| `headers` (CSP `frame-ancestors 'none'` cho `/oauth/authorize`; cache ảnh 1 ngày; `/_next/static` immutable) | Next | Rust |
| 8 trang có đoạn động: `contacts/[id]`, `projects/[id]`, `x/[objectKey]`, `x/[objectKey]/[id]`, `x/[objectKey]/new`, `x/[objectKey]/v/[viewKey]`, `invite/[token]`, `s/[slug]` | Render theo request | Xem dưới |
| `export const dynamic = "force-dynamic"` ở 5 file: `not-found.tsx`, `s/[slug]/page.tsx`, `build-id`, `privacy/page.tsx`, `terms/page.tsx` | Next từ chối xuất tĩnh trang `force-dynamic`; cấu hình này phải là hằng số nên không bật tắt theo biến build | Ba file đầu: bỏ. `/privacy`, `/terms`: W02a thêm **tệp trang riêng cho bản xuất** (chọn bằng `pageExtensions` lúc `build:export`), đọc giá trị pháp lý do Rust chèn vào HTML (K18, để trình thu thập của Meta thấy tên đơn vị mà không cần chạy JS) và lùi về `/site-config`; bản `standalone` giữ trang đọc env tới W03 |
| `next/image` (2 file import) | Tối ưu ảnh ở máy chủ | `images.unoptimized = true` |
| `next/font/google` (Inter, Montserrat) | Tải lúc build | Giữ; font nằm trong bản xuất |
| Trang `/privacy`, `/terms` đọc `process.env.LEGAL_*` lúc render | Env lúc chạy | Lấy từ `GET /api/v1/site-config` (public) để một binary dùng được cho nhiều bản cài. Cùng đường này trả các cờ hiện là biến lúc build: `NEXT_PUBLIC_REALTIME_MODE`, `NEXT_PUBLIC_DS_V2` (cờ sau hiện là hằng số module, `design-system-flags.ts`: phải nạp cấu hình trước lần vẽ đầu) |
| `NEXT_PUBLIC_API_URL` | Nhúng lúc build | Cố định `/api/v1` |
| Phụ thuộc `@trinity/monolith`, `lib/nest-bridge.ts`, `nest-loader*.ts`, `serverless-runtime.ts`, `uploads-blob.ts`, `vercel.json` | Đường serverless | Xoá (G11) |
| CI web dựa trên `.next`: `scripts/route-js-size.mjs` + `route-js-budget.json`; `webServer` của Playwright chạy `next start` | | Đọc từ `out/`; Playwright chạy trên binary (W02a, W04) |
| `app/page.tsx` gọi `redirect("/login")` ở máy chủ | | Rust xử lý `/` |

**Route động.** Xuất tĩnh đòi `generateStaticParams` cho mọi đoạn động. Hai phương án, chốt bằng spike R004 (tối đa
2 ngày, tiêu chí: tải thẳng URL sâu, điều hướng trong app, nút quay lại, prefetch, `next build` không cảnh báo). Spike
thử 4 trang, gồm hai trường hợp khó nhất: `s/[slug]` qua **tên miền phụ** (URL trình duyệt là `/` nhưng nội dung là
trang cửa hàng, nên `usePathname()` không cho slug: Rust chèn slug vào HTML bằng thẻ `<meta>` hoặc khối JSON khi phục
vụ qua tên miền phụ) và `invite/[token]` (token mời không được chuyển sang query, nơi dễ lọt vào log; bộ lọc log cũng
che `token`, `code`, `state` trong query):

- **A, giữ URL:** xuất một trang giữ chỗ cho mỗi route động; Rust trả trang đó (và payload điều hướng tương ứng) cho
  mọi giá trị; component đọc tham số từ `usePathname()` thay vì `params`. Không đổi URL, nhưng phụ thuộc chi tiết
  nội bộ của App Router.
- **B, đổi sang query:** `/contacts/view?id=123`; Rust chuyển hướng URL cũ sang URL mới để link đã lưu
  (thông báo, `review_url` của MCP) vẫn chạy. Thuần tĩnh, chắc chắn, đổi URL hiển thị.
- Nếu cả hai không đạt: thay bộ định tuyến bằng SPA thuần (Vite + router phía trình duyệt), giữ nguyên component.
  Khối lượng: 89 câu import `next/link`/`next/navigation`, 6 `next/dynamic`.

**Quyết định R004 (27/11/2026): chọn A, giữ URL.** Spike dựng bản xuất tĩnh `next@16.3.8` + `react@19.2.4` (đúng phiên bản của web)
với 4 trang mô phỏng, chạy bằng máy chủ nhỏ đóng vai Rust, đo bằng Chrome thật (Playwright). Mã thử ở nhánh
`spike/r004-xuat-tinh-route-dong` (không merge). `next build` không cảnh báo ở cả hai phương án.

| Trang | Phương án | URL sâu | Điều hướng | Quay lại | Prefetch | Build sạch |
|---|---|---|---|---|---|---|
| `contacts/[id]` | A | đạt | đạt | đạt | đạt (không 4xx) | đạt |
| `x/[objectKey]/v/[viewKey]` | A | đạt | đạt | đạt | đạt | đạt |
| `s/[slug]` (`/s/<tên>`) | A | đạt | đạt | đạt | đạt | đạt |
| `s/[slug]` (tên miền phụ, URL `/`) | A + slug trong `<meta>` | đạt | không áp dụng | không áp dụng | không áp dụng | đạt |
| `invite/[token]` | A | đạt | đạt | đạt | đạt | đạt |
| cùng 4 trang | B (query; token ở `#fragment`) | đạt | đạt | đạt | đạt | đạt |

Điều kiện để A chạy (đều đã kiểm):

- `generateStaticParams` trả một giá trị giữ chỗ `_` cho mỗi đoạn, kèm `dynamicParams = false`; bản xuất sinh `a/contacts/_.html` và các tệp
  `__next.*.txt` đi kèm.
- Rust thay **mọi** đoạn động trong đường dẫn bằng `_` trước khi tìm tệp, gồm cả các yêu cầu payload
  (`/contacts/123/__next._tree.txt`, `/contacts/123/__next.contacts.$d$id.__PAGE__.txt`) và yêu cầu `HEAD` của prefetch.
  Bảng luật (mẫu đường dẫn → giữ chỗ) sinh từ kết quả build, không viết tay.
- Component đọc tham số bằng `usePathname()` và **chỉ sau khi mount** (`useEffect`); đọc ngay lúc vẽ gây lỗi hydrate React #418
  vì HTML là trang giữ chỗ. `useParams()` / `use(params)` sẽ trả `_`, nên 8 trang động phải sửa chỗ này (W02a).
- Tên miền phụ cửa hàng: Rust trả trang `s/_` cho `/`, chèn slug vào `<meta name="store-slug">` trong HTML; component đọc thẻ này
  trong `useEffect` (đọc lúc vẽ cũng gây lỗi hydrate). Đọc thẻ lúc vẽ không dùng được.
- Token mời nằm trong đường dẫn như hiện nay, nên bộ lọc log của Rust phải che đoạn `/invite/<token>` (kể cả trong yêu cầu payload).
  Phương án B giữ token ngoài log bằng `#fragment` nhưng đổi URL mời đã gửi đi.

Rủi ro còn lại của A: đặt tên tệp payload (`__next.<route>.$d$param...`) là chi tiết nội bộ của Next. Giảm bằng cách ghim phiên bản
`next` và để W04 (Playwright trên binary) kiểm URL sâu + điều hướng cho 8 trang động mỗi lần nâng cấp. Nếu một lần nâng cấp làm A
vỡ, chuyển sang B theo thứ tự: đổi sang query, Rust chuyển hướng URL cũ. Chưa đo: `useParams()` trả giá trị gì trong bản xuất,
lượng payload prefetch của A so với B, và 4 trang còn lại trong 8 (`projects/[id]`, `x/[objectKey]`, `x/[objectKey]/[id]`,
`x/[objectKey]/new`) cùng mẫu với `contacts/[id]` nên suy ra, không đo riêng.

**Thứ tự merge để `main` luôn chạy được** (không vòng phụ thuộc):

1. D01: Rust đứng trước, chuyển tiếp cả trang web sang Next. Không cần web tĩnh.
2. W01: web chạy được cả sau Rust lẫn kiểu cũ; **giữ** route handler `/api/v1/[...path]`, `/uploads`, `/api/build-id`.
3. W02a: thêm lệnh `build:export` **song song** với bản `standalone`; `proxy.ts` còn nguyên, bản đang chạy không đổi.
4. K18: Rust phục vụ `out/` nhúng; bật bằng dòng `web: rust` trong tệp sở hữu, lui bằng `web: node`.
5. W04: Playwright trên web do Rust phục vụ.
6. W02b: bỏ `standalone`, `proxy.ts`, route handler và Next server. Là PR đầu của chồng **W02b → W03 → X06**: trong đồ thị nó
   phụ thuộc mọi thứ X06 chờ (X03, X04, X05, X09, X10, X14), nên sau nó chỉ còn W03 và X06, merge liền nhau trong cùng
   một bản phát hành. `main` vì vậy không có lúc nào thiếu cả Next lẫn image `trinity`, và không phải khoá bản sửa lỗi.
7. W03: web đọc cấu hình lúc chạy từ `GET /site-config`. Đi sau W02b vì endpoint này chỉ có ở Rust: nếu merge sớm,
   bản phát hành chạy compose cũ (và cấu hình lai chưa giao route này cho Rust) sẽ mất tên đơn vị, mã số thuế, email
   trên `/privacy` và `/terms`, là các trang Meta đòi. Trước đó trang pháp lý vẫn render ở máy chủ Next từ env.

Lý do giữ route handler và bản `standalone` tới sát X06: repo phát hành image `trinity-web` ở mỗi tag, và người tự cài
bằng compose hiện tại gọi `/api/v1` qua route handler của Next. Xoá sớm thì bản phát hành kế tiếp (đóng băng tính năng
vẫn cho sửa lỗi, tức vẫn có bản phát hành) làm mọi bản cài Docker mất API suốt 4–5 tháng giữa W01 và X06. Cấu hình lai
(D01) chỉ dành cho bản do người vận hành tự dựng từ `main`; người tự cài chuyển một lần, ở X06, theo tài liệu nâng cấp.

Nhúng: `apps/web/out` nén sẵn (brotli, gzip) nhúng bằng `rust-embed`; `WEB_DIR` trỏ ra thư mục ngoài để vá web mà
không build lại binary.

## 6. Chiến lược test

### 6.1 Hợp đồng đóng băng (`server/contracts/`)

| File | Sinh từ | Dùng để |
|---|---|---|
| `routes.json` | `auditRoutes()` của Nest + metadata decorator + bảng lenient/strict. Mỗi route: phương thức, đường dẫn, loại truy cập, quyền, chế độ validation, `status_ok`, `org_feature`, `guards`, `raw_response`, `param_pipes`, `transforms`, `upload`, `shape_permissions`, `safe_for_shadow`, `cached`, `min_samples`, `deprecated` | Cổng CI: Rust phải khớp mọi cột; cũng là nguồn sinh ca test và danh sách shadow |
| `openapi.json` | `SwaggerModule.createDocument` | DTO request, tài liệu; so với OpenAPI do `utoipa` sinh (đường dẫn, phương thức, tham số) |
| `mcp/tools.json`, `mcp/instructions.txt`, `mcp/transport/*.json` | `tools/list` và các phản hồi vận chuyển thật của Node | Rust phục vụ nguyên văn |
| `rbac.json`, `events.json` | `packages/rbac`, `event-catalog.ts` | Nguồn chung |
| `schema.sql` | `pg_dump --schema-only` đã chuẩn hoá của `public` sau khi migrate, cộng `platform` và trigger đồng bộ | Phát hiện lệch schema |
| `golden/**` | Response đã chuẩn hoá ghi từ Node | Trước X06: để xem diff khi review, chuẩn so là kết quả Node của cùng lượt chạy. Từ X06: là chuẩn so (bản ghi lần cuối ở X03) |

Mỗi file trừ `golden/**` có job CI "sinh lại và so" để không lệch âm thầm.

### 6.2 Test hợp đồng HTTP hộp đen

- **Công cụ:** TypeScript trên `vitest` (đã có trong repo), chỉ dùng `fetch` tới `BASE_URL`; không import mã backend.
  Thư mục `tests/contract/`.
- **Chuyển 341 ca e2e hiện có (345 trừ 4 ca chương trình con) là viết lại phần dàn dựng, không chỉ thay lớp vận
  chuyển.** Các spec hiện gọi vào trong tiến trình: 23 lời gọi `app.get(<Service>)` (chạy `WebhookDispatcherService.tick()`,
  `AiActionExpiryService.runOnce()`, `RbacCache.invalidateUsers`, lấy client Redis để xoá khoá giới hạn tốc độ…) và 362
  lời gọi Prisma để seed và sửa DB giữa ca. Ba thứ thay thế:
  1. **API điều khiển test** (C18 phía TS, K34 phía Rust), cần `x-service-secret`:
     `POST /internal/test/jobs/:name/run` (chạy một lượt một job cho một công ty) và
     `POST /internal/test/cache/flush` (cache quyền, đếm, dashboard, blacklist, giới hạn tốc độ).
     **Không có giờ giả toàn cục.** Backend TS đọc đồng hồ thật ở 406 chỗ trong 127 file, cộng `now()` trong SQL; một
     đồng hồ giả mà Rust tuân theo ở mọi handler còn Node chỉ tuân ở vài hàm sẽ làm hai bên lệch ở chính chỗ không liên
     quan. Tham số `now` của `jobs/:name/run` chỉ có cho **đúng hai việc mà mã hiện đã nhận giờ làm đối số**
     (`reapStuckProcessing(NOW)` trong `notification-reaper.e2e-spec.ts`, `BriefingAggregatorService.collect(…, NOW)`
     trong `deals-won-date.e2e-spec.ts`), và Rust cũng chỉ dùng nó ở đúng hai đường đó.
     **Bật API điều khiển thì không có lịch tự động nào chạy** (mọi `setInterval` của job, `@Cron` thông báo, migrate
     nền; phía Rust là scheduler K20 và worker K21): job chỉ chạy khi ca test gọi. Lý do: e2e hiện tại khởi động app
     khi cờ tính năng còn tắt nên worker không tự chạy (`webhooks-out.e2e-spec.ts` dòng 40–41), còn máy chủ hộp đen ở hồ
     sơ `default` bật cờ từ đầu; các ca như "lỗi 500 không gửi lại trước hạn", "chạy trùng không tạo delivery đôi" chỉ
     đúng khi không có lượt tự chạy xen vào.
     **Chỉ tồn tại ngoài production:** bản TS chỉ đăng ký route khi `TRINITY_TEST_HOOKS=1` và `NODE_ENV` khác
     `production`; bản Rust chỉ biên dịch route khi bật cờ `test-hooks`, binary phát hành không có mã này. Có ca test
     khẳng định 404 ở cấu hình production. API này **không** có đường đổi cấu hình lúc chạy.
  2. **Seed và sửa DB bằng SQL** qua `pg` (`tests/contract/db.ts`), dùng chung cho cả hai bên.
  3. Ca "sửa quyền trong DB rồi gọi lại" gọi xoá cache qua API điều khiển (cache quyền của Rust có TTL 60 giây).
  4. **Hồ sơ cấu hình** thay cho 39 chỗ đổi `process.env` giữa ca (42 trừ 3 của file chương trình con): bộ chạy khởi
     động máy chủ một lần cho mỗi hồ sơ trong `tests/contract/profiles/*.env` và gom ca theo hồ sơ. Hồ sơ ban đầu:
     `default`; `integrations-off`; `no-secret-key`; `bad-secret-key`; `no-public-base-url`; `private-targets`;
     `restricted-origins`; `production`. Hồ sơ `production` (kiểm "production từ chối địa chỉ nội bộ") không có API điều khiển, nên ca của nó
     chỉ seed bằng SQL và không chạy job. Bảng ánh xạ từng chỗ đổi env → hồ sơ nằm trong PR của C12a–C13b.
  5. Các lời gọi hàm nội bộ còn lại được xử lý từng ca và ghi rõ trong issue: `DeliveryService.createLog` → chèn dòng
     bằng SQL; `OauthTokenService.verifyAccessToken` → gọi MCP bằng chính token đó; `IntegrationAuditService.log`
     (kiểm che số điện thoại trong audit) → chuyển thành bảng ca dùng chung TS/Rust cho hàm che. Tiêu chí "N ca đạt"
     tính số ca đã chuyển và liệt kê ca bị chuyển loại.
- **Môi trường:** mỗi lần chạy dùng DB Postgres riêng, đã migrate và seed với **thời gian tương đối**
  (`now() - interval '…'`) cho mọi bảng mà response tính theo "hôm nay" (xu hướng dashboard lùi từ hôm nay, số ngày còn
  lại của hợp đồng, thống kê hôm nay, chấm công, việc treo); công ty thứ hai tạo qua API đăng ký
  để mọi ca đa công ty đi đường thật. `TZ=UTC` cho cả tiến trình máy chủ và test. Graph API và Zalo thay bằng máy chủ
  giả cục bộ (C06b), trỏ tới bằng 4 biến env địa chỉ gốc. Các biến này **chưa có** trong mã (URL đang viết cứng ở
  `graph-client.ts` dòng 79, `facebook.provider.ts` dòng 231, `facebook-first-comment.ts` dòng 22,
  `zalo-oa.config.ts` dòng 7–13): issue G15 thêm, và là phụ thuộc của C06b.
- **Nguồn ca test:** (1) 25 file e2e hiện có; (2) sinh từ `routes.json`: mỗi route ít nhất một ca thành công (đúng
  `status_ok`), một ca thiếu quyền (401/403), một ca tắt tính năng (403) nếu có `org_feature`, một ca body sai (400),
  một ca tham số đường dẫn sai, và với route có phạm vi, một ca "ngoài phạm vi theo id" (404); (3) payload webhook mẫu
  có chữ ký từ các spec hiện có; (4) kịch bản MCP từ `tests/mcp-e2e`.
- **Ba vai cho route đọc dữ liệu khách:** golden ghi cho Quản trị, Trưởng nhóm, Sale. Hình dạng response đổi theo
  quyền (ví dụ `contacts.phone_full` quyết định số điện thoại đầy đủ hay bị che); các quyền như vậy được liệt kê ở cột
  `shape_permissions`. Thiếu điều này, Rust trả số điện thoại đầy đủ cho Sale vẫn "đạt".
- **So response có trường động:** bộ chuẩn hoá thay bằng nhãn ổn định: id số theo thứ tự xuất hiện (`<id:1>`), thời
  điểm gần "bây giờ" (`<now>`), ngày Việt Nam tương đối (`<vn-day:0>`, `<vn-day:-1>`, ±N) và số ngày tương đối, token
  và bí mật (`<token>`; con trỏ phân trang **không** thuộc loại này, so từng byte sau khi thay id), mã tự sinh theo mẫu, UUID, thứ tự phần tử ở mảng được
  khai là không có thứ tự. So theo nghĩa JSON (không theo thứ tự khoá). File nhị phân so theo nội dung đã giải mã:
  xlsx → giá trị ô và định dạng số/ngày của ô (không so kiểu chữ, màu), pdf → văn bản và số trang, ảnh → định dạng và
  kích thước.
- **Mức so thông điệp lỗi:** mã trạng thái và hình dạng luôn so chặt; chuỗi `message` so nguyên văn khi là tiếng Việt
  (web hiển thị nguyên câu), so lỏng (chỉ kiểm có và đúng trường) khi là câu mặc định tiếng Anh của class-validator
  (web không hiển thị). Quyết định này bỏ được việc tái tạo khoảng 1.600 thông điệp mặc định (2.036 decorator trừ 414
  cái có `message` riêng).
- **So trạng thái DB:** sau mỗi kịch bản ghi, dump các bảng liên quan, chuẩn hoá, so Node với Rust (bắt được
  `updated_at` thiếu, cột mặc định, dòng audit, sự kiện outbox).
- **Chạy:** so Rust với Node **trong cùng một lượt chạy**: chạy bộ ca trên Node, giữ kết quả đã chuẩn hoá, chạy trên
  Rust rồi so ngay. Golden commit trong repo chỉ để người review xem diff, không phải chuẩn so, nên không đỏ theo ngày.
  **Từ X06** không còn Node để so cùng lượt. Golden ghi ở giai đoạn 2 có thể đã lệch bản Node cuối cùng (bản TS còn
  nhận sửa lỗi, và X12a–e đưa một số khác biệt vào danh sách cho phép), nên X03 **ghi lại golden từ Node lần cuối** sau
  X12e, áp danh sách cho phép, rồi mới đóng băng (cách ghi đã được C06a chứng minh ổn định qua hai ngày nhờ seed tương
  đối và nhãn `<vn-day>`). Golden đó trở thành chuẩn so của bộ hợp đồng; đổi golden từ đó là đổi hợp đồng,
  phải nêu trong PR. Bản sửa lỗi TS nào còn merge sau X03 (kể cả bảo mật) phải ghi lại golden của route liên quan
  trong cùng PR.
  Bộ chạy từ chối bắt đầu trong khung 16:50–17:10 UTC (quanh nửa đêm Việt Nam). Hồ sơ `production` phía Rust chạy trên
  binary phát hành (bản thường chạy hợp đồng là bản có cờ `test-hooks`). Tiêu chí lặp lại của C06a: chạy 3 lần, ở hai
  ngày khác nhau, kết quả đã chuẩn hoá giống hệt.

### 6.3 Test trong Rust

- Unit: hàm thuần (fold_vi, số điện thoại, giờ VN, chữ ký, mã hoá, tính lương, thuế, luật lặp bài, UTM, CSV). Các spec
  TS của hàm thuần được chuyển thành bảng ca dùng chung (JSON) để hai bên chạy cùng dữ liệu.
- Test pg (Postgres 16 thật trong CI): cô lập công ty (chuyển `tenant-isolation.pg.spec.ts`, `saas-abuse.pg.spec.ts`,
  `invitations.pg.spec.ts`), migrator, phạm vi quyền, hạn mức nguyên tử, hàng đợi.
- Snapshot bằng `insta` cho JSON của MCP.
- Fuzz (`cargo fuzz`, chạy đêm): bộ đọc JSON-RPC, bộ kiểm chữ ký, bộ đọc payload webhook, bộ đọc CSV.

### 6.4 MCP

- `tests/mcp-e2e/run.mjs` (client MCP thật + OAuth DCR + PKCE) và `run-roles.mjs` chạy được với mọi `MCP_BASE`: chạy
  trên Rust không cần sửa.
- Test bằng model: `tests/mcp-e2e/claude-code-roles.mjs` chạy một bộ nhiệm vụ cố định trên Node và trên Rust. Kết quả
  của model không tất định, nên **tiêu chí cứng** chỉ là: 0 lời gọi tool bị từ chối vì schema. Tỉ lệ hoàn thành nhiệm
  vụ là số tham khảo: chạy 5 lần mỗi bên, Rust nằm trong khoảng dao động của Node.
- So `tools/list` từng byte với bản đóng băng.

### 6.5 Shadow và tiêu chí bật một đợt

Một đợt module được bật trên bản đang chạy khi đủ **cả bảy**:

1. 100% ca hợp đồng của các module trong đợt đạt trên Rust; độ phủ route = 100% theo `routes.json`.
2. So trạng thái DB của các kịch bản ghi: không khác biệt ngoài danh sách cho phép đã ghi lý do.
3. Shadow chạy ít nhất 48 giờ trên lưu lượng thật **và** mỗi route `safe_for_shadow` đạt `min_samples` (mặc định 50;
   route được ghi "không áp dụng" phải có lý do). Route chưa đủ mẫu được quét bù trên bản sao dữ liệu thật (X13):
   khôi phục bản dump vào máy riêng, cho Node và Rust cùng đọc, duyệt GET với id lấy từ DB. Tỉ lệ khác biệt = 0 sau khi
   trừ danh sách cho phép.
4. Mọi module **có đường ghi** trong đợt (không riêng lương, POS, gửi tin) chạy 24 giờ ở một công ty thử trên bản thật.
5. **Có bản dump toàn bộ DB (mọi schema) và bản chụp thư mục `storage`/`uploads` lấy ngay trước khi đổi sở hữu.**
   Quy trình hiện tại chỉ dump khi có migration; đợt bật đổi toàn bộ đường ghi mà không có migration nào. Dump là mốc
   để đối chiếu và sửa có chọn lọc (mục 6.6), không phải để khôi phục đè.
6. Bộ nhớ đỉnh của tiến trình Rust trong lúc chạy bộ hợp đồng không vượt ngưỡng (mục 9).
7. Có lệnh lui đã thử: ghi tệp sở hữu trả route và job của đợt về Node, gửi `SIGHUP`, ca smoke đạt trên Node.

Trong suốt giai đoạn lai, **bộ kiểm bất biến dữ liệu** (X11) chạy hằng ngày, và **mỗi giờ trong 72 giờ đầu của mỗi
đợt** để cửa sổ dữ liệu sai (nếu có) ngắn: số dòng theo bảng không giảm bất thường,
`updated_at` không lùi, mã tự sinh không trùng, JSON trong các cột Json đọc được bằng bộ đọc của bản TS. Đỏ thì dừng
bật đợt tiếp theo.

### 6.6 Lui không mất dữ liệu

- **Lui là đổi đường chạy, không phải quay ngược dữ liệu.** Ghi tệp sở hữu trả route và job của đợt về Node rồi
  `SIGHUP`; không tiến trình nào khởi động lại. Làm được vì DB tương thích hai chiều suốt giai đoạn lai: không
  migration phá huỷ, hash mật khẩu và token theo định dạng cũ, bảng mới chỉ nằm ở `platform`, và mọi dòng Rust ghi phải
  đọc được bằng mã Node (so trạng thái DB ở C16, bộ kiểm bất biến X11 có mục "JSON đọc được bằng bộ đọc của bản TS").
- **Không khôi phục đè bản dump lên DB đang chạy.** Tiêu chí bật đợt cần 48 giờ shadow và 24 giờ công ty thử; lỗi ghi
  có thể lộ sau 1–3 ngày, trong lúc mọi module (cả phần Node) vẫn ghi vào cùng DB. Khôi phục cả DB sẽ xoá đơn, chấm
  công, tin nhắn của mọi công ty trong khoảng đó, trái nguyên tắc không xoá dữ liệu khách hàng.
- **Sửa dữ liệu sai có chọn lọc:** khôi phục bản dump của đợt vào một DB riêng; so theo bảng và dòng mà module của đợt
  ghi (danh sách bảng theo module nằm trong runbook X01); viết script sửa đúng các dòng lệch; chạy script trong một
  giao dịch có đếm số dòng trước và sau. X01 diễn tập quy trình này một lần.
- Tuỳ chọn cho bản cài cần khôi phục theo thời điểm: lưu WAL (PITR), có hướng dẫn trong X01; không bắt buộc.
- Toàn bộ: tệp sở hữu về "mọi thứ thuộc Node", hoặc trỏ origin thẳng về Next + Node như cũ. Giữ bản build Node sẵn
  sàng cho tới hết 14 ngày sau X06.

## 7. Lộ trình

| Giai đoạn | Nội dung | Issue | Ngày-agent theo cỡ | Điểm dừng an toàn sau giai đoạn |
|---|---|---|---:|---|
| 0. Chuẩn bị | Đo baseline (cả cấu hình lai), kiểm kê dữ liệu, 3 spike | R001–R006 | 4 | Chưa đổi gì ở bản chạy |
| 1. Gỡ kết nối trên TS | Mục 2; bỏ Redis; `NOTIFY`; env địa chỉ gốc Graph/Zalo; sửa cách xác định IP khách | G01–G16b | 23 | **Có.** Bản TS gọn hơn, tự nó là một bản phát hành |
| 2. Đóng băng hợp đồng | Xuất hợp đồng, API điều khiển test, khung hộp đen theo hồ sơ, chuyển e2e, phủ 100% route | C01–C18 | 31,5 | **Có.** Bản TS có bộ test hộp đen, hữu ích kể cả khi dừng |
| 3. Nền Rust | Workspace, CI, DB, auth, RBAC, HTTP, proxy, job, lưu trữ, realtime, cổng sự kiện/thông báo, **triển khai cấu hình lai**, rồi web tĩnh | K01–K36, D01, T01, W01–W05 | 38 | **Có, sau D01.** Rust đứng trước làm proxy + phục vụ web tĩnh; mọi API vẫn do Node xử lý |
| 4. Module | 66 issue module + 10 issue bật đợt và sửa lệch | M01–M57, X02a–e, X12a–e | 98 + 10,5 (thực tế 140–190 cho phần module, mục 11) | **Có, sau mỗi đợt.** |
| 5. Chuyển hẳn | Shadow đủ mẫu, đo tải, rà bảo mật, thử nâng cấp bản cài Docker, gỡ Node/Redis, tài liệu | X01, X03–X11, X13, X14, X15a, X15b | 14,5 | Đích (X15a, X15b làm sau X06) |

Giai đoạn 2 (trên TS) và giai đoạn 3 (trên Rust) chạy chồng nhau. Giai đoạn 2 không chờ G07b/G08 (mục 2.4).

"Điểm dừng sau giai đoạn 3" chỉ có thật khi có thứ để triển khai: issue D01 tạo compose lai và hướng dẫn cho bản chạy
bằng trình quản lý tiến trình (tải binary từ artifact CI theo commit, đối chiếu SHA-256; chữ ký cosign chỉ có từ X08;
cổng sức khoẻ cho ba tiến trình; lui). D01 không phụ thuộc web tĩnh; thứ tự D01 → W01 → W02a → K18 → W04 → W02b ở
mục 5. Đồ thị phụ thuộc của toàn bộ 186 issue được kiểm bằng `docs/rust/check-issues.py`: không vòng, không tham chiếu
thiếu; các chuỗi dài nhất ghi ở cuối ISSUES.md.

Thứ tự bật module (đợt): (a) health, telemetry, settings, tuỳ chọn; (b) cụm auth + users + roles (cùng lúc, vì dùng
chung state phiên; từ đây Rust tạo schema cho công ty mới); (c) contacts, deals, kanban, bảng tuỳ biến, báo cáo;
(d) nhân sự, chấm công, lương, bán hàng, trang bán hàng, thông báo (chuyển cả job của các module này); (e) tích hợp,
OAuth, MCP, rồi Facebook, Zalo, đăng bài: **mọi route, job và tool MCP gọi Graph/Zalo ra chuyển trong cùng một lần đổi
sở hữu**.

**Đã làm ở M46** (`server/crates/mod-facebook`): Graph client (`graph.rs`, một chỗ duy nhất gọi Meta; token ở header
`Authorization`, không ở URL; mọi kết quả trừ lỗi kết nối báo `GraphOutcome` cho `ChannelGuard::record_graph` của M45), URL Graph
đọc `FACEBOOK_GRAPH_BASE_URL` mỗi lần gọi (chỉ `https://`, hoặc `http://` tới loopback), `state` OAuth ký HMAC giống bản Node,
kết nối Fanpage (`pages.rs`: token mã hoá bằng `INTEGRATIONS_SECRET_KEY`, mỗi Page một giao dịch, phần đăng bài trong savepoint
riêng, KHÔNG giữ kết nối pool khi gọi Graph) và 7 route K14. Test dùng máy chủ giả (wiremock, kịch bản và mã lỗi theo C06b:
368/551/17/32/4/613/190, subcode 2018278/1545041, HTTP 429): mã lỗi phân loại đúng và khớp phân loại chặn của M45; pool 1 kết nối
chứng minh không giữ kết nối khi gọi HTTP. Webhook, link mở chat, hội thoại, bình luận, luật tự động thuộc M47a trở đi.

Giai đoạn lai tốn RAM hơn cả hai đầu: Node (tới 65 kết nối DB theo cấu hình mặc định) + Next + Rust + Postgres. Trong
lai đặt `TENANT_MAX_CLIENTS` và `TENANT_CONNECTION_LIMIT` của Node thấp, pool Rust 4; máy chạy lai và ngưỡng swap để
lui được chốt bằng số đo ở R003. Đích 1–2 GB ở mục 9 chỉ áp dụng sau X06.

Chi tiết từng issue, phụ thuộc và khả năng chạy song song: [ISSUES.md](ISSUES.md).

## 8. CI cho Rust

Thêm vào `.github/workflows/ci.yml`, cùng quy ước hiện có (ghim SHA action, `permissions` tối thiểu, chỉ
`GITHUB_TOKEN`):

| Job | Bắt buộc | Nội dung |
|---|---|---|
| `Rust fmt` | qua `ci-ok` | `cargo fmt --check` |
| `Rust clippy` | qua `ci-ok` | `cargo clippy --workspace --all-targets -- -D warnings`, dùng `SQLX_OFFLINE=true` |
| `Rust unit` | qua `ci-ok` | `cargo test --workspace --lib` (không cần DB) |
| `Rust contracts` | qua `ci-ok` | `xtask check-routes` (bảng route so `routes.json`), kiểm `rbac.json` khớp gói TS; không cần DB |
| `Rust pg tests` | không | Postgres 16: migrate bằng Prisma và bằng Rust, test pg, kiểm `.sqlx` không cũ (cần DB nên không nằm trong `ci-ok`) |
| `Contract (Node)`, `Contract (Rust)` | không (PR đổi backend + push main + đêm) | Bộ hợp đồng trên từng bên; job Rust chạy trong cgroup giới hạn bộ nhớ và ghi `VmHWM` |
| `Rust build` | không | Release cho amd64 (runner x64) và arm64 (runner arm), tải binary làm artifact |
| `cargo-deny`, `cargo-audit` | deny: PR; audit: đêm | Giấy phép tương thích AGPL-3.0, lỗ hổng, nguồn crate |

- `ci-ok` thêm ba job Rust vào `needs`. Các job này luôn chạy nhưng các bước chỉ thực thi khi PR đổi `server/**` hoặc
  `packages/prisma/prisma/**` (cùng kiểu lọc theo gói đang dùng), nên PR chỉ đổi web không tốn thời gian. Đích giữ
  nguyên: check bắt buộc ≤ 5 phút. Cache: `Swatinem/rust-cache` theo `Cargo.lock`; nếu clippy lạnh vượt 5 phút thì
  chuyển clippy đầy đủ sang job không bắt buộc và chỉ giữ `cargo check` trong `ci-ok`.
- Image: một image `trinity` (thay `trinity-api` + `trinity-web`), nền `distroless/cc`, chỉ chứa binary. **Đường nâng
  cấp cho người tự cài bằng Docker** (repo công khai, đây là người dùng thật): tiến trình chạy uid 1000, không phải
  uid mặc định 65532 của distroless, vì volume hiện do user `node` (uid 1000) sở hữu (`Dockerfile` dòng 49–51); giữ
  đường dẫn `/app/uploads` và `/var/lib/trinity/storage`; giữ cổng mặc định 3000 mà reverse proxy của người dùng đang
  trỏ vào, và cổng tương thích 4000 cho `/notif-ws` (mục 4.13); healthcheck bằng `trinity healthcheck` (image không có shell hay node); tài liệu "Nâng cấp từ bản Node" nêu
  service bị bỏ (`redis`, `migrate`, `web`, `api`) và tên image mới; issue X14 thử nâng cấp một bản cài có dữ liệu.

- `docker.yml` giữ nguyên SBOM, provenance, cosign keyless, manifest đa kiến trúc. Ngoài image, đính kèm binary nén
  vào GitHub Release để cài không cần Docker (tiết kiệm RAM trên máy 1 GB).
- `THIRD_PARTY_NOTICES.md` sinh bằng `cargo about`. CodeQL bật thêm ngôn ngữ Rust. Dependabot thêm hệ `cargo`.
- Nightly thêm: fuzz 10 phút mỗi target, bộ hợp đồng đầy đủ, test tải ngắn có ngưỡng bộ nhớ.

## 9. Đích tài nguyên và cách đo

Chuẩn bắt buộc là máy **2 GB** (e2-small); máy 1 GB (e2-micro) là mục tiêu cố gắng, không chặn phát hành. Các số dưới
là **đích**, chưa đo. Baseline của bản Node và của cấu hình lai đo ở issue R003; số của Rust đo ở X05 và lặp lại trong CI.

| Chỉ số | Bắt buộc trên máy 2 GB | Cố gắng trên máy 1 GB |
|---|---|---|
| RSS tiến trình `trinity` lúc rỗi | ≤ 60 MB | ≤ 60 MB |
| RSS đỉnh khi chạy bộ hợp đồng + 50 kết nối đồng thời | ≤ 200 MB | ≤ 150 MB (pool 4, 1 worker) |
| Kết nối Postgres | ≤ 8 | ≤ 4 |
| Tổng máy (Rust + Postgres cùng máy + hệ điều hành) | ≤ 1,2 GB | ≤ 800 MB |
| Thời gian khởi động tới khi health trả 200 | ≤ 1 giây (không tính migrate) | ≤ 2 giây |
| p95 độ trễ `GET /contacts` (trang 20 dòng) | không chậm hơn baseline Node | ≤ 2 × máy 2 GB |
| Đăng nhập khi 10 request khác đang treo ở Graph | ≤ 1 giây | ≤ 2 giây |
| Kích thước binary (có web nhúng) | ≤ 80 MB | như bên |

Cách đo:

- Bộ nhớ: `VmRSS`/`VmHWM` trong `/proc/<pid>/status`, PSS bằng `smem`, đỉnh cgroup (`memory.peak`) khi chạy bằng
  `systemd-run -p MemoryMax=…`. CI: chạy bộ hợp đồng với `MemoryMax=256M`; vượt là đỏ.
- CPU: `pidstat 1` trong lúc chạy kịch bản tải; riêng đăng nhập (bcrypt) đo số lần/giây.
- Tải: `oha` hoặc `k6` với kịch bản cố định trong `tests/load/` (đăng nhập, danh sách khách, kanban, dashboard, một
  lời gọi MCP, và kịch bản "Graph treo"), 50 kết nối, 5 phút; chạy trên đúng loại máy đích.
- Postgres trên máy nhỏ phải chỉnh (`shared_buffers`, `max_connections`, `work_mem`); cấu hình mẫu vào
  `docs/deployment.md`.
- Nếu trên máy 1 GB bcrypt hoặc xuất xlsx làm p95 vượt đích: ghi "chạy được cho bản cài nhỏ, không khuyến nghị cho
  nhiều công ty", không hạ chuẩn tương thích.

## 10. Rủi ro và trường hợp biên

### 10.1 Rủi ro

| # | Rủi ro | Cách chặn |
|---|---|---|
| 1 | Lệch hành vi tinh vi: định dạng ngày/decimal/null, thứ tự sắp xếp, làm tròn (111 chỗ `Math.round/floor/ceil`), thông điệp lỗi | Serializer tập trung (4.4); golden + so DB; bảng ca dùng chung cho hàm thuần; shadow GET |
| 2 | Web không xuất tĩnh sạch với route động | Spike R004 trước; ba phương án xếp sẵn; web tĩnh là mốc độc lập |
| 3 | State RAM chia đôi khi hai tiến trình cùng chạy (phiên, cache, chuông, phiếu lương, bộ đếm lỗi Graph); job chạy trùng | Bảng ở mục 3 điểm 4: `NOTIFY` cho từng kênh (G12b), test hai tiến trình cho từng kênh; cờ sở hữu job + nhận lượt qua bảng; cụm auth bật cùng lúc; mọi thứ gọi Graph chuyển cùng một lần |
| 4 | Rò dữ liệu giữa công ty qua pool dùng chung | Kiểu `TenantConn` bắt buộc; `search_path` chỉ một schema; đặt lại khi trả; test pg cô lập; spike R005 |
| 5 | Migrator Rust làm hỏng `_prisma_migrations` | Test hai chiều với Prisma thật, là điều kiện của X02b; trong giai đoạn lai Rust chỉ ghi cho schema công ty **mới** (đăng ký), schema đã có vẫn do Prisma migrate; migrate nền chỉ một bên chạy; dump trước migrate |
| 6 | 2.036 luật validation chuyển sai | Sinh khung struct + luật từ DTO bằng script; ca 400 cho mọi route; chế độ strict/lenient kiểm theo `routes.json` |
| 7 | Tài liệu sinh ra (xlsx, pdf) khác bố cục | So nội dung, không so byte; người duyệt xem mẫu phiếu lương và các tệp xuất trước khi bật module |
| 8 | Hành vi ngầm của Prisma: `@updatedAt`, cascade, thứ tự mặc định khi thiếu `orderBy` | Lint `updated_at`; cascade nằm ở DB (28 quan hệ) nên giữ; mọi danh sách phải có `ORDER BY` tường minh, ca golden phát hiện |
| 9 | Meta/Zalo đổi API giữa chừng | Giữ `FACEBOOK_GRAPH_VERSION`; máy chủ giả theo payload thật đã ghi; module kênh bật cuối |
| 10 | Thời gian biên dịch làm chậm vòng lặp | Nhiều crate nhỏ; `cargo check -p`; cache CI; không dùng macro nặng ngoài sqlx |
| 11 | Mục tiêu di động: backend TS tiếp tục đổi | Luật ở mục 3 điểm 5; job CI báo khi `routes.json` đổi mà Rust chưa theo |
| 12 | Tool MCP lệch schema làm client đã kết nối hỏng | Phục vụ schema đóng băng; so `tools/list` từng byte; e2e client thật |
| 13 | Giới hạn tốc độ trong RAM: mất khi khởi động lại, và gấp đôi trong giai đoạn lai | Chấp nhận có thời hạn (giống hành vi rơi về RAM hiện có); hạn mức kênh quan trọng đã nằm ở DB (`channel_usage`); bộ đếm lỗi Graph được chia sẻ riêng |
| 14 | Giấy phép crate không hợp AGPL | `cargo-deny` chặn ở PR |
| 15 | Shadow ghi DB hoặc gọi Graph trên bản thật | Danh sách `safe_for_shadow`, giao dịch chỉ đọc, client mạng bị chặn (4.14); ca test K28 |
| 16 | Proxy làm Node tin header IP giả | Xoá và đặt lại header (4.14); ca test bắt buộc ở K17, M13b |
| 17 | Cạn pool khi handler chờ dịch vụ ngoài | `Ctx` giữ handle, lint, timeout (4.3); ca tải ở X05 |
| 18 | Tiền lương lệch 1 đồng ở ca biên | Mục 10.3; M30a |
| 19 | Lỗi ghi của Rust làm hỏng dữ liệu thật | Lui bằng tệp sở hữu; dump trước mỗi đợt để đối chiếu và sửa có chọn lọc, không khôi phục đè (6.6, X01); công ty thử 24 giờ; bộ kiểm bất biến mỗi giờ trong 72 giờ đầu (X11) |
| 20 | Giao dịch đang chờ khi gỡ thanh toán | Gỡ hai bước G07a/G07b; 410 (2.3) |
| 22 | `main` không chạy được giữa chừng (web tĩnh merge trước khi Rust đứng trước) | Thứ tự D01 → W01 → W02a → K18 → W04 → W02b (mục 5) |
| 27 | Job nền tự chạy xen vào ca test hộp đen, kết quả lúc đạt lúc trượt | Bật API điều khiển thì không có lịch tự động (C18, K34) |
| 28 | Golden phụ thuộc ngày chạy | Seed tương đối, nhãn ngày tương đối, so trong cùng lượt (6.2) |
| 29 | Chuông realtime mất sau nâng cấp vì luật `/notif-ws` → 4000 cũ | Cổng tương thích; X07, X14 |
| 30 | Giới hạn 100 MB / 100 giây của proxy Cloudflare | Mục 4.13; G15, X05, X15a, X15b |
| 32 | Bản phát hành giữa chừng làm hỏng bản cài Docker cũ | Route handler và `standalone` giữ tới W02b, merge cùng bản phát hành với X06 (mục 5) |
| 33 | Header IP giả; mất IP khách sau proxy; kiểm IP tắt lặng lẽ hoặc khoá nhầm | Mục 4.13: một cấu hình `TRUSTED_PROXY` (5 giá trị), tiến trình biên xác định một lần lúc nhận header và ký, peer của Next đi qua `AsyncLocalStorage`, chữ ký sai thì 400, thiếu cấu hình thì cảnh báo quản trị; G16a, G16b (TS), K16, K17 (Rust) |
| 34 | Trang pháp lý mất nội dung ở bản phát hành giữa chừng | W03 đi sau W02b, cùng bản phát hành với X06 |
| 35 | Golden cũ lệch bản Node cuối cùng làm X06 đỏ giả | X03 ghi lại golden lần cuối rồi mới đóng băng |
| 31 | Vòng phụ thuộc trong danh sách issue | `check-issues.py` chạy trước khi tạo issue (R001) |
| 23 | Module đợt c tự viết lại outbox/thông báo, lệch nhau | Crate nền K36 có trước; so DB bắt `integration_events`, `notification_logs` |
| 24 | Người tự cài Docker nâng cấp bị lỗi quyền ghi, sai cổng | Mục 8; X06, X07, X14 |
| 25 | Vòng lặp sửa SQL phải qua CI vì máy không có DB | Postgres cài thường trên máy phát triển cho `sqlx prepare` (4.4, K01) |
| 26 | Công thức bảng tuỳ biến lệch làm tròn | M57, bảng 300 ca dùng chung, `js_round` |
| 21 | Giai đoạn lai hết RAM hoặc chạm `max_connections` | Đo ở R003; hạ pool Node trong lai; ngưỡng swap để lui (mục 7) |

### 10.2 Trường hợp biên phải có ca test

- **Đa công ty:** id trùng giữa công ty; token công ty A dùng ở công ty B; tiền tố `cN.` giả; công ty bị tạm ngưng;
  email đã thuộc công ty khác; Page/OA đã được công ty khác nối (lỗi trigger `TRINITY_ROUTE_TAKEN` phải thành 409 với
  câu hiện có); `?cid=` trỏ công ty không tồn tại; đăng ký bỏ dở; hai đăng ký cùng email cùng lúc; job khi một công ty
  lỗi; số công ty lớn hơn pool.
- **Múi giờ tiến trình:** golden ghi với `TZ=UTC`; xác nhận `TZ` của bản đang chạy trước đợt d (23 lời gọi giờ địa
  phương trong mã TS, có ở chấm công); Rust không dùng giờ địa phương của máy, mọi phép "giờ Việt Nam" tường minh.
- **Giờ VN và UTC:** "ngày" của hạn mức kênh, chấm công, bản tin, báo cáo là ngày Việt Nam; cột `@db.Date`; khoảng lọc
  `parse-vn-date-range`; kỳ lương `YYYY-MM`; bài hẹn giờ quanh nửa đêm; máy chủ đặt múi giờ khác UTC.
- **Tiền và số:** tiền POS là `BIGINT` đồng; lương và thuế luỹ tiến; làm tròn nửa; `Decimal` ra JSON dạng chuỗi;
  số lớn hơn 2^53 (không xảy ra với dữ liệu thật, vẫn kiểm không vỡ).
- **Tiếng Việt:** tìm bỏ dấu qua `translate` (bảng ký tự phải giống hệt `SQL_FOLD_FROM/TO`); `đ/Đ`; chuẩn hoá NFC/NFD
  (14 chỗ `normalize`); sắp xếp theo tiếng Việt (21 chỗ `localeCompare`: K26 quyết từng chỗ là sắp ở DB hay bằng `icu_collator`); định dạng số và ngày kiểu Việt Nam
  (33 chỗ `toLocale*`/`Intl`) qua hai hàm chung có bảng ca dùng chung;
  tên file tiếng Việt trong `Content-Disposition` và multipart.
- **Mã tự sinh:** trigger sinh mã; tiền tố bảng tuỳ biến trùng tiền tố dành riêng; chèn đồng thời; nhập hàng loạt.
- **Xoá mềm:** `deleted_at` ở danh sách, tìm kiếm, đếm, báo cáo, MCP; khôi phục trong cửa sổ cho phép; sản phẩm xoá
  mềm vẫn hiện trong hoá đơn cũ.
- **File:** 200 MB video (stream, không đệm RAM); tải nhiều phần; `Range`; thoát thư mục; loại file giả; ảnh hỏng;
  đĩa đầy; tên trùng.
- **Webhook:** chữ ký sai, thiếu, body rỗng; cùng sự kiện tới hai lần (khoá duy nhất `facebook_lead_receipts`,
  `webhook_inbound_receipts`, id tin nhắn); sự kiện tới sai thứ tự; Page chưa nối (chuyển tiếp); sự kiện đã chuyển
  tiếp (header đánh dấu) không chuyển tiếp lần nữa; Zalo `timestamp` dạng số hoặc chuỗi.
- **Idempotency:** webhook ra thử lại với cùng id giao hàng; broadcast không gửi hai lần cho một người khi job bị cắt;
  đăng bài không đăng đôi khi hết budget; tool MCP ghi trùng (`duplicate`).
- **Giới hạn Graph API:** mã 368, 551, 17, 32 tính là chặn; 4, 613, 429 là giới hạn toàn app; 10, 200–299, 190 và
  subcode 2018278 không tính; tạm dừng 6 giờ chỉ **giữ** việc; hoàn hạn mức khi tin không ra tới mạng.
- **Khoá kênh (ChannelGuard):** khoá chặn mọi gửi ra, không chặn nhận; trạng thái cũ tối đa 10 giây; chế độ một công
  ty không có hạn mức.
- **Nhắc việc treo:** `digest_hour` là cài đặt từng công ty và job gửi ở mọi lượt từ giờ đó tới khi ghi được dấu ngày
  (lần gửi lỗi thì không ghi dấu, thử lại cả ngày); đổi chủ job chỉ khi mọi công ty hoặc chưa tới giờ của mình hoặc đã
  có dấu hôm nay.
- **Zalo OA:** refresh token dùng một lần; làm mới token dưới `pg_advisory_xact_lock` theo OA (bản TS dùng single-flight
  trong RAM, không đủ khi nhiều luồng hoặc khi đổi sở hữu giữa chừng).
- **Công thức bảng tuỳ biến:** x,5; số lớn; ngày quanh nửa đêm Việt Nam; cuối tháng; biểu thức sai trả câu lỗi nguyên văn.
- **Tool MCP nhận khoá thừa:** zod bỏ khoá lạ, nên Rust không được từ chối chỉ vì schema đóng băng có
  `additionalProperties: false`; theo golden ở C03.
- **Messenger:** cửa sổ 24 giờ, thẻ `HUMAN_AGENT` tới 7 ngày, bị từ chối khi app chưa được duyệt.
- **Bảo mật (OWASP):** kiểm quyền theo đối tượng (id ngoài phạm vi → 404); SQL injection (chỉ bind, tên schema theo
  mẫu cố định); SSRF ở webhook ra, CIMD, tải media (chuyển `ssrf-guard.ts` kèm test, chặn địa chỉ nội bộ và
  DNS rebinding); chống chèn công thức khi xuất CSV/xlsx (ô bắt đầu bằng `= + - @`, tab, xuống dòng được thêm `'` và
  ghi kiểu chuỗi, như `csv-format.ts`); che số điện thoại với AI; so sánh hằng thời gian cho bí mật; giới hạn kích thước body và độ sâu JSON;
  header bảo mật; không lộ stack ở 5xx; bí mật không vào log.
- **CORS:** `CORS_ORIGIN` nhiều giá trị và dạng `*.example.com`; localhost chỉ ngoài production; request không có
  `Origin`; `credentials: true`.
- **CSRF:** API xác thực bằng header `Authorization`, không bằng cookie, nên không có bề mặt CSRF ở API; trang đồng ý
  OAuth dùng token consent ký HMAC và header chống nhúng khung. Giữ nguyên thiết kế này (không đổi trong đợt chuyển).
- **Phiên:** refresh xoay vòng giữ `sid`; refresh đã thu hồi; đăng xuất thu hồi cả chuỗi; một phiên một người; đổi mật
  khẩu thu hồi phiên; token không `cid` = công ty 1; token có `cid` khác 1 ở chế độ một công ty bị từ chối.
- **Rate limit:** đăng nhập, MCP (ba loại), OAuth, API công khai, webhook vào; `Retry-After`; khoá theo công ty; IP
  thật theo mục 4.13 (`TRUSTED_PROXY`; mặc định IP peer; header có chữ ký chỉ giữa các tiến trình Trinity).
- **Tắt máy êm:** đang gửi broadcast, đang tải video, đang migrate công ty: dừng nhận việc mới, hoàn tất hoặc trả việc
  về hàng đợi trong hạn.

### 10.3 Lương: cách so khớp và làm tròn (chốt)

Mã `services/payroll/src` trộn hai kiểu số: 71 chỗ `Math.round`/`Number(`/`toNumber()` trong `payslips` và `tax` (số
thực IEEE 754) và 17 chỗ phép toán `Decimal`. Dùng một kiểu duy nhất ở Rust sẽ lệch 1 đồng ở ca biên. Quy tắc:

1. Trước khi viết M30a, lập **bảng từng bước tính** từ mã TS: tên bước, kiểu số, thứ tự phép, hàm làm tròn. Bảng nằm
   trong PR và là tài liệu của bộ tính lương.
2. Tái tạo đúng kiểu ở từng bước: `f64` nơi TS dùng `Number`, `rust_decimal` nơi TS dùng `Decimal`. Không "sửa cho
   đúng hơn" trong đợt chuyển; cải tiến độ chính xác là việc riêng sau X06, có thông báo.
3. `Math.round` của JS làm tròn nửa về phía +∞ (−2,5 → −2), khác `f64::round` (xa 0) và khác kiểu làm tròn ngân hàng
   mặc định của `rust_decimal`. Viết một hàm `js_round` duy nhất, có bảng ca.
4. Đích so khớp: **từng đồng, từng dòng của phiếu** (không chỉ tổng), trên 100 phiếu mẫu và 2.000 ca sinh ngẫu nhiên
   quanh ngưỡng bậc thuế, trần bảo hiểm và các giá trị x,5 đồng; cùng bộ ca chạy ở cả TS và Rust.
5. Tiền POS và trang bán hàng là số nguyên đồng (`BIGINT`), không qua số thực.
6. Cùng hàm `js_round` dùng cho bộ tính công thức của bảng tuỳ biến (M57): `round(x, n)` ở đó là
   `Math.round(Math.abs(x) * f + Number.EPSILON * f) / f` rồi gắn lại dấu, và chuẩn hoá `Math.round(x * 1e6) / 1e6`.
   **Đã làm ở M57** (`server/crates/trinity-kernel/src/{number,formula}.rs`): `js_round` ở `number.rs`; bảng 756 ca
   `server/contracts/cases/formula.json` (TS sinh bằng `formula-cases.spec.ts`, Rust chạy ở `tests/formula_cases.rs`). Ngày giờ
   có `T` mà không có múi giờ: TS hiểu theo múi giờ tiến trình Node, Rust hiểu UTC (không nằm trong bảng).
7. **Đã làm ở M30a** (`server/crates/mod-payroll/src/{calc,formula}.rs`): hàm thuần cho bảo hiểm, thành phần lương, thuế TNCN,
   phiếu (`buildPayslipData`, `prorateBase`, KPI) và công thức bảng lương; **bảng bước tính nằm ở đầu `calc.rs`**. Bảng ca
   `server/contracts/cases/payroll.json` do MÃ TS THẬT sinh (`services/payroll/scripts/gen-payroll-cases.mjs` cắt nguyên văn
   các engine và các hàm của `payslips.service.ts`, bỏ kiểu rồi chạy với Prisma giả; không cần `node_modules`), Rust chạy cùng
   bảng ở `tests/payroll_cases.rs`: 700 ca bảo hiểm, 800 ca thuế quanh ngưỡng bậc, 400 ca thành phần (x,5 đồng), 100 phiếu mẫu
   so từng dòng, 7.629 ca tính công thức và 5.074 ca kiểm công thức (văn phạm + ngẫu nhiên) so với `new Function`/`evaluateFormula`.
   Phát hiện nhờ bảng: `validateFormula` bọc công thức vào `return (…);` nên `1) + (2` hợp lệ; chú thích dòng cuối công thức nuốt
   `);`; hằng regex ở vị trí toán hạng hợp lệ. Bản Rust của M29 đã sửa theo. Biên JS của bộ tính: đọc thuộc tính của `undefined` là lỗi lúc chạy; `obj.tên++` trên hàm hoặc regex cho `NaN`, trên số/chuỗi/`undefined` là lỗi lúc chạy; `...` trên chuỗi cho ký tự đầu `NaN`. Rò trạng thái ở Node: `min.max++` gán vào `Math.min` dùng chung nên các lần sau thấy `NaN`, Rust không rò. Tiền `i64` (tràn ⇒ lỗi), tỷ lệ `f64` đọc từ chuỗi
   `Decimal`, làm tròn bằng `trinity_kernel::number::js_round`.

## 11. Thời gian và nguồn lực

- **Khối lượng theo quy ước cỡ:** 186 issue = 37 S + 97 M + 52 L; S ≈ nửa ngày, M ≈ 1 ngày, L ≈ 2 ngày của một agent
  lập trình ⇒ **219,5 ngày-agent**. Con số này là **khoảng dưới**.
- **Ước thực tế: 250–300 ngày-agent.** Lý do: 66 issue module (98 ngày theo cỡ) phủ khoảng 77.000 dòng TS, tức gần
  790 dòng TS mỗi ngày-agent đã gồm viết SQL tay cho khoảng 1.900 lời gọi Prisma, khoảng 2.000 luật validation, test hợp
  đồng và 3 lượt review. Tốc độ đó không khác bản đầu là mấy. Lấy 400–550 dòng mỗi ngày-agent thì giai đoạn 4 là
  **140–190 ngày-agent**, cộng khoảng 121,5 ngày của các giai đoạn khác.
- **Điểm đo để chỉnh:** sau 5 issue module đầu (M01, M06, M07, M15, M25) tính tốc độ thật (dòng TS nguồn mỗi ngày-agent,
  số vòng sửa theo hợp đồng) rồi cập nhật bảng dưới và mục này. Nếu tốc độ dưới 400 dòng/ngày thì dừng ở điểm an toàn
  gần nhất và xem lại cách làm trước khi mở rộng.
- **Dự phòng sửa lệch:** 5 issue X12a–e dành cho khác biệt do golden, so DB và shadow phát hiện sau mỗi đợt. Nếu một đợt
  vượt dự phòng gấp đôi thì dừng ở điểm an toàn của đợt đó.
- **Hiệu suất song song:** khoảng 70% với 3 agent, 62% với 5. Ngoài phụ thuộc và xung đột file còn một ràng buộc cứng:
  máy phát triển 16 GB chỉ chạy **một tiến trình biên dịch tại một lúc**, nên các agent trên cùng máy dùng chung một
  hàng đợi biên dịch.
- **Dòng thời gian theo mốc** (tính theo dải 250–300 ngày-agent):

  | Mốc | Gồm | 3 agent | 5 agent | Thời gian chờ lịch không rút được |
  |---|---|---|---|---|
  | M1: bản TS đã gỡ kết nối | GĐ 0 + 1 | tuần 1–3 | tuần 1–2 | G07b chờ hết giao dịch đang chờ (không chặn mốc sau) |
  | M2: hợp đồng đóng băng; Rust làm proxy + web tĩnh, đã triển khai cấu hình lai | GĐ 2 + 3 (chồng nhau) | tuần 4–9 | tuần 3–7 | Chuỗi DB → auth → RBAC → HTTP → D01 chỉ 2–3 issue song song |
  | M3: đợt a + b bật (cài đặt, auth); **đo tốc độ thật** | M01–M06 | tuần 10–11 | tuần 8 | 48 giờ shadow + 24 giờ công ty thử mỗi đợt |
  | M4: đợt c bật (khách hàng, kanban, bảng tuỳ biến, báo cáo) | M07, M08, M15–M21, M57 | tuần 12–16 | tuần 9–11 | Như trên + vòng sửa lệch X12c |
  | M5: đợt d bật (nhân sự, chấm công, lương, bán hàng, thông báo) | M09–M14b, M22–M32, M56 | tuần 17–21 | tuần 12–14 | Như trên + duyệt mẫu phiếu lương và tệp xuất |
  | M6: đợt e bật (tích hợp, MCP, kênh) | M33–M55b | tuần 22–26 | tuần 15–18 | Như trên; kênh bật cuối |
  | M7: gỡ Node/Redis | X03–X14, W02b, W03, X06 (X15a, X15b sau đó) | tuần 27–29 | tuần 19–20 | 7 ngày shadow toàn bộ; 14 ngày giữ đường lui sau X06 |

  Tổng: **24–29 tuần với 3 agent, 16–20 tuần với 5**. Nếu tốc độ đo được ở M3 đạt mức của quy ước cỡ (219,5 ngày-agent),
  tổng rút về khoảng 20 tuần với 3 agent.
- **Biên dịch và kiểm truy vấn:** máy phát triển hiện không có Rust toolchain. K01 chốt: cài toolchain và một Postgres 16
  cài thường (không Docker) để `cargo sqlx prepare`; agent chạy `cargo check -p <crate>` (offline) và unit test của một
  crate tại máy; build release, test pg, bộ hợp đồng và build đa kiến trúc chạy trên CI. Nếu vòng lặp qua CI quá chậm
  (đích: dưới 8 phút cho một lượt `Rust pg tests`), bổ sung một runner tự quản có Postgres.
- **Review:** mỗi PR qua review tự động và test cục bộ; PR nền (K06, K07, K11, K13, K17, K28, K36) và PR đụng tiền hoặc
  gửi tin (G05, G07a, G07b, M27, M30a, M48, M51, M54b, M56) cần thêm một lượt review độc lập.
- **Điểm dừng an toàn:** sau mỗi mốc ở bảng trên. Dừng ở giữa giai đoạn 4 để lại hệ lai Rust + Node chạy được, với
  điều kiện máy đủ RAM cho cấu hình lai (R003).

## 12. Câu hỏi còn mở cho chủ dự án

Không còn câu hỏi mở. Các quyết định đã nhận và đã đưa vào kế hoạch:

- Tám quyết định trong `docs/rust/DECISIONS.md`: bỏ Vercel; giữ webhook và API key; gỡ Instagram; giữ trang bán hàng với
  QR VietQR tĩnh + COD; không chạy script phía nhà cung cấp; đóng băng tính năng TS; 2 GB là chuẩn, 1 GB cố gắng; TLS
  sau Cloudflare. Gói `ket_noi` và log Elasticsearch theo đề xuất của kế hoạch.
- Hai câu hỏi phát sinh ở lượt 1, chủ dự án theo đề xuất: không cần báo trước khi gỡ cổng thanh toán (hiện chỉ chủ dự
  án dùng), gỡ ngay khi hết giao dịch đang chờ; chuỗi VietQR sinh trong máy chủ, không dùng dịch vụ tạo QR bên ngoài.

## Phụ lục A — Lệnh đo

Chạy ở gốc repo. `EX` = `--include='*.ts' --exclude='*.spec.ts' --exclude='*.test.ts' --exclude-dir=node_modules
--exclude-dir=dist --exclude-dir=__tests__`.

| Số liệu | Lệnh |
|---|---|
| Endpoint | `grep -rEh "^\s*@(Get\|Post\|Put\|Patch\|Delete\|All\|Sse)\(" services --include='*.ts' \| wc -l` |
| Controller | `grep -rlE "^@Controller\(" services --include='*.ts' \| wc -l` |
| Model, enum | `grep -c "^model " packages/prisma/prisma/schema.prisma`; `grep -c "^enum " …` |
| Tool MCP tĩnh | `grep -ohE "^\s*name: '[a-z_0-9]+'" services/crm/src/integrations/mcp/{tools,actions}/*.ts \| sort -u \| wc -l` |
| Job đăng ký | `grep -rn "cronRegistry.register(" services EX`; `grep -rnE "@(Cron\|Interval)\(" services EX` |
| Redis | `grep -rnE "redis\.(get\|set\|setex\|del\|incr\|expire\|scan\|publish\|subscribe)\(" services packages EX` |
| SQL thô | `grep -rnE '\$queryRaw\|\$executeRaw\|\$transaction' services packages EX \| wc -l` |
| Hàm, trigger, sequence | `grep -hoiE "CREATE (OR REPLACE )?(FUNCTION\|TRIGGER\|SEQUENCE)[^(]*" packages/prisma/prisma/migrations/*/migration.sql` |
| DTO, validator | `grep -rnE "^export class [A-Za-z]+Dto" … \| wc -l`; `grep -rnE "^\s*@(Is[A-Z]\w*\|Min\|Max\|MinLength\|MaxLength\|Matches\|ValidateNested\|Array\w+\|Length\|Type)\(" …` |
| Ca e2e | `grep -c "it(\|test(" apps/monolith/test/rbac/*.e2e-spec.ts` |
| Trang web, route handler | `find apps/web/src/app -name 'page.tsx' \| wc -l`; `find apps/web/src/app -name 'route.ts'` |
| Phiên bản crate | `https://crates.io/api/v1/crates/<tên>` (trường `max_stable_version`) |

## Lịch sử phản biện

### Lượt 1 (26/11/2026)

Nguồn: `docs/rust/REVIEW-1.md` (3 CHẶN, 17 QUAN TRỌNG, 16 NHỎ) và `docs/rust/DECISIONS.md` (8 quyết định). Số issue từ
150 lên 175; ước lượng từ 94 lên 205 ngày-agent.

**Quyết định của chủ dự án đã đưa vào:**

| Quyết định | Thay đổi |
|---|---|
| Bỏ hẳn Vercel | G11 không còn điều kiện; mục 1.16, 4.11, 5 |
| Giữ webhook ra/vào và API key | Mục 2.1 |
| Gỡ Instagram | G04 |
| Giữ trang bán hàng, thanh toán = QR VietQR tĩnh + COD | G05 đổi từ "gỡ" thành "viết lại phần thanh toán"; thêm M56; `StoreOrder`, `online_store`, `store_slug`, `store_order.created`, `/s/[slug]`, rewrite subdomain đều giữ; số liệu mục 0 và 2 tính lại (559 endpoint, 107 model) |
| Không chạy script phía nhà cung cấp | Bỏ issue script ngắt kết nối; không ghi đè token; đường webhook cũ trả 410 (2.3) |
| Đóng băng tính năng TS | Mục 3 điểm 5 |
| 2 GB là chuẩn, 1 GB cố gắng | Mục 9 |
| TLS sau Cloudflare | Bỏ ACME (`rustls-acme`), K19 thu nhỏ; mục 4.2, 4.13 |

**Phát hiện đã theo:**

| Mã | Xử lý |
|---|---|
| B1 | API điều khiển test chỉ tồn tại ngoài production (C18, K34); seed bằng SQL; C07, C12, C13 tách đôi; mục 1.1, 6.2 viết lại |
| B2 | G15 (4 biến địa chỉ gốc Graph/Zalo, gom chỗ dựng URL); C06 phụ thuộc G15 |
| B3 | Cột `safe_for_shadow`; shadow trong giao dịch chỉ đọc, chặn gọi mạng (K28, mục 4.14); liệt kê GET có ghi ở 1.10 |
| I1 | `routes.json` thêm `status_ok`, `org_feature`, `guards`, `raw_response`, `param_pipes`, `transforms`; quy tắc 201 ghi ở 1.2; C02 lên cỡ M |
| I2 | `NOTIFY` cho chuông và phiếu lương trong G12; bảng state ở mục 3; tiêu chí X02c, K33, M30b |
| I3 | Kết quả gọi Graph phát qua `NOTIFY` (G12, M45) **và** ràng buộc chuyển cùng lúc (X02e). Phần giới hạn tốc độ: xem "không theo" |
| I4 | Nhận lượt bằng khoá mức giao dịch + `platform.job_runs`; `pg_advisory_unlock_all()` khi trả kết nối (4.9, K20, K06) |
| I5 | `Ctx` giữ handle; lint cấm chờ mạng khi giữ kết nối; timeout; ca tải ở X05 (4.3) |
| I6 | Proxy xoá và đặt lại header IP (4.14, K17); ca test ở K17 và M13b |
| I7 | G07 tách G07a/G07b; R002 đếm giao dịch đang chờ; 410 |
| I8 | Migration dữ liệu nằm trong G04, G06; G09 chỉ còn ghi chú bảng |
| I9 | Dump + chụp thư mục file trước mỗi đợt; khôi phục thử ở X01 (6.5, 6.6) |
| I10 | `min_samples`; quét bù trên bản sao dữ liệu thật (X13); công ty thử cho mọi module có ghi; bộ kiểm bất biến (X11) |
| I11 | X02a → X01, K31; X02d/e → T01; X06 → X10; tách K35 (chống SSRF) cho M34, M37, M53b; M40/M42 → M16; hai đường `settings/channel-guard` thuộc M45; C06 → C18, G15 |
| I12 | Tách M13, M14, M30, M44, M47, M53, M54, M55; thêm X12a–e; đổi quy ước cỡ; dòng thời gian theo mốc (mục 11) |
| I13 | R003 đo cấu hình lai; hạ pool Node trong lai; ngưỡng swap (mục 7) |
| I14 | Mục 10.3; M30a |
| I15 | Golden 3 vai; cột `shape_permissions` (6.2, C14a–d) |
| I16 | Bảng ánh xạ SQLSTATE và quy tắc 0 dòng (4.4, K05) |
| I17 | `NOTIFY` vô hiệu cache trong G12; shadow bỏ qua cache (4.14) |
| N1 | Bỏ `docx-rs`; M11 chỉ tải lên/tải xuống; G10 gỡ dep `docx` |
| N2 | 14 job hiện tại, 12 sau khi gỡ (1.9, mục 0) |
| N3 | Sửa mô tả gói `ket_noi` và nêu cả các gói khác có `google_sheets` (2.2, G03) |
| N4 | K26 thêm định dạng số/ngày và quyết định sắp xếp từng chỗ |
| N5 | `TZ=UTC` cho golden; `TimeZone=UTC` phiên DB; ca cho 2 cột không múi giờ |
| N6 | Golden vận chuyển MCP; cắt theo UTF-16 (4.8, C03) |
| N7 | `leeway = 0` (4.6, K11) |
| N8 | Cờ realtime và giao diện đọc lúc chạy qua `/site-config` (W03) |
| N9 | Không áp CORS của Rust cho route thuộc Node (K17) |
| N10 | G05–G07b sửa `saas-abuse.pg.spec.ts`, `pg-harness.ts`; M45 dùng bản đã cắt |
| N12 | Ca hai schema khác cột ở R005; cấm `SELECT *`; từ chối công ty chưa migrate (4.3) |
| N13 | Kiểm `.sqlx` chuyển sang job pg (mục 8, K31) |
| N14 | W02, W04 |
| N15 | `/docs` từ `utoipa` (4.12, K27) |
| N16 | Tiêu chí cứng của X04 chỉ còn phần tất định |
| Sai số đếm | 345 ca e2e (không phải 349); C09 22 ca; hai file của C13b tổng 43 ca (trước ghi 45) |

**Phát hiện không theo, hoặc chỉ theo một phần** (hai dòng N11 và B1 dưới đây đã bị lượt 2 chỉ ra là sai và được sửa,
xem lượt 2):

| Mã | Phần không theo | Lý do |
|---|---|---|
| I3 | Không chia sẻ các `FixedWindowLimiter` (MCP, OAuth, API công khai, webhook vào, đặt đơn) giữa hai tiến trình | Chia sẻ đúng nghĩa cần một lần ghi DB cho mỗi request, trên chính đường nóng mà việc chuyển muốn làm nhẹ đi. Các giới hạn này chống lạm dụng, không phải hạn mức tính tiền; gấp đôi trong vài tuần lai là chấp nhận được. Giới hạn đăng nhập không bị ảnh hưởng (cụm auth chỉ ở một bên). Phần có hậu quả thật (bộ đếm lỗi Graph) thì đã chia sẻ |
| N11 | Không đọc bảng sở hữu route từ bảng `platform` mỗi 10 giây | Làm định tuyến phụ thuộc DB còn sống và thêm một nguồn cấu hình thứ hai. Chọn phương án còn lại của chính phát hiện: nạp lại khi nhận `SIGHUP` |
| B1 | Không làm `POST /internal/test/clock` | Chưa ca nào trong 341 ca cần giờ giả; thêm khi có ca cần |
| I10 | Không che PII trên bản sao dữ liệu để chạy lại ca hợp đồng | Ca hợp đồng dựa vào seed cố định nên không chạy được trên dữ liệu thật. Thay bằng X13: quét GET trên bản sao nguyên trạng đặt ở máy riêng, báo cáo không chứa giá trị |

### Lượt 2 (26/11/2026)

Nguồn: `docs/rust/REVIEW-2.md` (1 CHẶN, 12 QUAN TRỌNG, 14 NHỎ; 3 mục lượt 1 xử lý sai, 1 mục chưa đủ) và hai câu trả
lời cho mục 12. Số issue từ 175 lên 181; ước lượng từ 205 lên 250–300 ngày-agent (212 theo quy ước cỡ là khoảng dưới).

**Mục lượt 1 xử lý sai hoặc chưa đủ, đã sửa:**

| Mã | Sai ở đâu | Sửa |
|---|---|---|
| B1 | Viết "chưa ca nào cần giờ giả" là sai: hai file e2e gọi hàm với `NOW` cố định; còn các lời gọi hàm nội bộ không phải job/cache | Thêm `POST /internal/test/clock` và tham số `now` (C18, K34); từng lời gọi nội bộ có cách chuyển ghi trong C08, C11, C12b, C13a (6.2) |
| I17 | Chỉ tắt cache phía Rust, response Node vẫn từ cache | Cột `cached` trong `routes.json`; lưu lượng thật chỉ so hình dạng; so chặt ở X13 với cache tắt cả hai bên (`TRINITY_DISABLE_READ_CACHE`, G12a) |
| N11 | "Sửa env rồi `SIGHUP`" không chạy được: tiến trình không đọc lại env | Tệp sở hữu `TRINITY_OWNERSHIP_FILE` cho route **và** job; Rust nạp lại khi `SIGHUP`, Node đọc lại mỗi lượt tick (4.14, K17, K20, T01, X01) |
| I12 | Tốc độ giai đoạn module gần như không đổi | Mục 11: 212 là khoảng dưới, ước thực tế 250–300; điểm đo sau 5 issue module đầu |

**Phát hiện mới đã theo:**

| Mã | Xử lý |
|---|---|
| CHẶN-1 | Hồ sơ cấu hình cho test hộp đen: máy chủ khởi động một lần mỗi hồ sơ, 7 hồ sơ ban đầu, ca `production` chỉ seed bằng SQL; đếm lại 39 chỗ đổi env (42 trừ 3 của chương trình con) và ánh xạ trong C12a–C13b; C06 tách C06a/C06b (1.1, 6.2) |
| QT-1 | C01, C02, C04 chỉ phụ thuộc G06 + G07a; C05 phụ thuộc G04–G06; route thanh toán `deprecated` ngay từ C02; sửa đường găng (2.4) |
| QT-2 | Thêm D01 (triển khai cấu hình lai); W01/W02 phụ thuộc K18 + D01; X02a phụ thuộc D01 (mục 5, 7) |
| QT-3, QT-4 | Tệp sở hữu (như N11); T01 lên cỡ M; thứ tự nhận trước nhả sau trong X01 |
| QT-5 | Thêm K36 (outbox sự kiện, tạo thông báo, "đá" bộ phát webhook); 10 issue module phụ thuộc K36; M40 → M21; M41 → M06, M08, M19, M20, M23, M24, M45; M30b → K33 (4.1) |
| QT-6 | Chấp nhận Rust ghi `_prisma_migrations` cho schema công ty mới từ đợt b; test hai chiều là điều kiện X02b; migrate nền một bên (4.5, rủi ro 5) |
| QT-7 | Lui = đổi đường chạy; dump để đối chiếu và sửa có chọn lọc, không khôi phục đè; PITR là tuỳ chọn; X11 chạy mỗi giờ trong 72 giờ đầu (6.5, 6.6, X01) |
| QT-8 | Đường nâng cấp cho bản cài Docker: uid 1000, đường dẫn volume, cổng 3000, healthcheck, tài liệu; thêm X14 (mục 8, X06, X07) |
| QT-9 | `SQLX_OFFLINE` + `.sqlx` commit; Postgres cài thường trên máy phát triển cho `prepare`; truy vấn động không macro phải có test pg; hàng đợi biên dịch chung tính vào hiệu suất (4.4, K01, mục 11) |
| QT-10 | Thêm M57 (bộ tính công thức, 300 ca dùng chung, `js_round`); M17, M18 phụ thuộc (1.13, 10.3) |
| QT-11 | R004 thử thêm `s/[slug]` (đường dẫn và tên miền phụ) và `invite/[token]`; Rust chèn slug vào HTML; log che `token` trong query (mục 5, K04) |
| QT-12 | Như I12 |
| Ghi chú B3 | Chỉ đọc đặt ở mức phiên khi lấy kết nối cho shadow (4.14, K28) |
| Ghi chú I6 | Đặt lại cả `cf-connecting-ip` (4.14, K17) |
| N-1 | Như B1 |
| N-2 | Sửa câu ở mục 3 điểm 3 (không còn khoá mức phiên) |
| N-3 | `job_runs` có ở chế độ một công ty; công ty 1 kiểm bằng `_prisma_migrations` của `public` (4.3, K06) |
| N-4 | Số migration đặt trước: G04 `0021`, G05 `0022`, G06 `0023`, G09 `0024` |
| N-5 | Bảng ánh xạ tên ngân hàng kiểu SePay → mã BIN trong G05 |
| N-6 | M44a là 25 tool |
| N-7 | R001 không còn ghi cứng 150 |
| N-8 | Node chỉ nghe loopback trong cấu hình lai (D01); bảng ca IP theo route ở K16 |
| N-9 | Làm mới token Zalo dưới advisory lock theo OA (M52, 10.2) |
| N-10 | Chống chèn công thức khi xuất tệp (10.2, K29, M18, M21) |
| N-11 | G11 xử lý bản demo đang chạy serverless và runbook |
| N-12 | Điều kiện cho máy quét X13 (ổ mã hoá, `JWT_SECRET` riêng, xoá sau khi quét) |
| N-13 | Golden "tool nhận khoá thừa" (C03, 10.2) |
| N-14 | Giữ truy vấn chỉ đọc `payment_intents` như ngoại lệ (2.3, G07b, M19) |
| Mục C | G12 tách G12a/G12b; C06 tách C06a/C06b; G06 và G07a ghi `rebase`; quy ước `.sqlx` một tệp mỗi truy vấn và bảng route theo crate; tiêu chí "quét bằng app ngân hàng" đổi thành bộ giải mã EMVCo trong test; duyệt mẫu phiếu lương đưa vào X02d; issue tách đôi phải liệt kê route từ `routes.json`; X03 chỉ là báo cáo |

**Phát hiện không theo, hoặc chỉ theo một phần:**

| Mã | Phần không theo | Lý do |
|---|---|---|
| N-2 | Không cho Node nhận lượt qua `platform.job_runs` | Bản TS đang đóng băng tính năng và sẽ bị gỡ; thêm khoá chéo tiến trình vào `cron-registry.ts` là đổi hành vi của mọi job hiện có. Chọn phương án còn lại của chính phát hiện: dựa vào nhận việc nguyên tử theo dòng mà các job đã có, cộng tệp sở hữu để mỗi job chỉ một chủ |
| QT-6 | Không giữ `POST /auth/register` ở Node tới X06 (phương án a) | Tách một route khỏi cụm auth làm state phiên lại bị chia đôi (đăng ký trả token như đăng nhập, `auth.service.ts`), và hoãn lần chạy thật đầu tiên của migrator Rust tới đúng lúc không còn Node để lui. Chọn phương án b của phát hiện |
| QT-12 | Dòng thời gian ghi 24–29 tuần với 3 agent, không phải 22–28 | Cùng dải 250–300 ngày-agent, tính với hiệu suất song song 70% (2,1 ngày-agent mỗi ngày làm việc) ra 119–143 ngày làm việc; không có căn cứ để lấy hiệu suất cao hơn khi các agent còn dùng chung một hàng đợi biên dịch |

### Lượt 3 (26/11/2026)

Nguồn: `docs/rust/REVIEW-3.md` (1 CHẶN, 3 QUAN TRỌNG, 13 NHỎ; N-7 lượt 2 sửa nhầm cột; tiền đề của N-2 lượt 2 sai với
một job). Số issue từ 181 lên 183 (W02 tách W02a/W02b; thêm X15); 214,5 ngày-agent theo quy ước cỡ, ước thực tế giữ
250–300.

**Kiểm đồ thị phụ thuộc bằng script** (`docs/rust/check-issues.py`, chạy trên ISSUES.md sau khi sửa): 183 issue, 0 ID
trùng, 0 tham chiếu tới issue không tồn tại, **0 vòng** (trước khi sửa script báo 27 issue nằm trong hoặc sau vòng
K18/D01/W01/W02). Chuỗi dài nhất tới X06: 23,5 ngày-agent; tới D01: 10,5; tới X02a: 12; tới W02b: 14,5 (chi tiết ở cuối
ISSUES.md).

| Mã | Xử lý |
|---|---|
| CHẶN-1 (vòng K18 → W02 → W01 → K18/D01) | D01 bỏ phụ thuộc K18: trong lai Rust chuyển tiếp trang web sang Next. W01 → G11, D01. W02 tách: W02a (thêm bản xuất tĩnh song song) → K18 → W04 → W02b (bỏ Next server). Mục 4.14, 5, 7 |
| QT-1 | Bật API điều khiển test thì không lịch tự động nào chạy, ở cả TS (C18) và Rust (K34); tiêu chí "chờ 3 chu kỳ không có dòng mới" (6.2) |
| QT-2 | Bỏ giờ giả toàn cục; `now` chỉ cho hai việc mã hiện đã nhận giờ làm đối số; seed thời gian tương đối; nhãn ngày Việt Nam tương đối; so Rust với Node trong cùng lượt; golden commit chỉ để xem diff; tránh khung quanh nửa đêm Việt Nam (6.1, 6.2, C06a) |
| QT-3 | Cổng tương thích 4000 cho `/notif-ws` và `/api/v1` tới hết bản phát hành lớn kế tiếp; `docs/deployment.md` bỏ luật cũ; X14 thử reverse proxy cấu hình theo tài liệu cũ và kiểm chuông realtime; trong lai `/notif-ws` qua Rust (4.13, mục 8, D01, X06, X07, X14) |
| N-1 | Câu đường găng sinh từ script, thay câu viết tay (cuối ISSUES.md) |
| N-2 (N-7 lượt 2) | R001: câu về số issue nằm đúng cột Tiêu chí, không còn "150"; thêm script kiểm vào phạm vi R001 |
| N-3 | Giới hạn 100 MB / 100 giây của proxy Cloudflare: giới hạn video theo env, tên miền không proxy cho tệp lớn, X05 đo tệp xuất, X15 tải theo phần và xuất nền sau X06 (4.13) |
| N-4 | M23, M34, M38, M54a phụ thuộc K36 |
| N-5 | `stale-work.digest` là ngoại lệ có tên: đổi chủ ngoài khung giờ gửi, bản Rust nhận lượt trước khi gửi (mục 3 điểm 3, M24, X01) |
| N-6 | T01 gồm cả `@Cron` thông báo và migrate nền lúc boot |
| N-7 | Bỏ kênh "đá" khỏi G12b và K36 (ở máy chủ thường `kick()` là no-op; giữ tick 10 giây); G11 xoá interceptor (mục 3) |
| N-8 | G11 gỡ các route chỉ phục vụ Vercel Blob; con số endpoint chốt ở C02 (mục 0, 2.1) |
| N-9 | Con trỏ phân trang giống từng byte; ca chéo Node ↔ Rust ở C14c (4.4, 6.2) |
| N-10 | Thứ tự triển khai trong lai: migrate → Node → binary Rust; cổng sức khoẻ kiểm `migrated_to` (4.14, D01) |
| N-11 | Compose lai dùng chung network namespace để loopback là thật (4.14, D01) |
| N-12 | Bộ đọc tệp sở hữu ở K03, K17 và K20 dùng chung; luật tiền tố dài nhất + phương thức; test bảng route → chủ |
| N-13 | (a) hồ sơ `production` chạy trên binary phát hành; (b) D01 dùng artifact + SHA-256, chữ ký từ X08; (c) job pg Rust có từ K02; (d) payroll: M29 23 + M30b 13 + M31 11 = 47 route; (e) hồ sơ `bad-secret-key`, ca đổi khoá seed bản mã bằng SQL |

Không có phát hiện nào của lượt 3 bị từ chối. Một lựa chọn trong phạm vi reviewer để ngỏ: ở QT-3 chọn cổng tương thích
(thay vì chỉ sửa tài liệu) vì người tự cài không đọc ghi chú nâng cấp sẽ mất chuông mà không có lỗi nào chỉ ra nguyên nhân.

### Lượt 4 (26/11/2026)

Nguồn: `docs/rust/REVIEW-4.md` (0 CHẶN, 2 QUAN TRỌNG, 9 NHỎ). Số issue từ 183 lên 185 (thêm G16; X15 tách X15a/X15b);
216 ngày-agent theo quy ước cỡ, ước thực tế giữ 250–300.

**Kiểm lại bằng `check-issues.py`** sau khi sửa: 185 issue = 38 S + 97 M + 50 L = 216 ngày-agent; 0 ID trùng; 0 tham
chiếu thiếu; **0 vòng**. Chuỗi dài nhất tới X06: 23,5 ngày-agent; tới D01: 10,5; tới X02a: 12; tới W02b: 21.

| Mã | Xử lý |
|---|---|
| QT-1 | W01 **giữ** route handler `/api/v1`, `/uploads`, `/api/build-id` của Next; W02b (bỏ `standalone`, route handler, Next server) merge ngay trước X06 trong cùng bản phát hành, và X06 phụ thuộc W02b. Bản phát hành công khai giữ compose cũ chạy được tới X06; cấu hình lai chỉ cho bản tự dựng từ `main` (mục 5, D01, W01, W02b) |
| QT-2 | Bỏ gợi ý "tên miền không proxy cho tệp lớn"; sau Cloudflare giới hạn 95 MB tới khi có X15a. `cf-connecting-ip` chỉ được tin khi nguồn TCP thuộc dải Cloudflare hoặc loopback/mạng riêng: bản TS hiện tin vô điều kiện khi bật cờ, sửa bằng G16 (mới), Rust làm đúng ở K16 kèm ca "gửi thẳng origin kèm header giả" (4.13) |
| N-1 | Cổng tương thích: biến riêng `COMPAT_API_PORT`, chỉ bật khi không còn Node; trong container nghe `0.0.0.0`, compose công bố loopback ở host (4.13, X06) |
| N-2 | Ba dạng con trỏ phân trang được mô tả; tiêu chí chung của issue module có ca trang 2 với khoá sắp trùng và ca con trỏ chéo (4.4, đầu ISSUES.md) |
| N-3 | `SOCIAL_MAX_VIDEO_MB` thêm ở bản TS trong G15 |
| N-4 | Điều kiện đổi chủ `stale-work.digest` theo `digest_hour` từng công ty và dấu gửi trong ngày; script X01 kiểm trên DB (mục 3, 10.2, M24, X01) |
| N-5 | Từ X06 golden đã commit là chuẩn so; tiêu chí X06 "đạt so với golden" (6.2) |
| N-6 | Bảng giai đoạn: GĐ 4 là 98 + 10,5; GĐ 5 là 14,5 (13,5 của bản trước cộng 1 do X15 tách đôi); GĐ 1 là 19,5 (thêm G16) |
| N-7 | X15 tách X15a (tải video theo phần: máy chủ + web) và X15b (xuất nền, danh sách route theo X05) |
| N-8 | W01 không xoá `api/build-id`, `api/fe-logging`; bỏ chữ `nest-bridge` (thuộc G11) |
| N-9 | X14 giao kịch bản nâng cấp tự động nhận tham số nhánh; X06 chạy nó trên nhánh của mình trước khi merge. W02a nêu rõ máy chủ tĩnh thử có luật trả trang giữ chỗ cho 8 route động |

Không có phát hiện nào của lượt 4 bị từ chối. Ở QT-1 chọn phương án (b) của reviewer (giữ route handler) vì không đụng
đường găng; ở QT-2 làm cả hai vế (bỏ gợi ý **và** sửa việc tin header), vì lỗi tin header vô điều kiện tồn tại độc lập
với gợi ý đó.

### Lượt 5 (26/11/2026)

Nguồn: `docs/rust/REVIEW-5.md` (0 CHẶN, 2 QUAN TRỌNG, 7 NHỎ; hai mục lượt 4 sửa chưa trọn). Số issue giữ 185; G16 lên
cỡ M nên theo quy ước cỡ là 216,5 ngày-agent; ước thực tế giữ 250–300.

**Kiểm lại bằng `check-issues.py`** sau khi sửa: 185 issue = 37 S + 98 M + 50 L = 216,5 ngày-agent; 0 ID trùng; 0 tham
chiếu thiếu; **0 vòng**. Chuỗi dài nhất tới X06: 24,5 ngày-agent (nay đi qua `X14 → W02b → W03 → X06`); tới D01: 10,5;
tới X02a: 12; tới W02b: 22; tổng thể tới X15a/X15b: 25,5.

| Mã | Xử lý |
|---|---|
| QT-1 (lượt 4 B-QT-2 chưa đủ) | Bỏ hẳn luật "tin khi nguồn là loopback/mạng riêng". Luật 5 điểm ở mục 4.13: mặc định IP peer; `cf-connecting-ip` chỉ khi **peer TCP trực tiếp** thuộc dải Cloudflare (Tunnel bằng cờ riêng); proxy nội bộ của Trinity (route handler Next, Rust) xoá mọi header IP của client và đặt `x-trinity-client-ip` có chữ ký HMAC bằng `INTERNAL_SERVICE_SECRET`; Caddy/nginx phải ghi đè `X-Real-IP` và người vận hành bật tường minh. G16 viết lại (lên cỡ M, gồm sửa route handler của Next), K16 và K17 theo; ca test tái hiện đúng lỗ: gửi thẳng origin qua proxy nội bộ kèm header giả (4.13, 4.14, 10.1, 10.2) |
| QT-2 | W03 phụ thuộc W02b (phương án a): đi cùng bản phát hành với X06, trước đó trang pháp lý vẫn render ở Next từ env; X06 phụ thuộc W03; `site-config` thuộc đợt a trong tệp sở hữu (mục 5, K27) |
| N-1 | W02b phụ thuộc thêm X03, X04, X05, X09, X10, X14: trong đồ thị sau nó chỉ còn W03 và X06 (PR xếp chồng dưới X06) |
| N-2 | Cổng chính là `TRINITY_HTTP_PORT` (mặc định 3000); `PORT` cũ bị bỏ qua kèm cảnh báo; lỗi rõ khi trùng cổng tương thích (4.13, X06, X14) |
| N-3 | Compose mới giữ vế host `${API_PORT:-4000}`; X14 có ca `API_PORT=4100` |
| N-4 | Trong compose lai Next đổi sang cổng nội bộ 3001 (D01, 4.13) |
| N-5 | Sửa dòng `golden/**` ở bảng 6.1; X03 ghi lại golden từ Node lần cuối sau X12e rồi mới đóng băng; X06 so với bản đó |
| N-6 | G15: tiêu chí kiểm cả hai chỗ dùng giới hạn video (multipart và nhập từ URL) |
| N-7 | Bảng giai đoạn ghi "66 issue module + 10 issue bật đợt và sửa lệch"; cuối ISSUES.md có dòng chuỗi dài nhất tổng thể |

Không có phát hiện nào của lượt 5 bị từ chối. Ở QT-1 làm chặt hơn đề xuất của reviewer ở một điểm: reviewer cho phép
suy chặng ngoài từ `x-forwarded-for` do proxy tin cậy ghi; kế hoạch yêu cầu chữ ký (proxy của Trinity) hoặc bật tường
minh (Caddy/nginx), và mặc định là IP peer, để một proxy nội bộ cấu hình thiếu không tự động thành lỗ.

### Lượt 6 (26/11/2026)

Nguồn: `docs/rust/REVIEW-6.md` (0 CHẶN, 3 QUAN TRỌNG cùng ở luật IP, 8 NHỎ). Số issue từ 185 lên 186 (G16 tách G16a
cỡ L và G16b cỡ M); 218,5 ngày-agent theo quy ước cỡ; ước thực tế giữ 250–300.

**Kiểm lại bằng `check-issues.py`** sau khi sửa: 186 issue = 37 S + 98 M + 51 L = 218,5 ngày-agent; 0 ID trùng; 0 tham
chiếu thiếu; **0 vòng**. Chuỗi dài nhất tới X06: 24,5 ngày-agent; tới D01: 10,5; tới X02a: 12; tới W02b: 22; tổng thể
25,5.

Luật IP đã đổi ba lượt liên tiếp (lượt 4: theo dải nguồn hoặc loopback; lượt 5: 5 điểm; lượt 6). Lần này thiết kế lại
cho đơn giản và kiểm được, đối chiếu mã Next 16 thật, thay cho việc vá tiếp luật cũ.

| Mã | Xử lý |
|---|---|
| QT-1 | Một cấu hình `TRUSTED_PROXY` (`none`, `cloudflare`, `cloudflare-tunnel`, `cidr:`) áp cho peer TCP; tiến trình biên xác định IP một lần rồi ký; bảng "ai là biên" cho 6 cách triển khai, kèm container nào cần `INTERNAL_SERVICE_SECRET`. Next làm biên được nhờ tệp nạp trước ghi địa chỉ socket (Next 16 không lộ socket cho route handler). Caddy/nginx → Next → API chạy được với `cidr:` đặt ở Next, có ca dương tính. Không có IP tin được thì cảnh báo quản trị, không tắt lặng lẽ, không khoá đăng nhập (4.13, G16a, G16b) |
| QT-2 | G16a gom **mọi** chỗ đọc IP về một hàm, liệt kê file và dòng (kiểm Wi-Fi, chấm công, giới hạn OAuth và MCP, đặt đơn trang bán hàng, hai guard API key, nhật ký đăng nhập); tiêu chí `grep`. K16 bỏ câu "giữ nguyên 7 cách"; tiêu chí D01 đổi thành Node thấy IP thật của client, hai client có bộ đếm riêng |
| QT-3 | `cloudflare-tunnel` bắt buộc cổng chỉ nghe loopback, tiến trình từ chối khởi động nếu không; compose có profile `tunnel` không công bố cổng; compose mặc định công bố cổng theo `TRUSTED_PROXY` |
| N-1 | `/privacy`, `/terms` có tệp trang riêng cho bản xuất ngay ở W02a (không còn `force-dynamic` trong `build:export`); Rust chèn giá trị pháp lý vào HTML (K18, phụ thuộc thêm K27); bảng mục 5 liệt kê đủ 5 file |
| N-2 | Compose lai: `web` dựng với địa chỉ `127.0.0.1:4000`; Rust chuyển `/uploads`, `/.well-known` thẳng sang Node (D01, 4.14) |
| N-3 | Hai họ cờ cũ gộp vào `TRUSTED_PROXY`; lệch nhau thì dừng khởi động |
| N-4 | Chữ ký trên IP nối thời điểm, hạn ±60 giây, khoá dẫn bằng HKDF |
| N-5 | G16 tách G16a (L) và G16b (M) |
| N-6 | Danh sách biến mới ở 4.13 bổ sung đủ; mỗi biến vào `.env.example` ở issue thêm nó |
| N-7 | Bản sửa lỗi TS merge sau X03 phải ghi lại golden của route liên quan trong cùng PR (6.2, X03) |
| N-8 | Chồng PR ghi đúng là W02b → W03 → X06; X14 thêm ca trang pháp lý và ca cờ IP kiểu cũ |

Không có phát hiện nào của lượt 6 bị từ chối. Khác đề xuất của reviewer ở hai điểm: không thêm `CF_TUNNEL_PEERS` (thay
bằng ràng buộc cứng "tunnel thì chỉ nghe loopback", ít cấu hình hơn và sai là không khởi động được); và gộp các cờ vào
một biến `TRUSTED_PROXY` thay vì giữ hai cờ `TRUST_CF_IP`/`TRUST_PROXY_HEADERS`, để không có tổ hợp cờ nào mâu thuẫn nhau.

### Lượt 7 (26/11/2026)

Nguồn: `docs/rust/REVIEW-7.md` (0 CHẶN, 3 QUAN TRỌNG cùng ở luật IP, 8 NHỎ). Làm theo đúng đề xuất của reviewer. Số
issue giữ 186; G16b lên cỡ L nên theo quy ước cỡ là 219,5 ngày-agent; ước thực tế giữ 250–300.

**Kiểm lại bằng `check-issues.py`** sau khi sửa: 186 issue = 37 S + 97 M + 52 L = 219,5 ngày-agent; 0 ID trùng; 0 tham
chiếu thiếu; **0 vòng**. Chuỗi dài nhất tới X06: 24,5 ngày-agent; tới D01: 10,5; tới X02a: 12; tới W02b: 22; tổng thể 25,5.

| Mã | Xử lý |
|---|---|
| QT-1 | Peer của Next đi qua `AsyncLocalStorage` do tệp nạp trước gắn, không qua header; thiếu tệp nạp trước ⇒ "không tin được" + cảnh báo, không đọc header nào; `x-trinity-*` bị xoá ở mọi request tại mọi tiến trình biên; `NODE_OPTIONS` vào `.env.example` và mẫu trình quản lý tiến trình; ca test chạy Next không có tệp nạp trước (4.13, G16b) |
| QT-2 | Chữ ký kiểm ngay khi nhận header, trong middleware trước body-parser và multer; ký ngay trước khi gửi; có header mà chữ ký sai/quá hạn ⇒ 400, không cho qua; tách rõ "thiếu cấu hình" (cho qua + cảnh báo) với "chữ ký sai" (từ chối); ca body nhỏ giọt 61 giây (4.13, G16a, G16b, K16, K17) |
| QT-3 | Thêm `cloudflare-behind:<cidr>` cho Cloudflare → Caddy/nginx → ứng dụng (kiểm phần tử phải cùng của `X-Forwarded-For` thuộc dải Cloudflare rồi mới lấy `cf-connecting-ip`), có dòng trong bảng triển khai và mẫu Caddy/nginx; `cidr:` đọc phần tử phải cùng của `X-Forwarded-For`, `X-Real-IP` chỉ khi ghi tường minh; cờ cũ không ánh xạ ngầm, thiếu `TRUSTED_PROXY` thì dừng khởi động kèm hướng dẫn; tiêu chí X14 sửa theo |
| N-1 | Ràng buộc loopback của `cloudflare-tunnel` có ở G16b (tệp nạp trước bọc `server.listen`); chữ thống nhất "không phải loopback" |
| N-2 | Sau X06, ở chế độ tunnel cổng tương thích 4000 chỉ nghe loopback hoặc tắt; X14 có ca tunnel |
| N-3 | Tệp ghép `docker-compose.tunnel.yml` (`ports: !reset []`, `HOSTNAME: 127.0.0.1`, `cloudflared` chung namespace, ingress `127.0.0.1`); `HOSTNAME` vào danh sách biến |
| N-4 | Môi trường test đặt `TRUSTED_PROXY=cidr:127.0.0.1/32;header=x-real-ip`; tiêu chí `grep` loại trừ `test/` |
| N-5 | `web` nhận bí mật bằng đúng biểu thức dự phòng của `x-api-env`; khoá HKDF dẫn từ bí mật đang hiệu lực; tệp nạp trước từ chối bí mật mẫu |
| N-6 | Nhận cổng mặc định bằng `/proc/net/route`; tệp nạp trước đặt header có chữ ký cho cả đường rewrite nên API phân biệt được request qua Trinity |
| N-7 | Tiêu chí W02a đo bằng máy chủ tĩnh thử; phần "khi Rust phục vụ" ở K18 |
| N-8 | `CHANGELOG` "hành động bắt buộc khi nâng cấp"; dải cảnh báo trên mọi trang quản trị; `install.sh` hỏi cách triển khai; cấu hình Caddy/nginx cũ và mới đặt cạnh nhau (4.13, G16a, G16b, X06) |

Không có phát hiện nào của lượt 7 bị từ chối.

### Lượt 8, lượt chốt (26/11/2026)

Nguồn: `docs/rust/REVIEW-8.md` (0 CHẶN, 2 QUAN TRỌNG, 7 NHỎ; reviewer xác nhận sửa xong 2 QUAN TRỌNG là đủ để bắt đầu).
Không thêm issue, không đổi cỡ.

**Kiểm lại bằng `check-issues.py`** sau khi sửa: 186 issue = 37 S + 97 M + 52 L = 219,5 ngày-agent; 0 ID trùng; 0 tham
chiếu thiếu; **0 vòng**. Chuỗi dài nhất tới X06: 24,5 ngày-agent; tới D01: 10,5; tới X02a: 12; tới W02b: 22; tổng thể 25,5.

| Mã | Xử lý |
|---|---|
| QT-1 | nginx không tự ghi `X-Forwarded-For`: mẫu bắt buộc `proxy_set_header X-Forwarded-For $remote_addr;` (ghi đè) và xoá `X-Real-IP` của client; không dùng `set_real_ip_from` một mình, nếu dùng thì kèm `real_ip_header CF-Connecting-IP` chỉ cho dải Cloudflare; `cidr:` chỉ dùng khi thật sự có proxy phía trước; ca test nginx (mẫu mới, thiếu dòng ghi đè, `set_real_ip_from`) ở G16b, chạy lại ở K16 (4.13) |
| QT-2 | "Không tin được ⇒ cho qua + dải cảnh báo" áp lên kết quả cuối ở **mọi** giá trị `TRUSTED_PROXY`: loopback, cổng mặc định của container không bao giờ là IP khách; `cidr:` nhận `docker-gateway`; ca `cidr:` sai dải và `cloudflare` với peer là cổng mặc định (4.13, G16a, G16b) |
| N-1 | Trong cấu hình lai, tệp nạp trước giữ header có chữ ký hợp lệ của Rust (G16b, D01) |
| N-2 | Chuẩn hoá IPv4-mapped trước mọi so khớp |
| N-3 | API kiểm chữ ký với khoá dẫn từ cả hai bí mật; cổng sức khoẻ gọi `/api/v1/health` qua Next để tự lui khi lệch bí mật; log nêu rõ nguyên nhân |
| N-4 | X14 đo được trên Docker: cờ cũ ⇒ vẫn lên + cảnh báo; ca "dừng khởi động" thuộc trình quản lý tiến trình, có hướng dẫn và ghi `CHANGELOG` |
| N-5 | Tệp ghép tunnel ghi yêu cầu Docker Compose ≥ 2.24; ingress có luật `/notif-ws` |
| N-6 | `install.sh` chỉ hỏi khi có tty, có cờ `--trusted-proxy`, không sửa `.env` có sẵn; thêm `scripts/migrate-env.sh` |
| N-7 | Tệp nạp trước dùng cùng luật bí mật với `insecureSecrets()` |

Không có phát hiện nào của lượt 8 bị từ chối.

**Plan chốt ngày 26/11/2026**, sau 8 lượt phản biện. Thay đổi về sau ghi thành lượt mới ở mục này.

