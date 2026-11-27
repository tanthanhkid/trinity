# Runbook — Bật một đợt và lui không mất dữ liệu

Issue X01 (PLAN mục 6.5 và 6.6; tệp sở hữu: PLAN 4.14, `docs/rust/ownership-node.md`). Áp dụng cho các issue X02a–X02e và cho mọi lần đổi sở hữu
route hoặc job giữa Node và Rust trên bản đang chạy cấu hình lai (`docs/runbooks/hybrid.md`).

Ba nguyên tắc:

1. **Lui là đổi đường chạy, không phải quay ngược dữ liệu.** Sửa tệp sở hữu trả route và job về Node rồi `SIGHUP`. Không khởi động lại tiến trình nào.
2. **Không bao giờ khôi phục bản dump đè lên DB đang chạy.** Từ lúc đổi sở hữu tới lúc phát hiện lỗi (có thể 1–3 ngày) cả Node lẫn Rust vẫn ghi đơn,
   chấm công, tin nhắn của khách vào cùng DB; khôi phục đè sẽ xoá chúng. Dump chỉ để **đối chiếu và sửa có chọn lọc** (mục 6).
3. **Bên mới nhận trong cùng lần ghi tệp mà bên cũ nhả.** Không bao giờ có khoảng trống (job không ai chạy) giữa hai lần ghi.

## 0. Cái gì đã có, cái gì chưa

| Thành phần | Trạng thái trên `main` |
|---|---|
| `docs/runbooks/hybrid.md`, `docker-compose.hybrid.yml`, `deploy/hybrid/ownership.json` (mặc định mọi thứ thuộc Node) | có (D01) |
| Tệp sở hữu: Rust nạp lại khi `SIGHUP`, Node đọc lại ở đầu mỗi lượt tick (`packages/rbac-nest/src/ownership.ts`, K17, T01); tệp hỏng thì giữ bảng cũ và ghi lỗi | có |
| Mẫu tệp đợt a: `server/contracts/ownership-wave-a.json` | có (chỉ 5 route health/ready/live/telemetry/site-config) |
| `trinity check-config` (kiểm cả tệp sở hữu), `trinity check-invariants` (X11), `trinity check-routes`, `trinity migrate --status`, `trinity healthcheck` | có (`server/crates/trinity-bin/src/main.rs`) |
| `docs/rust/invariants.md` (lịch hằng ngày và hằng giờ) | có |
| Lấy mẫu shadow (`SHADOW_SAMPLE_RATE`, `safe_for_shadow` và `min_samples` trong `server/contracts/routes.json`; K28) | mã có trong crate `trinity-http`, nhưng **chưa thấy nối vào `trinity serve`** và chưa có đường xuất báo cáo cho người vận hành: chưa có, kiểm lại trạng thái K28 trước khi tính 48 giờ shadow |
| Script kiểm điều kiện đổi chủ `stale-work.digest` (mục 5) | chưa có tệp script riêng; mục 5 có đoạn SQL mẫu, chưa chạy thử trên DB thật |
| Quét GET trên bản sao dữ liệu thật cho route thiếu mẫu | có (X13): `docs/runbooks/sweep.md`, `tests/contract/sweep/` |
| Mẫu từng đợt `deploy/hybrid/mau/ownership-dot-<đợt>.json` (cộng dồn, chỉ là mẫu) và `docs/runbooks/cutover-cac-dot.md` | có cho đợt a, b, c, d, e (đủ a–e) |
| Script sao lưu tự động toàn bộ DB và volume trước đợt | chưa có; dùng lệnh ở mục 2 |
| Script kiểm trước / bật / lui từng đợt a–e (`scripts/ops/cutover-dot.sh`; kiểm shadow, dump, X11, sao lưu và đổi tệp sở hữu; không dump) | có (X02a–e); xem `cutover-cac-dot.md` |
| Lưu WAL (PITR) | tuỳ chọn, hướng dẫn mục 7; cấu hình Postgres chưa nằm trong compose |
| Tệp sở hữu dùng khi chạy | `deploy/hybrid/ownership.json` (compose gắn thư mục `./deploy/hybrid` vào `/etc/trinity`, chỉ đọc) |

## 1. Danh sách kiểm trước khi bật (mỗi đợt)

Theo PLAN 6.5 và các dòng X02a–X02e trong `docs/rust/ISSUES.md`. Mọi ô phải xong, ghi bằng chứng vào issue của đợt:

- [ ] Đợt trước (nếu có) đã qua 72 giờ đầu và bộ kiểm bất biến xanh.
- [ ] 100% ca hợp đồng của các module trong đợt đạt trên Rust; độ phủ route 100% theo `routes.json` (`trinity check-routes`).
- [ ] So trạng thái DB các kịch bản ghi: không khác biệt ngoài danh sách cho phép có lý do.
- [ ] **48 giờ shadow** trên lưu lượng thật: mỗi route `safe_for_shadow` đạt `min_samples` (mặc định 50) hoặc được quét bù bằng X13 (`docs/runbooks/sweep.md`); tỉ lệ khác biệt bằng 0 sau khi trừ danh sách cho phép. Route `cached: true` chỉ so hình dạng trên lưu lượng thật.
- [ ] **Công ty thử chạy 24 giờ** cho mọi module có đường ghi trong đợt.
- [ ] Không có lỗi 5xx mới so với trước đợt.
- [ ] Bộ nhớ đỉnh của Rust khi chạy bộ hợp đồng không vượt ngưỡng (PLAN mục 9).
- [ ] `trinity check-invariants` xanh ngay trước khi bật (dùng `--state` để có mốc).
- [ ] Đã diễn tập lui (mục 4.2) trên môi trường thử, dưới 2 phút, không khởi động lại tiến trình nào.
- [ ] Điều kiện riêng của đợt (mục 3).
- [ ] Đã có dump và bản chụp thư mục file (mục 2), đã kiểm đọc được.
- [ ] Hai người vận hành biết lệnh lui và ai quyết định lui.

## 2. Sao lưu ngay trước khi đổi sở hữu

Làm **ngay trước** lần ghi tệp, không làm từ hôm trước (dump cũ đối chiếu kém). Quy trình hiện tại chỉ dump khi có migration; đợt bật đổi đường ghi mà không có migration nào, nên bước này bắt buộc.

Toàn bộ DB, mọi schema (`platform`, `public`, `c_<id>`), dạng custom để restore từng bảng:

```
TS=$(date +%Y%m%d-%H%M%S); mkdir -p /srv/backup/cutover-$TS && cd /srv/backup/cutover-$TS
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc --no-owner "$POSTGRES_DB" > db.dump   # Docker
# hoặc: pg_dump "$DATABASE_URL" -Fc --no-owner > db.dump                                             # bản chạy bằng trình quản lý tiến trình
pg_restore -l db.dump | head -5 && ls -l db.dump       # đọc được, kích thước hợp lý
sha256sum db.dump > db.dump.sha256
```

Tên người dùng và DB lấy từ `.env`. Dump không gồm role cụm; nếu cần: `pg_dumpall --globals-only > globals.sql`.

Thư mục file (volume `storage` gắn ở `/var/lib/trinity/storage`, `uploads` ở `/app/uploads`; hai volume dùng chung cho Node và Rust):

```
docker volume ls                                       # tìm tên thật (có tiền tố project compose)
for v in storage uploads; do
  docker run --rm -v <project>_$v:/src:ro -v "$PWD":/out alpine tar czf /out/$v.tar.gz -C /src .
done
ls -l storage.tar.gz uploads.tar.gz
```

Bản chạy trực tiếp trên máy: `tar czf uploads.tar.gz -C <thư mục uploads> .` và tương tự cho `STORAGE_LOCAL_ROOT`.

Chép thêm: `.env` (chế độ 600), `deploy/hybrid/ownership.json` hiện tại (đặt tên `ownership.before.json`, dùng để lui) và mốc X11 (`/var/lib/trinity/invariants.json`).
Giữ dump của mỗi đợt tới hết đợt kế tiếp cộng 14 ngày; đặt ngoài máy chủ, mã hoá, giới hạn quyền (chứa dữ liệu khách).

## 3. Điều kiện riêng từng đợt

Ngoài tiêu chí chung ở mục 1 (danh sách route theo đợt nằm ở các issue X02a–e và `routes.json`):

| Đợt | Nội dung | Thêm vào danh sách kiểm |
|---|---|---|
| a (X02a) | health, cài đặt, tuỳ chọn (M06) | Mẫu `server/contracts/ownership-wave-a.json` (chỉ route `/api/v1`; `/api/build-id` thuộc Next, `/docs` thuộc Node không đổi). `site-config` phải thuộc `rust` vì bản TS không có |
| b (X02b) | auth, người dùng, vai trò (M01–M05), bật cả cụm cùng lúc | Không ai bị đăng xuất; test hai chiều của migrator (K07) đạt trên bản sao schema thật; đăng ký một công ty thử bằng Rust rồi `prisma migrate status` báo đã cập nhật |
| c (X02c) | khách hàng, kanban, bảng tuỳ biến, báo cáo | Chuông thông báo tới client khi việc tạo ở Rust mà socket còn ở Node |
| d (X02d) | nhân sự, chấm công, lương, bán hàng, trang bán hàng, thông báo | **Chuyển cả job** của M23, M24, M32 trong cùng lần ghi tệp; mỗi job chỉ một bên chạy; `stale-work.digest` theo mục 5; người duyệt đã xem mẫu phiếu lương PDF và 4 tệp xuất chấm công do Rust sinh (đính kèm issue); cần T01 |
| e (X02e) | tích hợp, MCP, Facebook, Zalo, đăng bài | **Mọi** route, job và tool MCP có gọi Graph/Zalo ra chuyển trong **cùng một** lần đổi sở hữu; job không chạy trùng; sau khi đổi, kiểm log 1 giờ không còn lời gọi Graph nào xuất phát từ Node; cần T01 |

Tên job hợp lệ trong tệp sở hữu (`KNOWN_JOBS` trong `server/crates/trinity-kernel/src/ownership.rs`): `integrations.webhook-dispatch`, `facebook.flows`, `facebook.broadcasts`, `social.publish`, `social.metrics`, `briefings.run-due`, `lead-scoring.run`, `stale-work.digest`, `integrations.ai-action-expiry`, `integrations.outbox-purge`, `integrations.oauth-purge`, `notification.scheduled`. Job không ghi trong tệp mặc định là `node`. `migrate` (migrate nền lúc boot) cũng có chủ riêng.

## 4. Sửa tệp sở hữu: bật và lui

Định dạng (xem `deploy/hybrid/ownership.json`): `routes` là danh sách `{ "prefix", "methods" (tuỳ chọn), "owner": "rust" | "node" }`, `jobs` là `{ "tên-job": "rust" | "node" }`, và `migrate`. Luật khớp: **tiền tố dài nhất + phương thức** (ví dụ `settings` thuộc đợt a, `settings/channel-guard` thuộc đợt e). Khoá lạ hoặc trùng, chủ khác `rust|node`, tiền tố có `/` cuối hoặc xung đột đều làm cả tệp bị coi là hỏng.

### 4.1 Bật

Một lần ghi duy nhất: **Rust nhận và Node nhả cùng lúc** (route và job của đợt đổi trong cùng một tệp). Không sửa hai bước (nhả trước, nhận sau) vì job sẽ không ai chạy; chồng một lượt thì chấp nhận được với job nhận việc nguyên tử theo dòng, trống thì không.

```
cd <repo>
cp deploy/hybrid/ownership.json /srv/backup/cutover-$TS/ownership.before.json
cp deploy/hybrid/ownership.json deploy/hybrid/ownership.json.new      # sửa bản .new: thêm route, đổi job sang "rust"
# kiểm trước khi thay (mã 0 mới đi tiếp):
TRINITY_OWNERSHIP_FILE=$PWD/deploy/hybrid/ownership.json.new trinity check-config
mv -f deploy/hybrid/ownership.json.new deploy/hybrid/ownership.json    # đổi tên nguyên tử, cùng thư mục
docker compose -f docker-compose.yml -f docker-compose.hybrid.yml kill -s HUP trinity   # Docker
# hoặc: kill -HUP "$(pidof trinity)"                                                    # trình quản lý tiến trình
```

Phải đổi tên (`mv`) trong cùng thư mục, không ghi đè tại chỗ, để hai bên không đọc phải nửa tệp; compose gắn **thư mục** nên việc đổi tên được thấy trong container.
Node không cần tín hiệu: tự đọc lại ở đầu lượt tick kế. Sau khi ghi: log của Rust không có lỗi nạp tệp; gọi smoke vào một route của đợt; job thuộc Rust chạy ở lượt kế và Node bỏ lượt.
Tệp hỏng giữa chừng thì cả hai bên giữ bảng cũ và ghi lỗi: sửa tệp rồi gửi lại `SIGHUP`. Tệp hỏng lúc khởi động thì Node từ chối khởi động (không rơi về "mọi thứ thuộc Node").

Sau khi bật: chạy `trinity check-invariants` ngay, rồi đổi sang lịch **mỗi giờ trong 72 giờ đầu** (`docs/rust/invariants.md`, mục "Lịch"; bỏ dòng hằng ngày trong lúc đó). Đỏ thì dừng bật đợt kế.

### 4.2 Lui

Dưới 2 phút, không khởi động lại tiến trình nào:

```
cp /srv/backup/cutover-$TS/ownership.before.json deploy/hybrid/ownership.json.new   # hoặc sửa tay: trả route VÀ job của đợt về "node"
TRINITY_OWNERSHIP_FILE=$PWD/deploy/hybrid/ownership.json.new trinity check-config
mv -f deploy/hybrid/ownership.json.new deploy/hybrid/ownership.json
docker compose -f docker-compose.yml -f docker-compose.hybrid.yml kill -s HUP trinity
```

Trả **cả route lẫn job** của đợt trong cùng một lần ghi (Node nhận, Rust nhả). Riêng `stale-work.digest`, kiểm lại mục 5 trước khi trả về Node (chiều ngược lại cũng có nguy cơ gửi trùng). Sau đó: ca smoke đạt trên Node, `trinity check-invariants`, ghi lý do lui vào issue.

Lui không hoàn tác migration: DB tương thích hai chiều trong giai đoạn lai (không migration phá huỷ, hash mật khẩu và token giữ định dạng cũ, bảng mới chỉ ở `platform`, dòng Rust ghi phải đọc được bằng mã Node).
Lui cả cấu hình lai (đưa origin thẳng về Next + Node): `docs/runbooks/hybrid.md` mục 5. Giữ bản build Node sẵn sàng cho tới hết 14 ngày sau X06.

**Diễn tập (tiêu chí hoàn thành X01):** trên môi trường thử, bật một đợt rồi lui theo 4.2; đo thời gian (dưới 2 phút) và kiểm không tiến trình nào có PID mới (`docker compose ps`/`ps`).

## 5. Job `stale-work.digest`: điều kiện đổi chủ

Job này **không** nhận việc nguyên tử: `runOnce` (`services/crm/src/stale-work/stale-work.service.ts`) đọc dấu "đã gửi hôm nay" (`settings.key = 'stale_work_last_digest'`, giá trị là ngày Việt Nam `YYYY-MM-DD`), gửi cho mọi người, rồi mới ghi dấu. Chồng một lượt khi đổi chủ là gửi trùng bản tổng hợp cho cả công ty. Job gửi ở **mọi lượt** từ `digest_hour` trở đi tới khi ghi được dấu (lần gửi lỗi thì không ghi dấu, thử lại cả ngày).

Chỉ đổi chủ (cả hai chiều) khi, **với mọi công ty** (schema `public` và `c_<id>`), có ít nhất một điều đúng:

- (a) cờ `stale_reminders` không bật (settings `org_features`);
- (b) giờ Việt Nam hiện tại < `digest_hour` của công ty (settings `stale_work_config`, mặc định 8);
- (c) dấu `stale_work_last_digest` = ngày Việt Nam hôm nay.

Job còn bị tắt mặc định bằng env `STALE_REMINDERS_ENABLED=true` (phía Node); env tắt thì không có nguy cơ trùng. Làm ngoài khung giờ gửi. Bản Rust phải nhận lượt qua `platform.job_runs` trước khi gửi (M24).

Script kiểm mẫu (chưa có tệp script chính thức; chạy thử trên bản sao DB trước, kiểm tên khoá và kiểu cột `settings.value` đúng với `server/contracts/schema.sql`):

```sql
-- psql; lặp mọi schema công ty; phải kết thúc bằng NOTICE "an toàn", không thì EXCEPTION liệt kê schema chưa an toàn.
DO $$
DECLARE s text; vn_hour int; vn_date text; feat text; cfg text; dh int; last text; bad text := '';
BEGIN
  vn_hour := extract(hour from (now() at time zone 'Asia/Ho_Chi_Minh'));
  vn_date := to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD');
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname = 'public' OR nspname ~ '^c_[0-9]+$' LOOP
    EXECUTE format('SELECT value FROM %I.settings WHERE key = %L', s, 'org_features') INTO feat;
    IF feat IS NULL OR coalesce((feat::jsonb ->> 'stale_reminders')::boolean, false) THEN
      EXECUTE format('SELECT value FROM %I.settings WHERE key = %L', s, 'stale_work_config') INTO cfg;
      dh := coalesce((cfg::jsonb ->> 'digest_hour')::int, 8);
      EXECUTE format('SELECT value FROM %I.settings WHERE key = %L', s, 'stale_work_last_digest') INTO last;
      IF NOT (vn_hour < dh OR last = vn_date) THEN bad := bad || ' ' || s; END IF;
    END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'KHÔNG đổi chủ stale-work.digest, chưa an toàn:%', bad; END IF;
  RAISE NOTICE 'an toàn để đổi chủ stale-work.digest (%, % giờ)', vn_date, vn_hour;
END $$;
```

Công ty chưa có dòng `org_features` được tính là **chưa an toàn** (script trên coi `NULL` như bật) vì giá trị mặc định có thể bật cờ theo gói ngành (`packages/rbac/src/industry-presets.ts`); loại trừ tay nếu chắc chắn đã tắt. `digest_hour` đổi được trong lúc chờ: chạy script ngay trước lần ghi tệp và ghi tệp trong vài phút.

## 6. Sửa dữ liệu có chọn lọc (không khôi phục đè)

Khi nghi Rust ghi sai (bộ kiểm bất biến đỏ, shadow hoặc so DB phát hiện, khách báo):

1. **Lui trước** (mục 4.2) để chặn ghi sai thêm.
2. **Khôi phục bản dump của đợt vào DB riêng**, không phải DB đang chạy:
   ```
   createdb trinity_restore_<đợt>          # máy riêng hoặc instance khác, ổ mã hoá
   pg_restore --no-owner -d trinity_restore_<đợt> /srv/backup/cutover-$TS/db.dump
   ```
   Không bao giờ trỏ `pg_restore` vào `DATABASE_URL` thật, và không dùng `--clean` với DB thật.
3. **So theo bảng và dòng mà module của đợt ghi** (bảng 6.1). Với mỗi bảng: đếm dòng, và so theo khoá chính các dòng cũ hơn thời điểm đổi sở hữu giữa bản restore và DB đang chạy. Dòng chỉ có ở DB đang chạy phần lớn là dữ liệu hợp lệ khách ghi sau dump: **đừng xoá**. Chỉ dòng có ở cả hai bên mà giá trị lệch, hoặc dòng Rust ghi sai định dạng, mới là ứng viên sửa.
   ```
   psql "$RESTORE_URL" -Atc "\copy (select * from public.contacts order by id) to 'a.csv' csv"
   psql "$DATABASE_URL" -Atc "\copy (select * from public.contacts where updated_at < '<thời điểm đổi>' order by id) to 'b.csv' csv"
   diff a.csv b.csv
   ```
4. **Viết script sửa đúng các dòng lệch** (`UPDATE ... WHERE id IN (...)`, giá trị lấy từ bản restore); chạy thử trên một bản sao của DB đang chạy.
5. **Chạy script trong một giao dịch có đếm số dòng trước và sau**: `BEGIN; select count(*)...; UPDATE ...; select count(*)...;` số dòng đổi phải đúng bằng số dự kiến, rồi mới `COMMIT`; sai thì `ROLLBACK`.
6. Chạy `trinity check-invariants` (dùng `--accept` chỉ khi thay đổi là chủ ý), ghi script, số dòng và người duyệt vào issue.
7. Xoá DB restore khi xong.

### 6.1 Bảng theo module

Rút từ `server/contracts/schema.sql` (mọi bảng ở `public` của từng schema công ty trừ khi ghi khác). Đây là điểm khởi đầu: xác nhận lại bằng danh sách route của đợt trong `routes.json`.

| Module (đợt) | Bảng |
|---|---|
| Cài đặt, tuỳ chọn (a) | `settings`, `setting_options` |
| Auth, người dùng, vai trò (b) | `users`, `user_invitations`, `roles`, `role_permissions`, `user_roles`, `teams`, `active_sessions`, `revoked_sessions`, `token_blacklist`, `api_keys`, `rbac_audit_log`, `audit_logs`; `platform.companies`, `platform.company_logins`, `platform.company_routes` khi đăng ký công ty |
| Khách hàng, deal, kanban, bảng tuỳ biến, báo cáo (c) | `contacts`, `contact_recent_views`, `deals`, `activities`, `projects`, `kanban_boards`, `kanban_columns`, `kanban_cards`, `kanban_card_activities`, `kanban_card_assignees`, `kanban_card_attachments`, `kanban_checklist_items`, `kanban_field_defs`, `custom_objects`, `custom_fields`, `custom_records`, `custom_views`, `custom_schema_versions`, `record_links`, `kpi_configs`, `kpi_results` |
| Nhân sự, chấm công, lương (d) | `employees`, `employee_contracts`, `employment_periods`, `job_titles`, `recruitment_candidates`, `recruitment_positions`, `attendance_offices`, `attendance_qr_sessions`, `attendance_records`, `attendance_requests`, `login_wifi_check_targets`, `payslips`, `payroll_tax_settings`, `salary_components`, `salary_rules`, `salary_rule_details`, `tax_brackets`, `insurance_settings` |
| Bán hàng, trang bán hàng (d) | `products`, `product_categories`, `product_attribute_defs`, `pos_areas`, `pos_modifiers`, `pos_orders`, `pos_order_items`, `pos_payments`, `pos_settings`, `pos_shifts`, `pos_tables`, `store_orders`, `payment_intents` |
| Thông báo, bản tin, nhắc việc (d) | `notification_logs`, `notification_templates`, `briefings`, `lead_ai_intents`, `settings` (khoá `stale_work_last_digest`), `newsfeed_posts`, `newsfeed_post_comments`, `newsfeed_post_images`, `newsfeed_post_likes`; `platform.job_runs` nếu Rust đã tạo |
| Tích hợp, MCP, webhook (e) | `webhook_endpoints`, `webhook_deliveries`, `webhook_inbound_sources`, `webhook_inbound_receipts`, `integration_events`, `integration_audit_logs`, `connector_accounts`, `connector_events`, `connector_records`, `oauth_clients`, `oauth_tokens`, `oauth_authorization_codes`, `ai_action_drafts`, `channel_events`, `channel_usage`, `extensions`, `extension_versions`, `google_connections`, cùng các bảng lưu trữ của tính năng đã gỡ (xem migration `0026_ghi_chu_bang_luu_tru`) |
| Facebook, Zalo, đăng bài (e) | `facebook_pages`, `facebook_conversations`, `facebook_messages`, `facebook_comments`, `facebook_comment_rules`, `facebook_flows`, `facebook_flow_runs`, `facebook_broadcasts`, `facebook_broadcast_recipients`, `facebook_chat_links`, `facebook_lead_receipts`, `zalo_oa_connections`, `zalo_oa_messages`, `zalo_oa_oauth_states`, `zalo_oa_threads`, `social_accounts`, `social_drafts`, `social_media_assets`, `social_posts`, `social_post_targets`, `social_queue_slots`, `social_recurrences`, `social_snippets` |

Tệp trong `storage`/`uploads` đối chiếu bằng bản chụp mục 2 (so danh sách tệp, băm tệp nghi vấn); không giải nén đè lên thư mục đang chạy.

**Diễn tập sửa có chọn lọc (tiêu chí hoàn thành X01):** trên môi trường thử, chụp dump; cố ý ghi sai 20 dòng qua một đường ghi của đợt; lui; khôi phục dump vào DB riêng; dùng bước 3–5 để tìm và sửa lại **đúng 20 dòng đó**, không chạm dòng khác (đếm trước và sau).

## 7. Tuỳ chọn: lưu WAL để khôi phục theo thời điểm (PITR)

Không bắt buộc. Dành cho bản cài cần khôi phục tới một thời điểm (ví dụ ngay trước lúc Rust bắt đầu ghi sai). Nó **không thay** mục 6: khôi phục PITR vẫn làm vào một instance riêng để lấy dòng đúng ra đối chiếu; khôi phục đè lên DB đang chạy vẫn xoá dữ liệu khách ghi sau thời điểm đó.

Cấu hình Postgres (`postgresql.conf` hoặc tham số `-c` của service `postgres`; cần khởi động lại Postgres một lần, làm trong cửa sổ bảo trì, không gộp vào bước bật đợt):

```
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /wal_archive/%f && cp %p /wal_archive/%f'
archive_timeout = 300
```

Gắn volume `wal_archive` ở ổ khác, mã hoá. Lấy **base backup** ngay trước mỗi đợt (cùng với `pg_dump`):

```
pg_basebackup -h <host> -U <user> -D /srv/backup/base-$TS -Ft -z -Xs -P
```

Khôi phục trên máy riêng: giải nén base backup vào thư mục dữ liệu trống, đặt `restore_command = 'cp /wal_archive/%f %p'`, `recovery_target_time = '<UTC>'`, `recovery_target_action = 'promote'`, tạo `recovery.signal`, khởi động; dùng instance đó làm DB đối chiếu ở bước 2 mục 6. Theo dõi dung lượng `wal_archive`, chỉ xoá WAL cũ hơn base backup còn giữ. Cấu hình này chưa có trong `docker-compose*.yml`; thêm khi người vận hành chọn bật.

## 8. Tham chiếu

- PLAN: mục 4.14 (tệp sở hữu, shadow), 6.5 (tiêu chí bật đợt), 6.6 (lui không mất dữ liệu), mục 3 điểm 3 (job và `stale-work.digest`).
- Issue: K17, K28, D01, T01, X02a–X02e, X03, X11, X13, M24.
- Tài liệu: `docs/runbooks/hybrid.md`, `docs/rust/invariants.md`, `docs/rust/ownership-node.md`, `docs/runbooks/fast-delivery.md`.
