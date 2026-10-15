# Bộ kiểm tra giao diện tự động (Playwright)

Chạy lại sau **mỗi lần chỉnh sửa / deploy** để biết giao diện còn đáp ứng nhu cầu không:
mọi trang mở được không lỗi, đúng phân quyền, các luồng nghiệp vụ chính còn chạy.

## Cấu trúc

| Đường dẫn | Việc |
|---|---|
| `auth.setup.ts` | Đăng nhập UI từng role, lưu phiên vào `e2e/.auth/` (gitignore). Mọi project phụ thuộc nó (đăng nhập **1 lần/tài khoản**). |
| `seed/seed.setup.ts` (project `seed`) | **GHI.** Tạo bộ dữ liệu thử `E2E-…` qua API (không SQL) và ghi `e2e/.seed-manifest.json` từng mục ngay khi tạo. Bảng dữ liệu: xem "Bộ dữ liệu seed" bên dưới. |
| `seed/cleanup.teardown.ts` (project `cleanup`) | Teardown của `seed` khi chạy lẻ; `run-full` gọi riêng ở pha cuối ⇒ chạy **kể cả khi test đỏ**: xoá theo manifest NGƯỢC thứ tự qua API, quét sót `E2E-`, ghi `e2e/.cleanup-residual.json` (bản ghi chỉ xoá mềm được), rồi kiểm: không còn `E2E-` hoạt động + số bản ghi THẬT bằng trước seed. |
| `smoke.spec.ts` | **Read-only.** Mỗi role × mỗi trang: không `pageerror`/console error/API 4xx-5xx, h1 đúng, trang không quyền hiện "Không có quyền", công tắc tính năng tắt hiện "Tính năng … đang tắt", không tràn ngang (1440 và 390px). |
| `rbac-ui.spec.ts` | **Read-only.** Menu sidebar, tab Cài đặt/Báo cáo (theo quyền + công tắc tính năng), nút hành động, vào thẳng URL không quyền, phạm vi dữ liệu khách — kỳ vọng tính từ `/auth/me` của chính phiên đó. |
| `rbac-api.spec.ts` | **Ma trận quyền qua API** × 5 tài khoản: GET theo quyền (200/403), GHI không quyền → 403, không token → 401, phạm vi own/team/subtree/all trên khách/deal/thẻ Kanban của bộ seed, SĐT che theo `contacts.phone_full`, ngoài phạm vi theo id → 404. Phần dữ liệu cần seed; phần ma trận chạy được không cần seed. |
| `design/*.spec.ts` (3 project `design-mobile` 390×844 · `design-tablet` 768×1024 · `design-desktop` 1440×900) | Chuẩn thiết kế: ≤1 nút nền đặc chủ đạo/màn; điện thoại: không tràn ngang + nút chính trong vùng ngón cái; khung cảm ứng (390 + 768): vùng chạm ≥40px; popup nằm trọn trong khung. Read-only, role ADMIN. |
| `flows/*.spec.ts` | **GHI**, chỉ khi `E2E_ALLOW_WRITE=1`, chạy SAU các project đọc (có flow bật/tắt công tắc tính năng nên không được song song với smoke). Khách hàng, Kanban (kéo thả thật), sản phẩm, POS, bảng tin (+bình luận/thích), vai trò, dashboard, component dùng chung; **nhân sự** (`hr`), **chấm công** (`attendance`: tạo đơn → duyệt/từ chối), **lương** (`payroll`: xem theo quyền), **cài đặt** (`settings`: vai trò hẹp → đăng nhập kiểm, tuỳ chọn, khoá API, công tắc tính năng), **kết nối & AI** (`integrations`: webhook vào/ra, OAuth PKCE → MCP, duyệt đề xuất AI). |
| `helpers/` | `roles.ts`, `api.ts`, `monitor.ts`, `routes.ts` (**danh sách trang — khai ở 1 chỗ**; đối chiếu `components/nav-config.ts` + `lib/org-feature-routes.ts`), `known-issues.ts` (lỗi đã biết + **lỗi sản phẩm do E2E phát hiện**), `app-config.ts`, `data.ts`, `manifest.ts` (manifest seed/dọn), `scope.ts`, `frames.ts` (3 khung), `oauth-mcp.ts` (PKCE + JSON-RPC MCP). |
| `run-full.mjs` | Một lệnh `pnpm e2e:full`. |

## Bộ dữ liệu seed (`seed/seed.setup.ts`)

Mọi bản ghi mang tiền tố `E2E-<timestamp>-…`; tạo qua API bằng đúng tài khoản chủ sở hữu (mỗi tài khoản tạo khách của CHÍNH MÌNH để có phạm vi own/team/subtree/all thật).

| Loại dữ liệu | Số lượng | Mục đích |
|---|---|---|
| Khách hàng | 12 (3 × 4 chủ: SALE, LEAD, DEPT_HEAD, ADMIN; 4 giai đoạn, 2 nguồn; có SĐT) | `rbac-api`/`rbac-ui`: phạm vi `own/team/subtree/all`, che SĐT, 404 ngoài phạm vi; chi tiết khách cho smoke |
| Deal | 4 (mở ×2, thắng, thua; giao SALE/LEAD/DEPT_HEAD) | Phạm vi `deals.view` |
| Kanban | 1 bảng + 3 cột + 4 thẻ (giao SALE/LEAD/DEPT_HEAD/ADMIN) | Phạm vi `kanban.view` theo người được giao |
| Sản phẩm / Dự án | 1 / 1 | Trang Sản phẩm, Dự án |
| Nhân sự | 1 chức danh, 1 nhân viên (+tài khoản), 1 hợp đồng, 1 ứng viên | Flow `hr` (HR thấy trên UI, sửa, khoá, chấm dứt hợp đồng) |
| Bảng tin | 1 bài + 1 bình luận (SALE) + 1 lượt thích (LEAD) | Flow `newsfeed` |
| Cài đặt | 1 vai trò hẹp (`contacts.view: own`) + 1 user giữ vai trò đó | Flow `settings`: đăng nhập user hẹp, quyền đổi NGAY khi sửa vai trò |
| (do flow tạo & tự dọn) | webhook vào ×2, webhook ra ×1, khách qua webhook/MCP ×≈7, client OAuth ×3, đề xuất AI ×3, đơn chấm công ×2, khoá API ×1, tuỳ chọn danh mục ×1 | `integrations`, `attendance`, `settings` |

POS không được seed: ca/đơn đã thu không xoá được nên `flows/pos` chỉ chạy khi quán chưa có ca đang mở.

## Dọn dữ liệu & residual

Cleanup chỉ dùng API (không SQL, không ssh). Bản ghi mà API chỉ xoá **mềm** hoặc không có API xoá được liệt kê ở `e2e/.cleanup-residual.json` (`byTable` + `records`) để người vận hành xoá hẳn: `contacts`, `users` (mỗi `POST /users` còn kèm 1 hồ sơ `employees`), `employees`, `projects`, `kanban_boards/_columns/_cards`, `setting_options`, `api_keys`, `attendance_requests`, `oauth_clients` (+ token/code), `ai_action_drafts`, `pos_*` (nếu flow POS chạy). File tích luỹ giữa các lần chạy cho tới khi bạn xoá nó.

## Chạy

```bash
cd trinity/apps/web
cp e2e/.env.e2e.example e2e/.env.e2e      # file này gitignore — điền mật khẩu vào ĐÂY, không commit
set -a; source e2e/.env.e2e; set +a        # hoặc export từng biến trong shell

pnpm e2e            # smoke + rbac-ui + rbac-api (read-only, an toàn chạy trên môi trường thật; rbac-api bỏ qua ca cần seed)
pnpm e2e:design     # 3 khung: 390×844, 768×1024, 1440×900 (read-only)
pnpm e2e:full       # TOÀN BỘ: seed → mọi project → cleanup → tóm tắt (E2E_ALLOW_WRITE=1 tự bật)
pnpm e2e:seed       # chỉ seed (để soi dữ liệu thử; nhớ pnpm e2e:cleanup sau đó)
pnpm e2e:cleanup    # chỉ dọn theo manifest (dùng token trong e2e/.auth → chạy sau 1 lần đăng nhập)
pnpm e2e:report     # mở báo cáo HTML pha read (ảnh chụp, trace); pha khác: npx playwright show-report playwright-report/flows
```

Biến môi trường:

- `E2E_BASE_URL` — mặc định `http://localhost:3000` (instance tự dựng). Chạy local: `http://localhost:3000`.
- `E2E_BROWSER_CHANNEL=chrome` — dùng Google Chrome hệ thống (Chromium bundled trên máy dev hay hỏng). Mặc định `chromium`.
- `E2E_<ROLE>_EMAIL` / `E2E_<ROLE>_PASSWORD` với ROLE ∈ `ADMIN, SALE, LEAD, DEPT_HEAD, HR`. **Không bao giờ ghi mật khẩu vào file được commit.** Role nào thiếu env thì test của role đó `skip` có lý do.
- `E2E_ALLOW_WRITE=1` — bật seed/flows/cleanup (`pnpm e2e:full` tự đặt). `E2E_WORKERS` — số worker (mặc định 5; **trên máy yếu hoặc môi trường nhỏ nên đặt ≤ 3** — thấy 502/ChunkLoadError giả thì giảm xuống 2). Project `flows` luôn chạy 1 worker.
- `E2E_PHASE=read|flows|cleanup` — do `run-full.mjs` đặt (chọn tập project + thư mục `test-results/<pha>`, `playwright-report/<pha>`); `E2E_ISOLATED=1` — cho phép ca đổi công tắc tính năng khi chạy lẻ `--project=flows`.

`pnpm e2e:full` (= `e2e/run-full.mjs`) chạy 3 pha liên tiếp: **read** (`seed` + `smoke`, `rbac-ui`, `rbac-api`, `design-*` song song ≤ `E2E_WORKERS`) → **flows** (luồng GHI, 1 worker; dùng dữ liệu seed trong manifest) → **cleanup** (LUÔN chạy, cả khi pha trước đỏ/chết; nếu manifest còn mục thì chạy lại). Tách pha vì Playwright bỏ qua project phụ thuộc khi project đọc có ca đỏ (lỗi sản phẩm đã ghi nhận không được chặn flows) và vì flow đổi công tắc tính năng tổ chức không được song song với smoke. Cuối lệnh in bảng pass/fail/skip theo project, thời gian, ca đỏ, residual. Chạy lẻ: `E2E_ALLOW_WRITE=1 playwright test --project=flows` (không đặt `E2E_PHASE`) = seed → flows → cleanup (teardown), đặt thêm `E2E_ISOLATED=1` để bật ca đổi công tắc.

Kết quả: `test-results/` (ảnh chụp, trace, `report.json`), `playwright-report/`.

## ⚠️ Một phiên mỗi tài khoản

Khi môi trường bật "1 phiên/tài khoản" (token có `sid`, đăng nhập mới đá phiên cũ), **Không đăng nhập cùng tài khoản test (tay, script, API login) khi suite đang chạy**, nếu không `storageState` bị vô hiệu giữa chừng. Suite phát hiện `/auth/refresh` thất bại trên một trang thì fail với thông báo "PHIÊN BỊ ĐÁ" thay vì liệt kê như lỗi app — chạy lại là hết. Tốt nhất dùng tài khoản e2e riêng cho suite.

## Khi nào chạy

1. **Sau MỖI lần deploy** — `pnpm e2e` (đợi `/api/build-id` đổi sang build mới rồi mới chạy); sau thay đổi lớn: `pnpm e2e:full`.
2. Sau khi sửa phân quyền / thêm trang / đổi menu — `pnpm e2e`.
3. Trước khi tuyên bố xong một thay đổi lớn ở giao diện nghiệp vụ — `pnpm e2e:full` (dữ liệu demo; tự dọn).

Lỗi test ≠ lỗi app: xem ảnh chụp + dòng lỗi trong báo cáo. Lỗi đã biết đang chờ bản sửa thì thêm vào `helpers/known-issues.ts` (chỉ gắn nhãn `[ĐÃ BIẾT, đang sửa]`, test VẪN đỏ), xoá mục đó khi bản sửa đã lên PROD.

## Thêm trang mới

1. Thêm trang vào `components/nav-config.ts` (+ `permission`) và gate `<PermissionGate>`/`<Forbidden />` trong page như bình thường.
2. Thêm **một dòng** vào `ROUTES` trong `e2e/helpers/routes.ts`: `path`, `name`, `title` (regex khớp một `<h1>`), `need` (quyền cần để vào, bỏ trống nếu mọi người đã đăng nhập). Smoke chạy tự động cho mọi role.
3. Có nút hành động phụ thuộc quyền? thêm vào bảng `ACTIONS` trong `rbac-ui.spec.ts`.
4. Có tab Cài đặt/Báo cáo mới? Không cần làm gì — `helpers/app-config.ts` đọc từ mã nguồn.

## Thêm ca mới khi thêm tính năng

1. **Trang mới** → 1 dòng trong `ROUTES` (`helpers/routes.ts`); nếu thuộc công tắc tính năng, thêm vào `lib/org-feature-routes.ts` (smoke tự kiểm màn "đang tắt").
2. **Endpoint mới có quyền** → thêm 1 dòng vào `READS`/`WRITES` trong `rbac-api.spec.ts` (`perm` đúng khoá catalog — gõ sai là lỗi biên dịch).
3. **Dữ liệu mới cần cho nhiều test** → tạo trong `seed/seed.setup.ts` (dùng `mkContact/mkUser/mkRole` ở `seed/lib.ts` hoặc `record({...})` với `del` + `soft` nếu API chỉ xoá mềm) — **mỗi bản ghi tạo ra PHẢI vào manifest ngay khi tạo**; `seed/snapshot.ts` thêm loại bản ghi mới để kiểm "số bản ghi thật trước = sau".
4. **Luồng nghiệp vụ mới** → file `flows/<tên>.spec.ts` bắt đầu bằng `requireWrite()`; dữ liệu `prefix('…')`; không dùng `Date.now()` làm mã đối chiếu nếu API che chuỗi số dài (tóm tắt đề xuất AI che mọi chuỗi số như SĐT — dùng mã CHỮ).
5. **Ca phụ thuộc cấu hình chưa có** (khoá dịch vụ ngoài) → `test.skip(cond, 'lý do rõ')`, không giả xanh.
6. **Phát hiện lỗi sản phẩm** → KHÔNG sửa code sản phẩm, KHÔNG nới test: thêm mục vào `PRODUCT_ISSUES` (`helpers/known-issues.ts`: mức độ, bằng chứng, file:dòng nghi ngờ), test dùng `issueTag(id)` trong thông điệp và VẪN đỏ cho tới khi bản sửa lên PROD.

## Chuẩn thiết kế (project `design-*`)

`pnpm e2e:design` chạy 3 project (`design-mobile`/`design-tablet`/`design-desktop`, khung khai ở `helpers/frames.ts`): `primary-cta.spec.ts` — mỗi trang chính (và mỗi tab, tối đa 10) chỉ ≤ 1 nút nền đặc chủ đạo ngoài dialog; `mobile-thumb-zone.spec.ts` — tràn ngang, nút chính vùng ngón cái (chỉ 390), vùng chạm ≥40px (khung cảm ứng); `popup-in-frame.spec.ts` — hộp thoại nằm trọn trong khung. Chỉ đọc, role ADMIN, không nằm trong `pnpm e2e` mặc định. Route lấy chung từ `helpers/routes.ts`.

## Lưu ý

- Sản phẩm: `DELETE /products/:id` xoá cứng (409 nếu đã có đơn/khách tham chiếu).
- POS: ca/đơn đã thu không xoá được nên flow POS chỉ chạy khi quán chưa có ca đang mở; nếu có ca (dữ liệu demo) thì skip có lý do.
- Webhook ra trong test LUÔN trỏ về `http://localhost:3000/api/v1/hooks/in/<token>` của chính hệ thống (không gửi dữ liệu ra ngoài); bên nhận trả 400 vì khác định dạng là bình thường — kiểm delivery được ghi nhận.
- Không gửi tin nhắn hay email thật ra ngoài.
- Allowlist lỗi console/API ở `helpers/monitor.ts` — mỗi mục có lý do; thêm mục mới phải nêu lý do.
