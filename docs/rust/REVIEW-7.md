# Phản biện lần 7 (kiểm chốt): PLAN.md và ISSUES.md (viết lại backend bằng Rust)

Ngày 26/11/2026 · Worktree `rust-plan` (HEAD `fef6dab`, `docs/rust` chưa commit) · Người phản biện độc lập. Không sửa plan hay mã, không build
hay test. Không phản biện các quyết định trong `DECISIONS.md`, chỉ nêu hệ quả kỹ thuật chưa được ghi. Đối chiếu Next.js 16.3.8
(bản `apps/web/package.json` dùng) ở `trinity-review/node_modules/.pnpm/next@16.3.8…`, và mã thật trong `services/`,
`apps/web/src`, `apps/monolith/test`, `docker-compose.yml`, `Dockerfile`.

## Tóm tắt

| Phần | Kết quả |
|---|---|
| A. 11 phát hiện lượt 6 | 11 ĐÃ XỬ LÝ; không mục nào CHƯA hay SAI. Bốn cách sửa sinh hệ quả mới (B6-QT-1 → B7-QT-1; B6-N-4 → B7-QT-2; B6-N-3 → B7-QT-3; B6-QT-3 → B7-N-1, B7-N-2) |
| B. Phát hiện mới | **0 CHẶN · 3 QUAN TRỌNG · 8 NHỎ**. Cả 3 QUAN TRỌNG nằm ở luật IP mới (4.13, G16a, G16b, K16, K17) |
| `check-issues.py` | 186 issue = 37 S + 98 M + 51 L = 218,5 ngày-agent; 0 trùng, 0 tham chiếu thiếu, **0 vòng**. G 22 · C 31,5 · K 32 · D 1 · T 1 · W 4 · M 98 · X 25. X06 24,5; D01 10,5; X02a 12; W02b 22; tổng thể X15a 25,5. Khớp PLAN mục 0, 11 (120,5 = 218,5 − 98), Lịch sử lượt 6 và cuối ISSUES |

**Kết luận: CHƯA ĐỦ**: 3 QUAN TRỌNG đều trong luật IP (hai đường giả/vượt IP với cấu hình mặc định hoặc theo đúng chữ plan, một
topo chính theo quyết định 8 không có giá trị `TRUSTED_PROXY` đúng). Sửa bằng vài dòng ở 4.13, G16a, G16b, K16, K17; không
thêm issue, không đụng đường găng. Làm ngay được mọi thứ không nằm sau G16a/G16b/K16/K17.

---

## A. Trạng thái các phát hiện lượt 6

| Mã | Trạng thái | Kiểm ở đâu | Ghi chú |
|---|---|---|---|
| B6-QT-1 (Next không lấy được IP peer, xoá `X-Real-IP` của Caddy) | ĐÃ XỬ LÝ | PLAN 4.13 luật 1–2 và bảng 6 cách; G16b (ISSUES:57) | Tệp nạp trước khả thi với Next 16 standalone (xem B-phụ lục). Nhưng truyền peer bằng **header** thì thiếu tệp nạp trước ⇒ client tự đặt được peer (B7-QT-1) |
| B6-QT-2 (các chỗ đọc IP khác của Node) | ĐÃ XỬ LÝ | G16a (:56) liệt kê đủ; K16 bỏ "giữ nguyên 7 cách"; D01 tiêu chí "IP thật, hai client bộ đếm riêng" | `grep` lại mã: đủ 9 chỗ trong `services` (2 helper, 2 guard API key, `oauth-rate-limits`, `store.controller`, `connectors.controller`), cộng `fe-logging` ở web (G16b có). Sót các test e2e dựa vào `x-real-ip` (B7-N-4) |
| B6-QT-3 (`CF_TUNNEL=true` tin mọi peer) | ĐÃ XỬ LÝ (cách khác đề xuất) | 4.13 bảng `cloudflare-tunnel`; G16a; K16 | Ràng buộc "chỉ nghe loopback" chỉ ghi ở G16a (Node API) và K16 (Rust), không ở G16b, trong khi ở bản TS tiến trình biên của tunnel là **Next** (B7-N-1); xung đột với cổng tương thích 4000 sau X06 (B7-N-2) |
| B6-N-1 (`force-dynamic` ở `/privacy`, `/terms`) | ĐÃ XỬ LÝ | Bảng PLAN 5 (5 file); W02a (:134); K18 | Tiêu chí W02a "hiện tên đơn vị khi Rust phục vụ" không đo được trong W02a (B7-N-7) |
| B6-N-2 (tên `api` trong compose lai) | ĐÃ XỬ LÝ | 4.14; D01 | |
| B6-N-3 (hai họ cờ) | ĐÃ XỬ LÝ | 4.13 luật 1; G16a | Ánh xạ bí danh đổi nghĩa cờ cũ: khoá hoặc mở nhầm (một phần của B7-QT-3) |
| B6-N-4 (HMAC phát lại, khoá chung) | ĐÃ XỬ LÝ | 4.13 luật 2; G16a | ±60 giây đúng cho tiến trình cùng máy; nhưng kiểm hạn **sau khi đọc body** + "chữ ký sai thì cho qua" ⇒ vượt kiểm bằng body chậm (B7-QT-2) |
| B6-N-5 (cỡ G16) | ĐÃ XỬ LÝ | G16a L, G16b M | |
| B6-N-6 (biến mới) | ĐÃ XỬ LÝ | 4.13 dòng 805–811 | Thiếu biến chọn địa chỉ nghe của Next ở tunnel (B7-N-3) |
| B6-N-7 (golden sau X03) | ĐÃ XỬ LÝ | 6.2 (1067); X03 (:224) | |
| B6-N-8 (chồng W02b → W03 → X06) | ĐÃ XỬ LÝ | W02b (:135); X14 (:239) | |

---

## B. Phát hiện mới

### QUAN TRỌNG

#### B7-QT-1. Peer truyền bằng header `x-trinity-peer-ip`: thiếu tệp nạp trước thì client tự khai peer, giả được IP ngay cả với `TRUSTED_PROXY=none` mặc định

- **Liên quan:** PLAN 4.13 luật 2 (đoạn "Next 16 không cho route handler biết địa chỉ kết nối…"); G16b; bảng 6 cách, dòng 1
  (trình quản lý tiến trình, Caddy/nginx → Next → API).
- **Bằng chứng:**
  - Tệp nạp trước chỉ có hiệu lực khi lệnh chạy có `-r ./peer-ip.cjs`. Với Docker, G16b sửa `CMD` trong `Dockerfile` (hiện
    `CMD ["node", "apps/web/server.js"]`, dòng 66) nên ổn. Với dòng 1 (PM2/systemd), lệnh chạy nằm trong cấu hình PM2 của
    người vận hành, ngoài repo: bản cài nâng cấp bằng `git pull && build && pm2 restart` giữ lệnh cũ, không có `-r`.
  - Khi đó route handler vẫn đọc `x-trinity-peer-ip` từ `req.headers`. Không có lớp xoá, giá trị là của **client**; Caddy
    (`reverse_proxy` trong `docs/deployment.md` dòng 32–33) và nginx chuyển nguyên header lạ. Plan không nói route handler
    làm gì khi header này vắng hay không do tệp nạp trước đặt.
  - Với `TRUSTED_PROXY=none` (mặc định), luật là "IP khách = IP peer" ⇒ IP khách = giá trị client tự khai ⇒ Next **ký** giá trị
    đó ⇒ API tin. Client gửi `x-trinity-peer-ip: <IP văn phòng>` là qua cổng Wi-Fi đăng nhập và kiểm IP chấm công. Với
    `cidr:127.0.0.1/32`, client khai peer `127.0.0.1` kèm `X-Real-IP` giả, cùng kết quả.
  - Không có lỗi hay cảnh báo nào: lỗ mở **lặng lẽ**, đúng ở topo "hiện tại" của bảng.
- **Đề xuất:** không truyền peer bằng header. Tệp nạp trước bọc request listener trong `AsyncLocalStorage.run({peer}, …)`;
  route handler chạy cùng tiến trình, cùng chuỗi async nên đọc được store (Next dùng ALS riêng, lồng vào không vỡ). Thiếu
  store (không có tệp nạp trước) ⇒ coi là "IP không tin được" + log lỗi cấu hình, **không** đọc header nào. Nếu vẫn giữ
  header: tệp nạp trước sinh nonce ngẫu nhiên mỗi tiến trình vào `globalThis`, header mang nonce; route handler từ chối
  khi `globalThis` không có nonce hoặc không khớp. Thêm `NODE_OPTIONS=--require …` vào `.env.example` phần web và mẫu PM2.
  Ca test G16b: chạy `server.js` **không** có tệp nạp trước, gửi `x-trinity-peer-ip` giả ⇒ API thấy "IP không tin được".

#### B7-QT-2. Chữ ký được kiểm sau khi đọc xong body, và chữ ký sai/quá hạn thì "cho qua": gửi body chậm quá 60 giây là vượt kiểm Wi-Fi và kiểm IP chấm công

- **Liên quan:** PLAN 4.13 luật 2 (±60 giây) và luật 3 ("chữ ký sai/thiếu bí mật … cho qua"); G16a ("đi qua một tiến trình
  Trinity mà chữ ký sai" ⇒ không tin được ⇒ cho qua; ca "quá hạn … bị từ chối" rồi rơi về luật peer); K17 (chuyển body
  dạng stream không đệm); G16b.
- **Bằng chứng:**
  - Chỗ gọi hàm IP nằm trong handler, sau khi body đã đọc xong: `attendance.service.ts:827` (check-in kèm `selfie` multipart,
    tức multer đã nhận hết tệp), `auth.controller.ts:53` (sau body-parser). Hàm dùng chung của G16a thay đúng các chỗ này.
  - Rust (K17) chuyển header ngay rồi stream body theo tốc độ client. Client nhỏ giọt body đăng nhập hoặc check-in trong 61
    giây ⇒ lúc Node kiểm, chữ ký đã quá hạn ⇒ "không tin được" ⇒ **cho qua**. Không cần biết bí mật.
  - Next (G16b): route handler hiện dựng header trước (`route.ts` dòng 130–137) rồi mới `await req.arrayBuffer()` (dòng 141);
    đặt chữ ký ở chỗ dựng header là chỗ tự nhiên ⇒ cùng lỗ. Node mặc định cho tới 300 giây (`requestTimeout`) để gửi body,
    Caddy không đệm body request.
  - Người dùng thật trên mạng di động chậm gửi ảnh selfie cũng rơi vào nhánh này (vô hại cho họ, nhưng cho thấy đường đi có thật).
- **Đề xuất:** (1) Node kiểm chữ ký **lúc nhận header**, trước body-parser và multer (lắng nghe `request` của http server hoặc
  `app.use` đăng ký trước khi Nest gắn parser), lưu IP đã xác định vào `req`; hàm dùng chung chỉ đọc kết quả đó. Rust (K16)
  làm tương tự: xác định ở tầng nhận request. (2) Next và Rust ký **ngay trước khi gửi** sang API (sau khi đệm body ở Next).
  (3) Tách hai trường hợp ở luật 3: *thiếu cấu hình* (không có bí mật, không có header vì phía trước không phải Trinity) thì
  cho qua + cảnh báo như plan; *có header mà chữ ký sai hoặc quá hạn* là bất thường, không phải lỗi cấu hình ⇒ với route có
  kiểm IP thì từ chối (401/400), không cho qua. Ca test G16a và K17: body nhỏ giọt 61 giây ⇒ không vượt được kiểm IP.

#### B7-QT-3. Topo "Cloudflare proxy → Caddy/nginx → Next" (đường TLS chính theo quyết định 8 ở bản TS) không có giá trị `TRUSTED_PROXY` đúng; `cidr:` ưu tiên `X-Real-IP` mà Caddy mặc định và Cloudflare không ghi; bí danh cờ cũ đổi nghĩa

- **Liên quan:** PLAN 4.13 luật 1 (bảng giá trị) và bảng 6 cách; G16a (bí danh); G16b (cấu hình mẫu Caddy/nginx "ghi đè
  `X-Real-IP`"); K16 (ca "Rust sau Caddy/nginx cùng máy"); X14 ("cờ `*_TRUST_*` kiểu cũ … kiểm IP cho cùng kết quả");
  `DECISIONS.md` mục 8.
- **Bằng chứng:**
  - Quyết định 8: luôn đứng sau proxy Cloudflare, origin dùng Origin Certificate. Ở bản TS, Next không kết thúc TLS, nên
    Origin Certificate nằm ở Caddy/nginx: topo thực tế là **Cloudflare → Caddy/nginx → Next → API**. Bảng 6 cách không có
    dòng này. Thử từng giá trị đặt ở Next:
    - `cloudflare`: peer là `127.0.0.1` (Caddy), ngoài dải Cloudflare ⇒ IP peer ⇒ "không tin được" ⇒ kiểm Wi-Fi và chấm
      công **cho qua** (tắt, có cảnh báo).
    - `cidr:127.0.0.1/32` với mẫu "ghi đè `X-Real-IP`" (`header_up X-Real-IP {remote_host}`, `proxy_set_header X-Real-IP
      $remote_addr`): giá trị là **IP biên Cloudflare**, một IP công khai "hợp lệ" nên luật 3 không bắt ⇒ so với IP văn
      phòng ⇒ **khoá đăng nhập** mọi người thuộc diện kiểm, chấm công bị từ chối, mọi khách chung một xô giới hạn tốc độ.
      Lấy phần tử phải cùng của `X-Forwarded-For` cũng ra IP biên Cloudflare (Caddy ≥ 2.5 thay XFF bằng peer khi peer không
      thuộc `trusted_proxies`; nginx `$proxy_add_x_forwarded_for` nối peer vào cuối).
  - `cidr:` đọc `X-Real-IP` **trước**. Caddy mặc định không đặt `X-Real-IP` (chỉ đặt `X-Forwarded-*`), Cloudflare cũng không
    đặt và chuyển nguyên header của client. Người vận hành làm theo cảnh báo "đặt `TRUSTED_PROXY`" mà giữ Caddyfile cũ của
    `docs/deployment.md` ⇒ client gửi `X-Real-IP: <IP văn phòng>` là được tin. Phần tử phải cùng của XFF thì an toàn với
    Caddy mặc định, nginx thông thường và Cloudflare; thứ tự hiện tại chọn đúng header kém an toàn hơn.
  - Bí danh: `.env.example` dòng 215–218 ghi `*_TRUST_PROXY_HEADERS=true` dành cho "proxy (vd PaaS) kết nối từ **địa chỉ
    công khai**". G16a ánh xạ sang `cidr:` các dải riêng ⇒ peer công khai nằm ngoài danh sách ⇒ IP = IP proxy của PaaS (hợp
    lệ) ⇒ khoá đăng nhập. `*_TRUST_CF_IP=true` sau Caddy (cách dùng hiện nay, `login-wifi-check.helper.ts:33–36`) ánh xạ
    sang `cloudflare` ⇒ peer loopback ⇒ cho qua. Tiêu chí X14 "kiểm IP cho cùng kết quả" không thể đạt với hai nhóm này.
- **Đề xuất:** (1) Cho `TRUSTED_PROXY` nhận chuỗi tin cậy, ví dụ `cidr:127.0.0.1/32,cloudflare`: lấy giá trị từ proxy trong
  `cidr`, nếu giá trị đó thuộc `CLOUDFLARE_IP_RANGES` thì lấy tiếp `cf-connecting-ip`; thêm dòng "Cloudflare → Caddy/nginx →
  Next" (và "→ Rust" cho K16) vào bảng. Hoặc tối thiểu: mẫu Caddy dùng `trusted_proxies static <dải Cloudflare>` +
  `client_ip_headers CF-Connecting-IP` + `header_up X-Real-IP {client_ip}`; mẫu nginx dùng `set_real_ip_from <dải>` +
  `real_ip_header CF-Connecting-IP` + `proxy_set_header X-Real-IP $remote_addr`. (2) `cidr:` mặc định đọc phần tử phải cùng
  của `X-Forwarded-For`; chỉ đọc `X-Real-IP` khi ghi tường minh (`cidr:…;header=x-real-ip`). (3) Cờ cũ `*_TRUST_PROXY_HEADERS=true`
  và `*_TRUST_CF_IP=true` không ánh xạ ngầm: dừng khởi động với thông báo chỉ giá trị `TRUSTED_PROXY` tương ứng topo; sửa
  tiêu chí X14 theo. (4) Ca test: Cloudflare giả (đặt `CLOUDFLARE_IP_RANGES` gồm IP máy thử) → Caddy → Next → API thấy IP
  trong `cf-connecting-ip`; Caddyfile cũ + `cidr:` + `X-Real-IP` giả ⇒ không được tin.

### NHỎ

| # | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|
| B7-N-1 | Ràng buộc "`cloudflare-tunnel` chỉ nghe loopback, không thì từ chối khởi động" nằm ở G16a (Node API) và K16 (Rust), không ở G16b; nhưng ở bản TS tiến trình biên của tunnel là **Next** (bảng 6 cách, dòng 4). Next nghe theo `HOSTNAME` (`server.js`: `process.env.HOSTNAME \|\| '0.0.0.0'`; `Dockerfile:59` đặt `0.0.0.0`). Thiếu ở Next là lỗ B6-QT-3 mở lại ở đúng tiến trình đang là biên. PLAN viết "nếu nghe `0.0.0.0`", G16a viết "không phải loopback": cách viết của PLAN để lọt trường hợp nghe một IP cụ thể (IP công khai của máy PM2, IP container) | 4.13 bảng giá trị; G16a; G16b | G16b: tệp nạp trước bọc `server.listen`, kiểm địa chỉ thực nghe là loopback khi `TRUSTED_PROXY=cloudflare-tunnel`, không thì thoát; thêm ca test. Thống nhất chữ PLAN thành "không phải loopback" |
| B7-N-2 | Sau X06, binary nghe cổng tương thích `0.0.0.0:4000` trong container (4.13, X06). Với profile `tunnel`, ràng buộc của K16 khiến binary **không khởi động**; nếu miễn cho cổng 4000 thì cổng đó tin `cf-connecting-ip` từ mọi peer tới được nó (container khác, host qua `127.0.0.1:${API_PORT}`) | 4.13 "Cổng tương thích"; K16; X06; X14 không có ca tunnel | Ghi ở X06: `cloudflare-tunnel` thì cổng tương thích nghe loopback hoặc tắt (cấu hình tunnel của Trinity chỉ trỏ cổng chính); X14 thêm ca profile `tunnel` |
| B7-N-3 | Tunnel trong Docker chạy được (cloudflared `network_mode: service:web` thấy `127.0.0.1:3000` của `web`; `web` vẫn gọi ra `api` qua mạng compose), nhưng compose một tệp không biểu đạt được "không công bố cổng" bằng `WEB_BIND` (giá trị rỗng không bỏ được mục `ports`) và profile không đổi được `environment` của `web` (cần `HOSTNAME=127.0.0.1`). Cloudflared trỏ `localhost` có thể ra `::1` trong khi Next chỉ nghe IPv4 | 4.13 câu "Compose mặc định công bố cổng theo `TRUSTED_PROXY` … không công bố cho tunnel"; G16b; `docker-compose.yml:134-135` | Dùng tệp ghép `docker-compose.tunnel.yml` (`ports: !reset []`, `HOSTNAME: 127.0.0.1`, service `cloudflared`), ingress trỏ `http://127.0.0.1:3000`; ghi biến địa chỉ nghe vào danh sách biến mới. Khi `web` bị tạo lại, `cloudflared` phải tạo lại theo (chung namespace) |
| B7-N-4 | Test e2e đặt `x-real-ip: freshIp()` từ loopback để mỗi ca có xô giới hạn riêng (`apps/monolith/test/rbac/oauth.e2e-spec.ts:38,40`, `mcp.e2e-spec.ts:35,39,57`, `extensions.e2e-spec.ts`, `ai-actions.e2e-spec.ts`). Sau G16a (mặc định `none`) header bị bỏ ⇒ mọi ca chung một xô ⇒ 429, test đỏ | `grep` trên | G16a: helper test ký `x-trinity-client-ip` bằng bí mật test, hoặc môi trường test đặt `TRUSTED_PROXY=cidr:127.0.0.1/32`; tiêu chí `grep` của G16a loại trừ `test/` có chủ đích |
| B7-N-5 | Compose dẫn `INTERNAL_SERVICE_SECRET: ${INTERNAL_SERVICE_SECRET:-${SERVICE_SECRET}}` và guard `@Internal` chấp nhận cả hai biến; bản cài chỉ đặt `SERVICE_SECRET` thì `web` (G16b thêm biến) nhận rỗng ⇒ mọi request "không tin được" ⇒ kiểm IP cho qua. Next không chạy `insecureSecrets()` nên có thể ký bằng `change-me-…` nếu API chạy ngoài production | `docker-compose.yml:26-27`; `permission.guard.ts:92-94`; `bootstrap-app.ts:131-141` | `web` dùng đúng biểu thức dự phòng của `x-api-env`; khoá HKDF dẫn từ bí mật đang hiệu lực (cùng thứ tự với guard); tệp nạp trước từ chối khởi động với giá trị mẫu |
| B7-N-6 | Luật 3 coi "peer là cổng mặc định của container" là không tin được nhưng không nói cách nhận ra (cần đọc tuyến mặc định, vd `/proc/net/route`). Trong compose, peer của API khi request **không** qua route handler (rewrite `/.well-known` của `next.config.ts:45-56`, hoặc `web` và `api` lệch phiên bản lúc nâng cấp) là IP container `web` (172.x, không phải cổng mặc định) ⇒ coi như IP khách hợp lệ ⇒ có thể khoá nếu chạm route có kiểm IP | 4.13 luật 3; G16a | Ghi cách nhận cổng mặc định; Next luôn gửi `x-trinity-client-ip` (có hay không có chữ ký) để API phân biệt "qua Trinity" với "client trực tiếp"; tệp nạp trước xoá `x-trinity-*` cho **mọi** request, kể cả đường rewrite |
| B7-N-7 | Tiêu chí W02a "`/privacy` của bản xuất hiện tên đơn vị ngay trong HTML khi Rust phục vụ" không đo được trong W02a: việc chèn do K18 làm, mà K18 phụ thuộc W02a | W02a (:134) phụ thuộc R004, W01; K18 (:112) | W02a đo bằng máy chủ tĩnh thử (script trong `apps/web/scripts`) có chèn giá trị; tiêu chí "khi Rust phục vụ" để ở K18 (đã có) |
| B7-N-8 | Nâng cấp đổi hành vi bản cài mặc định theo tài liệu (Caddy → Next → API, không đặt cờ): hiện Node tin XFF từ loopback nên lấy được IP thật qua Caddy (dù giả được bằng `X-Real-IP`); sau G16 mặc định `none` ⇒ peer `127.0.0.1` ⇒ kiểm Wi-Fi và chấm công **cho qua** tới khi quản trị đặt `TRUSTED_PROXY` và sửa Caddyfile. Cảnh báo chỉ ở màn cài đặt tương ứng; chấm công ảnh hưởng lương | 4.13 luật 3; `attendance-ip.helper.ts:44-66`; `docs/deployment.md:32-33` | `CHANGELOG` ghi "hành động bắt buộc khi nâng cấp"; cảnh báo hiện thành dải trên mọi trang quản trị cho tới khi sửa; `install.sh` hỏi topo và đặt `TRUSTED_PROXY`; tài liệu nâng cấp có đoạn Caddyfile/nginx mới cạnh nhau |

### Phụ lục: kiểm khả thi các điểm được hỏi

| Điểm | Kết luận | Căn cứ |
|---|---|---|
| Tệp nạp trước ghi địa chỉ socket với Next 16 standalone | **Khả thi.** `server.js` standalone gọi `startServer` (`next/dist/build/utils.js:1133-1150`); `start-server.js:31,247` gọi `_http.default.createServer(requestListener)` qua thuộc tính của module lúc chạy, nên vá `require('http').createServer` trong `-r` có hiệu lực; Next 16 render cùng tiến trình (không còn render worker qua HTTP), header/ALS tới được route handler. Rủi ro nằm ở cách truyền (B7-QT-1) và việc thiếu `-r` ở PM2 |
| HMAC ±60 giây | Đúng cho Next↔API và Rust↔Node (cùng máy, cùng đồng hồ nhân). Sai ở **thời điểm kiểm** (B7-QT-2) và ở nhánh "chữ ký sai thì cho qua" |
| `cloudflare-tunnel` bind loopback trong container | **Chạy được** với cloudflared chung network namespace; cần tệp compose ghép và `HOSTNAME=127.0.0.1` (B7-N-3); ràng buộc phải đặt ở Next (B7-N-1); xung đột cổng 4000 sau X06 (B7-N-2) |
| 6 cách triển khai: còn giả được IP / khoá / tắt lặng lẽ? | Dòng 1 (PM2): giả được khi thiếu `-r` (B7-QT-1). Mọi dòng có Rust/Next phía trước Node: vượt kiểm bằng body chậm (B7-QT-2). Dòng 2–3 khi đứng sau Cloudflare + Caddy: khoá (`cidr:`) hoặc tắt (`cloudflare`) (B7-QT-3). Dòng 3 với `WEB_BIND` để `0.0.0.0` và khách IPv6 qua `docker-proxy`: peer thành cổng mặc định ∈ `cidr` ⇒ tin header giả; đã chặn nếu `install.sh` đặt `WEB_BIND` như G16b, nên chỉ nhắc trong tài liệu |

---

## C. Kiểm ISSUES

| Tiêu chí | Kết quả |
|---|---|
| Số liệu PLAN ↔ ISSUES | Khớp: 186 issue, 37/98/51, 218,5 ngày; "khoảng 120,5 ngày các giai đoạn khác" (= 218,5 − 98) |
| Phụ thuộc | Không vòng, không tham chiếu thiếu. K16, K17 → G16a; D01 → G16b; G16b → G16a; W02b → W03 → X06 đúng chiều |
| Mỗi issue một PR | Đạt |
| Tiêu chí xong đo được | Đạt, trừ G16b (thiếu ca "không có tệp nạp trước", ca Cloudflare → Caddy, ca tunnel từ chối nghe ngoài loopback), G16a/K17 (thiếu ca body chậm), X14 ("cùng kết quả" với cờ cũ không đạt được, B7-QT-3), W02a (B7-N-7) |
| Đường găng | X06 24,5 · D01 10,5 · X02a 12 · W02b 22 · tổng thể 25,5. Khớp |

## Kết luận

**CHƯA ĐỦ**: còn 3 QUAN TRỌNG trong luật IP mới: peer truyền bằng header nên PM2 thiếu `-r` là giả được IP ngay ở mặc định
(B7-QT-1); chữ ký kiểm sau khi đọc body và "sai thì cho qua" nên body chậm vượt được kiểm (B7-QT-2); topo Cloudflare →
Caddy/nginx → Next không có giá trị đúng, `cidr:` ưu tiên `X-Real-IP`, bí danh cờ cũ đổi nghĩa (B7-QT-3). Cả ba sửa bằng vài
dòng ở 4.13, G16a, G16b, K16, K17, X14; 0 CHẶN; 8 NHỎ sửa trong PR của từng issue (B7-N-1, B7-N-2 phải có trước G16b và X06).
Mọi issue không nằm sau G16a/G16b/K16/K17 bắt đầu được ngay.
