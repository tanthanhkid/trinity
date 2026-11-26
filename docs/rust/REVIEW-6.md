# Phản biện lần 6 (kiểm chốt): PLAN.md và ISSUES.md (viết lại backend bằng Rust)

Ngày 26/11/2026 · Worktree `rust-plan` (HEAD `fef6dab`, `docs/rust` chưa commit) · Người phản biện độc lập. Không sửa
plan hay mã, không build hay test. Không phản biện các quyết định trong `DECISIONS.md`, chỉ nêu hệ quả kỹ thuật chưa được ghi.
Đối chiếu Next.js 16.3.8 (bản `apps/web/package.json` dùng) ở `trinity-review/node_modules/.pnpm/next@16.3.8…`.

## Tóm tắt

| Phần | Kết quả |
|---|---|
| A. 9 phát hiện lượt 5 | 8 ĐÃ XỬ LÝ · 1 ĐÃ XỬ LÝ nhưng cách sửa chưa đủ (B5-QT-1 → B6-QT-1, B6-QT-2, B6-QT-3). Không mục nào CHƯA hay SAI |
| B. Phát hiện mới | **0 CHẶN · 3 QUAN TRỌNG · 8 NHỎ** (cả 3 QUAN TRỌNG đều nằm ở luật IP 5 điểm) |
| `check-issues.py` | 185 issue = 37 S + 98 M + 50 L = 216,5 ngày-agent; 0 trùng, 0 tham chiếu thiếu, **0 vòng**. G 20 · C 31,5 · K+D+T+W 38 · M 98 · X 25. X06 24,5; D01 10,5; X02a 12; W02b 22; tổng thể X15a/X15b 25,5. Khớp PLAN mục 0, 7, 11, Lịch sử lượt 5 và cuối ISSUES (chuỗi W02b script in qua `X03 → W02b`, ISSUES ghi qua `X14 → W02b`: cùng độ dài, không sai) |

**Kết luận: CHƯA ĐỦ**: 3 QUAN TRỌNG, cả ba trong G16 (và K16/D01 theo sau); sửa bằng vài dòng ở G16, K16, D01, PLAN
4.13, không thêm giai đoạn, không đụng đường găng. Làm ngay được R001–R006, G01–G15, C01–C18, K01–K15 và các issue K/M
không nằm sau K16/K17.

---

## A. Trạng thái các phát hiện lượt 5

| Mã | Trạng thái | Kiểm ở đâu | Ghi chú |
|---|---|---|---|
| B5-QT-1 (tin `cf-connecting-ip` theo loopback/mạng riêng) | ĐÃ XỬ LÝ, **cách sửa chưa đủ** | PLAN 4.13 (814–836), 4.14 (878–880), 10.1 #33 (1224); G16 (ISSUES:56), K16 (:109), K17 (:110) | Luật "loopback/mạng riêng" đã bỏ hẳn, đúng. Nhưng luật 3 đặt ở route handler của Next không làm được như viết và cắt đường của luật 4 (B6-QT-1); 5 chỗ đọc IP khác của Node không được chuyển sang header có chữ ký (B6-QT-2); `CF_TUNNEL=true` là tin vô điều kiện (B6-QT-3) |
| B5-QT-2 (W03 cần `/site-config` mà Node không có) | ĐÃ XỬ LÝ | W03 (:135) phụ thuộc W02b, K27; X06 (:226) phụ thuộc W03; K27 (:120) "đợt a"; PLAN 5 bước 7 | Hệ quả mới: `build:export` của W02a gặp `force-dynamic` ở `/privacy`, `/terms` (B6-N-1) |
| B5-N-1 (W02b sát X06) | ĐÃ XỬ LÝ | W02b (:134) phụ thuộc thêm X03, X04, X05, X09, X10, X14 | Chữ "xếp chồng **ngay dưới** X06" giờ lệch vì W03 nằm giữa (B6-N-8) |
| B5-N-2 (cổng chính) | ĐÃ XỬ LÝ | PLAN 4.13 (809–812); X06; X14 ca `.env` cũ có `PORT=4000` | `TRINITY_HTTP_PORT` chưa nằm trong danh sách "Biến mới" (B6-N-6) |
| B5-N-3 (`API_PORT` phía host) | ĐÃ XỬ LÝ | X06 `127.0.0.1:${API_PORT:-4000}`; X14 ca `API_PORT=4100` | |
| B5-N-4 (Next 3001 trong compose lai) | ĐÃ XỬ LÝ | D01 (:130); PLAN 4.13 (859–860) | Còn tên máy `api` trong địa chỉ Next gọi Node, không phân giải được trong namespace chung (B6-N-2) |
| B5-N-5 (golden cuối) | ĐÃ XỬ LÝ | PLAN 6.1 dòng 969, 6.2 (1037–1039), 10.1 #35; X03 (:223), X06 | Khoảng X03 → X06 còn sửa lỗi TS được (B6-N-7) |
| B5-N-6 (`SOCIAL_MAX_VIDEO_MB` hai chỗ) | ĐÃ XỬ LÝ | G15 (:55) | |
| B5-N-7 (bảng giai đoạn) | ĐÃ XỬ LÝ | PLAN 7 dòng GĐ 4; ISSUES "Dài nhất tổng thể (25,5 ngày)" | |

---

## B. Phát hiện mới

### QUAN TRỌNG

#### B6-QT-1. Luật 3 ở route handler của Next không lấy được IP peer và xoá `X-Real-IP` của Caddy/nginx: sau G16, mọi bản cài theo `docs/deployment.md` thấy mọi khách là IP của proxy

- **Liên quan:** G16 (ISSUES:56) vế (b), (c); PLAN 4.13 luật 3–4 (826–832); `docs/deployment.md` (bước 4: Caddy/nginx →
  `web:3000` → Next chuyển `/api/v1` sang API).
- **Bằng chứng:**
  - **Next không cho route handler địa chỉ socket.** Next 16 bỏ `NextRequest.ip`; cách duy nhất là header
    `x-forwarded-for`, mà Next chỉ điền khi client **không** gửi: `req.headers['x-forwarded-for'] ??= originalRequest.socket.remoteAddress`
    (`next/dist/server/base-server.js:612`). Client gửi `X-Forwarded-For` giả thì route handler nhận đúng giá trị giả.
    Luật 3 bảo route handler "đặt `x-trinity-client-ip`" và "proxy ngoài cùng là nơi áp luật 2" (xét peer có thuộc
    dải Cloudflare), nhưng không nói lấy peer từ đâu. Không có lớp bọc máy chủ (custom server quanh `server.js` của
    `standalone`) thì cả luật 1 lẫn luật 2 ở Next đều không làm được. Ca test (1) của G16 sẽ đỏ, và plan không chỉ
    cách làm cho xanh.
  - **Luật 3 cắt đường của luật 4.** Luật 3: route handler **xoá** `x-real-ip`, `x-forwarded-for`… rồi ký IP nó xác
    định. Luật 4: Caddy/nginx ghi đè `X-Real-IP` và người vận hành bật `*_TRUST_PROXY_HEADERS`, nhưng cờ đó được đọc ở
    **backend** (luật 4 "Không bật thì quay về luật 1"; K16 cũng đặt nó ở Rust). Với topo tài liệu đang hướng dẫn
    (Caddy/nginx → Next → Node), `X-Real-IP` do Caddy ghi bị Next xoá trước khi tới backend; Next chỉ ký được peer của
    nó là Caddy (`127.0.0.1` ở PM2; cổng cầu Docker `172.x` ở compose). Không có cấu hình nào cho ra IP thật.
  - **Hậu quả cụ thể theo mã:** cổng Wi-Fi đăng nhập: PM2 nhận `127.0.0.1` ⇒ `isUnusableLoginIp` đúng
    (`login-wifi-check.helper.ts:127-133`) ⇒ `fail_open_no_usable_ip` (`auth.service.ts:279-285`), cổng **tắt lặng lẽ**;
    compose nhận `172.x` (không bị coi là "không dùng được") ⇒ so với IP văn phòng ⇒ **khoá đăng nhập** mọi người dùng
    thuộc diện kiểm. Kiểm IP chấm công so với IP proxy ⇒ từ chối hoặc sai. Khoá giới hạn tốc độ đăng nhập
    (`auth.controller.ts:53`, `public-auth.controller.ts:79` dùng cùng hàm) dồn về một khoá cho mọi khách.
  - **Container `web` không có bí mật để ký:** service `web` chỉ có `NODE_ENV`, `BACKEND_URL`, `MONOLITH_INTERNAL_URL`,
    `AUTH_SERVICE_URL` (`docker-compose.yml:129-133`); không có `INTERNAL_SERVICE_SECRET`, `CLOUDFLARE_IP_RANGES`, cờ
    `*_TRUST_*`. G16 ghi "chạy được trên compose hiện tại" nhưng không ghi thêm env cho `web` (và cho tiến trình Next
    ở PM2, image `trinity-web` phát hành).
- **Tác động:** G16 là sửa lỗi bảo mật đi vào bản phát hành TS công khai (giai đoạn 1); làm đúng chữ thì mọi bản cài
  sau Caddy/nginx (đường tài liệu chính) mất IP khách cho chấm công và cổng Wi-Fi từ lúc đó tới X06 (4–5 tháng).
- **Đề xuất:** ghi vào G16 và 4.13: (1) Next là "proxy ngoài cùng" phía ứng dụng nên **áp đủ luật 1, 2, 4** chứ không
  chỉ luật 2: tin `X-Real-IP` khi `*_TRUST_PROXY_HEADERS` bật, tin `cf-connecting-ip` khi peer thuộc dải Cloudflare;
  (2) lấy peer bằng lớp bọc mỏng quanh `server.js` của `standalone` (xoá `x-trinity-peer-ip` của client, đặt bằng
  `req.socket.remoteAddress`, rồi giao cho handler của Next), vì Next 16 không lộ socket; (3) thêm `INTERNAL_SERVICE_SECRET`
  và các cờ IP vào service `web`, `.env.example` phần web, hướng dẫn PM2; (4) thêm ca dương tính: "Caddy ghi đè
  `X-Real-IP` + cờ bật → Next → Node thấy IP thật" và "Cloudflare → compose `web` trực tiếp → Node thấy IP trong
  `cf-connecting-ip`". Cỡ G16 nên lên L hoặc tách G16a (Node: helper + chỗ đọc, B6-QT-2) / G16b (Next: lớp bọc + ký).

#### B6-QT-2. Chỉ hai helper được chuyển sang header có chữ ký; các chỗ đọc IP khác của Node dồn mọi khách về một khoá giới hạn tốc độ sau G16/K17

- **Liên quan:** G16 (chỉ nêu `attendance-ip.helper.ts`, `login-wifi-check.helper.ts`); K16 ("giữ nguyên hành vi của
  7 cách lấy IP hiện có … gồm `oauth-rate-limits.ts` chỉ tin `x-real-ip` từ 127.0.0.1"); K17 (xoá `x-real-ip`,
  `x-forwarded-for` trước khi chuyển sang Node); D01 tiêu chí "`oauth-rate-limits` của Node thấy `127.0.0.1`".
- **Bằng chứng:**
  - `oauth-rate-limits.ts:5-11`: tin `x-real-ip` khi socket là loopback, ngược lại `req.ip`. Dùng làm khoá cho
    `register`, `token`, `revoke` (`oauth.controller.ts:75,89,101`).
  - `store.controller.ts:18`: `x-forwarded-for[0]` rồi `req.ip`; dùng làm khoá `perIp` khi đặt đơn
    (`store.service.ts:165`).
  - `api-key.guard.ts` (auth :42, crm :113): `request.ip` để ghi/kiểm theo IP của khoá API; `connectors.controller.ts:469-471`
    (`x-forwarded-for[0]`, sẽ gỡ theo quyết định 4).
  - Sau G16 (Next xoá mọi header IP) và K17 (Rust xoá trước khi chuyển sang Node), các chỗ này không còn header nào để
    đọc ⇒ khoá = IP của Next/Rust (`127.0.0.1` hoặc IP container). Giới hạn "theo IP" thành giới hạn **chung cho mọi
    khách**: một khách đặt nhiều đơn làm mọi khách khác của cửa hàng nhận 429; một client MCP làm mọi client khác bị từ
    chối `token`/`register`. Tiêu chí D01 đang đóng khung đúng hành vi hỏng này ("thấy `127.0.0.1`").
  - K16 "giữ nguyên" luật tin `x-real-ip` từ 127.0.0.1 ở Rust mâu thuẫn luật (d) của G16; Rust sau Caddy cùng máy
    (topo sau X06) có peer `127.0.0.1`, Caddy mặc định chuyển nguyên `X-Real-IP` của client ⇒ giả IP để vượt giới hạn
    OAuth.
- **Đề xuất:** G16 gom **mọi** chỗ đọc IP của Node về một hàm dùng chung (đọc `x-trinity-client-ip` có chữ ký, không
  có thì IP peer), liệt kê đủ file ở trên; K16 sửa "giữ nguyên 7 cách" thành "mọi route dùng IP đã xác định theo luật
  4.13; riêng `store` lấy phần tử đầu của `x-forwarded-for` là lỗi, không tái tạo"; tiêu chí D01 đổi thành "`oauth-rate-limits`
  của Node thấy IP thật của client (qua header có chữ ký)". Thêm ca: hai client khác IP qua Next/Rust có bộ đếm giới hạn
  riêng.

#### B6-QT-3. `CF_TUNNEL=true` tin `cf-connecting-ip` từ mọi peer; compose công bố cổng web ra mọi địa chỉ nên Tunnel vẫn giả IP được

- **Liên quan:** PLAN 4.13 luật 2 (823–825); G16 vế (a); K16 ("hoặc `CF_TUNNEL=true`"); quyết định 8 (Tunnel là một
  trong hai cách TLS chính thức).
- **Bằng chứng:** chữ của luật: tin khi peer thuộc dải Cloudflare **hoặc** `CF_TUNNEL=true`, không ràng buộc peer.
  Compose hiện công bố `"${WEB_PORT:-3000}:3000"` (mọi địa chỉ, `docker-compose.yml:135`), X06 "giữ cổng mặc định 3000";
  cổng Docker công bố đi vòng qua `ufw`. Người dùng Tunnel thường không tự đóng cổng ⇒ ai gửi thẳng `http://<ip>:3000`
  kèm `CF-Connecting-IP: <IP văn phòng>` vẫn được tin: đúng lỗ lượt 4 (B-QT-2) ở một trong hai cấu hình được khuyến nghị.
  Năm ca test của G16 không có ca Tunnel nào.
- **Đề xuất:** `CF_TUNNEL=true` chỉ tin khi peer thuộc `CF_TUNNEL_PEERS` (mặc định loopback; compose có service
  `cloudflared` thì ghi IP/tên của nó); tài liệu Tunnel đổi cổng công bố thành `127.0.0.1:${WEB_PORT:-3000}` (hoặc không
  công bố, `cloudflared` là service trong compose). Ca test: cờ bật, peer ngoài `CF_TUNNEL_PEERS` kèm header giả ⇒ bỏ qua.

### NHỎ

| # | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|
| B6-N-1 | `build:export` của W02a gặp `export const dynamic = "force-dynamic"` ở `/privacy`, `/terms`; Next từ chối xuất tĩnh trang `force-dynamic`, và cấu hình đoạn route phải là hằng số nên không bật/tắt theo biến lúc build được. Việc đổi hai trang này nay nằm ở W03 (sau W02b), nên tiêu chí W02a "40 trang mở được", K18, W04 và việc chủ dự án bật `web: rust` sớm không đạt như viết. Bảng PLAN 5 chỉ liệt kê 3 file `force-dynamic` (`not-found`, `s/[slug]`, `build-id`) | `app/privacy/page.tsx:5`, `app/terms/page.tsx:5`; PLAN 912, 917; W02a (:133) | W02a ghi cách xử lý riêng cho bản xuất (vd tệp trang thay thế theo `pageExtensions` lúc `build:export`, đọc `/site-config` và lùi về chữ chung khi 404), W03 chỉ còn bỏ bản `standalone`. Khi phục vụ `/privacy`, `/terms`, Rust có thể chèn giá trị pháp lý vào HTML như cách chèn slug ở K18, để trình thu thập của Meta thấy tên đơn vị mà không cần chạy JS |
| B6-N-2 | Compose lai: `web` dùng `network_mode: service:trinity` nên tên `api` không phân giải; Next vẫn gọi Node qua `BACKEND_URL=http://api:4000` (route handler, `/uploads`) và `MONOLITH_INTERNAL_URL=http://api:4000` **nhúng lúc build** vào rewrite `/.well-known` | `docker-compose.yml:127,131-133`; `next.config` dòng 48; D01 | D01 ghi: dựng `web` với `MONOLITH_INTERNAL_URL=http://127.0.0.1:4000`, `BACKEND_URL` cùng giá trị; hoặc ghi K17 chuyển `/uploads`, `/.well-known` thẳng sang Node trong lai |
| B6-N-3 | `*_TRUST_CF_IP`, `*_TRUST_PROXY_HEADERS` là hai cặp cờ riêng (`ATTENDANCE_…`, `LOGIN_WIFI_…`), trong khi Rust (K17) và Next (G16) chỉ ký **một** IP gửi sang Node. Hai cặp đặt khác nhau thì không có IP nào đúng cho cả hai | `attendance-ip.helper.ts:45,51`; `login-wifi-check.helper.ts:85`; K16, K17 | Gộp thành `TRUST_CF_IP`, `TRUST_PROXY_HEADERS` (tên cũ là bí danh, cảnh báo khi hai tên cũ lệch nhau) |
| B6-N-4 | Chữ ký HMAC chỉ trên giá trị IP thì phát lại được mãi nếu một header đã ký lọt ra (log, thông báo lỗi). Đồng thời `INTERNAL_SERVICE_SECRET` vừa là bí mật dạng so thẳng của `@Internal` (`x-service-secret`) vừa thành khoá HMAC, và nay phải nằm trong tiến trình Next | PLAN 216, 826–829 | Ký `ip|unix_ts` và chỉ nhận trong ±60 giây; dẫn khoá ký riêng bằng HKDF từ `INTERNAL_SERVICE_SECRET` |
| B6-N-5 | G16 cỡ M thấp: lớp bọc `server.js`, gom 7 chỗ đọc IP, env cho `web`, cấu hình mẫu Caddy/nginx, 5+3 ca test, `CHANGELOG`/`SECURITY.md` | G16 (:56) | L hoặc tách đôi như B6-QT-1 đề xuất (+0,5 hoặc +1 ngày, không chạm đường găng X06) |
| B6-N-6 | Danh sách "Biến mới" ở PLAN 4.13 (805–810) thiếu `TRINITY_HTTP_PORT`, `COMPAT_API_PORT`, `CLOUDFLARE_IP_RANGES`, `CF_TUNNEL`, `SOCIAL_MAX_VIDEO_MB`; tệp `.env.example` là nơi người tự cài nhìn | PLAN 805–812, 823–825 | Thêm vào danh sách và vào `.env.example` ở issue tương ứng (G15, G16, X06) |
| B6-N-7 | Golden ghi lần cuối ở X03, nhưng giữa X03 và X06 (chờ X04, X05, X09, X10, X14 song song) bản TS vẫn nhận sửa lỗi (quyết định 6), ví dụ chính G16 nếu còn sửa tiếp. Một bản sửa lỗi TS ở khoảng đó làm golden lệch Node cuối | X03 (:223); PLAN 1037–1039 | Ghi luật: sửa lỗi TS merge sau X03 phải ghi lại golden của route liên quan trong cùng PR (hoặc chặn sửa lỗi TS sau X03 trừ bảo mật) |
| B6-N-8 | W02b vẫn ghi "PR xếp chồng **ngay dưới X06**" trong khi W03 nằm giữa (W02b → W03 → X06); X14 kiểm trên nhánh X06 nhưng không có ca trang pháp lý | W02b (:134); PLAN 5 bước 6; X14 (:238) | Sửa chữ thành "chồng W02b → W03 → X06"; X14 thêm ca: sau nâng cấp, `/privacy` hiện `LEGAL_COMPANY_NAME` của `.env` cũ |

---

## C. Kiểm ISSUES

| Tiêu chí | Kết quả |
|---|---|
| Số liệu PLAN ↔ ISSUES | Khớp: 185 issue, 37/98/50, 216,5 ngày; "khoảng 118,5 ngày các giai đoạn khác" (= 216,5 − 98); bảng giai đoạn 4 / 20 / 31,5 / 38 / 98 + 10,5 / 14,5 |
| Phụ thuộc | Không vòng, không tham chiếu thiếu. Cạnh mới lượt 5 đúng chiều: W02b → X03, X04, X05, X09, X10, X14; W03 → W02b; X06 → W03. Sau W02b chỉ còn W03, X06 (và X15a/b sau X06) |
| Mỗi issue một PR | Đạt |
| Tiêu chí xong đo được | Đạt, trừ G16 (thiếu ca dương tính qua Caddy/nginx và ca Tunnel, B6-QT-1, B6-QT-3), D01 (tiêu chí "thấy `127.0.0.1`" mâu thuẫn G16, B6-QT-2), W02a (`build:export` không qua được hai trang `force-dynamic`, B6-N-1) |
| Đường găng | X06 24,5 · D01 10,5 · X02a 12 · W02b 22 · tổng thể 25,5. Khớp |

## Kết luận

**CHƯA ĐỦ**: còn 3 QUAN TRỌNG, cùng gốc ở luật IP 5 điểm: route handler của Next không lấy được IP peer và xoá
`X-Real-IP` của Caddy/nginx nên topo tài liệu mất IP khách (B6-QT-1); các chỗ đọc IP khác của Node không được chuyển
nên giới hạn "theo IP" thành giới hạn chung (B6-QT-2); `CF_TUNNEL=true` tin header từ mọi peer (B6-QT-3). Sửa bằng vài
dòng ở G16, K16, D01, PLAN 4.13; 0 CHẶN; 8 NHỎ sửa trong PR của từng issue (B6-N-1 cần sửa trước khi làm W02a).
