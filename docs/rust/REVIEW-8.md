# Phản biện lần 8 (kiểm chốt): PLAN.md và ISSUES.md (viết lại backend bằng Rust)

Ngày 26/11/2026 · Worktree `rust-plan` (HEAD `fef6dab`, `docs/rust` chưa commit) · Người phản biện độc lập. Không sửa plan hay mã, không build
hay test. Không phản biện các quyết định trong `DECISIONS.md`. Đối chiếu mã thật: `docker-compose.yml`, `Dockerfile`, `install.sh`,
`docs/deployment.md`, `docs/runbooks/fast-delivery.md`, `apps/monolith/src/bootstrap-app.ts`, `apps/web/src/app/api/**`,
các helper IP trong `services/`, `apps/monolith/test/rbac/*.e2e-spec.ts`.

## Tóm tắt

| Phần | Kết quả |
|---|---|
| A. 11 phát hiện lượt 7 | **11 ĐÃ XỬ LÝ**, 0 CHƯA, 0 SAI. Hai cách sửa sinh hệ quả mới (B7-QT-3 → B8-QT-1; luật 3 + bảng compose → B8-QT-2) |
| B. Phát hiện mới | **0 CHẶN · 2 QUAN TRỌNG · 7 NHỎ** |
| `check-issues.py` | 186 issue = 37 S + 97 M + 52 L = 219,5 ngày-agent; 0 trùng; 0 tham chiếu thiếu; **0 vòng**. X06 24,5 · D01 10,5 · X02a 12 · W02b 22 · tổng thể (X15a) 25,5. Khớp PLAN mục 0, 11 (121,5 = 219,5 − 98), Lịch sử lượt 7, cuối ISSUES |

**Kết luận: CHƯA ĐỦ**: 2 QUAN TRỌNG, cả hai ở luật IP, mỗi cái sửa bằng 1–3 dòng ở 4.13/G16a/G16b, không thêm issue, không đụng đường găng.
Mọi issue không nằm sau G16a/G16b bắt đầu được ngay.

---

## A. Trạng thái các phát hiện lượt 7

| Mã | Trạng thái | Kiểm ở đâu | Ghi chú |
|---|---|---|---|
| B7-QT-1 (peer qua header) | ĐÃ XỬ LÝ | 4.13 "Next làm biên thế nào"; G16b (ISSUES:57), ca (2) | ALS khả thi: tệp nạp trước bọc request listener, route handler chạy cùng tiến trình, mọi `await` giữ ngữ cảnh. Thiếu store ⇒ "không tin được", không đọc header |
| B7-QT-2 (chữ ký kiểm sau body) | ĐÃ XỬ LÝ | 4.13 luật 2; G16a, G16b (8), K16, K17 | Khả thi trong mã thật: `main.ts:22` tạo app với `bodyParser: false`, parser gắn bằng `app.useBodyParser` ở `bootstrap-app.ts:75–76`; middleware IP đăng ký trước dòng 75 sẽ chạy trước parser, multer là interceptor nên chạy sau. Hệ quả nhỏ về khoá kiểm: B8-N-3 |
| B7-QT-3 (topo CF → Caddy/nginx, `cidr:`, cờ cũ) | ĐÃ XỬ LÝ | 4.13 bảng giá trị + bảng triển khai; G16a; G16b (3)(4); K16; X14 | `cloudflare-behind:` đúng với Caddy (Caddy nối peer vào XFF). **Mẫu nginx và giả định "nginx tự ghi XFF" sai** (B8-QT-1). Tiêu chí X14 về cờ cũ không đo được trên Docker (B8-N-4) |
| B7-N-1 (loopback ở Next) | ĐÃ XỬ LÝ | G16b (bọc `server.listen`), ca (6) | |
| B7-N-2 (cổng 4000 + tunnel) | ĐÃ XỬ LÝ | 4.13 "Cổng tương thích"; X06; X14 | |
| B7-N-3 (tệp ghép tunnel) | ĐÃ XỬ LÝ | G16b; 4.13 danh sách biến (`HOSTNAME`) | Thiếu kiểm phiên bản Compose và `/notif-ws` (B8-N-5) |
| B7-N-4 (e2e `x-real-ip`) | ĐÃ XỬ LÝ | G16a | Danh sách quên `extensions.e2e-spec.ts`, nhưng đặt env cho cả môi trường test nên vẫn phủ |
| B7-N-5 (bí mật ở `web`) | ĐÃ XỬ LÝ | G16b; 4.13 luật 2 | Khớp `insecureSecrets()` (`bootstrap-app.ts:132`) vốn đã chặn `change-me` ở API |
| B7-N-6 (cổng mặc định, đường rewrite) | ĐÃ XỬ LÝ | 4.13 luật 3; G16a; G16b | Luật 3 chỉ áp khi `TRUSTED_PROXY=none` ⇒ B8-QT-2 |
| B7-N-7 (W02a) | ĐÃ XỬ LÝ | W02a (:134); K18 | |
| B7-N-8 (đổi hành vi khi nâng cấp) | ĐÃ XỬ LÝ | 4.13 đoạn "Đổi hành vi khi nâng cấp"; G16a; G16b | `install.sh` không bao giờ sửa `.env` có sẵn nên không giúp bản đang chạy (B8-N-6) |

---

## B. Phát hiện mới

### QUAN TRỌNG

#### B8-QT-1. Hai giả định về nginx sai: nginx **không** tự ghi `X-Forwarded-For`, và mẫu `set_real_ip_from <dải>` một mình làm nginx tin `X-Real-IP` của client ⇒ giả được IP ở đúng hai dòng chính của bảng triển khai

- **Liên quan:** PLAN 4.13 bảng giá trị, dòng `cidr:` ("Caddy mặc định, nginx thông thường đều tự ghi phần tử này nên client không
  giả được") và dòng `cloudflare-behind:` ("mẫu … nginx (`set_real_ip_from <dải>`)"); G16b phần `docs/deployment.md` ("nginx
  `set_real_ip_from <dải>`"); ca test G16b (3)(4) chỉ có Caddy.
- **Bằng chứng:**
  - nginx `proxy_pass` mặc định chỉ đặt `Host` và `Connection`; `X-Forwarded-For` chỉ có khi cấu hình
    `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` (hoặc `$remote_addr`). Thiếu dòng đó, XFF của client đi nguyên
    sang Next. Tài liệu hiện tại (`docs/deployment.md` mục 4) chỉ đưa đoạn nginx cho `/notif-ws`, không có `location /`, nên bản
    cài nginx đang chạy dùng cấu hình tự viết. Với dòng 1 của bảng (trình quản lý tiến trình, nginx → Next, `cidr:127.0.0.1/32`),
    peer luôn ∈ danh sách ⇒ phần tử phải cùng là giá trị client tự gửi ⇒ **giả được IP văn phòng**, qua cổng Wi-Fi và kiểm IP
    chấm công. Đây chính là giá trị mà `CHANGELOG`/dải cảnh báo sẽ bảo người nâng cấp đặt.
  - `real_ip_header` mặc định của nginx là `X-Real-IP`. Mẫu chỉ có `set_real_ip_from <dải Cloudflare>` ⇒ với request đi qua
    Cloudflare, nginx thay `$remote_addr` bằng `X-Real-IP` do client gửi (Cloudflare chuyển nguyên header lạ, cùng căn cứ REVIEW-7
    B7-QT-3) ⇒ `$proxy_add_x_forwarded_for` nối giá trị giả đó vào cuối ⇒ `cloudflare-behind:` thấy phần tử phải cùng ∉ dải
    Cloudflare ⇒ dùng chính nó ⇒ **giả được IP** qua Cloudflare.
  - Caddy không mắc cả hai: `reverse_proxy` luôn ghi XFF (thay nếu peer không tin, nối nếu tin) bằng địa chỉ kết nối thật. Vì
    các ca test chỉ dựng Caddy nên lỗ nginx không bị bắt.
- **Đề xuất:** (1) Sửa câu ở dòng `cidr:`: "Caddy luôn ghi; nginx **phải** có `proxy_set_header X-Forwarded-For $remote_addr`
  (ghi đè, không nối) trong mọi `location` trỏ vào ứng dụng". (2) Mẫu nginx cho `cloudflare-behind:` **không** dùng
  `set_real_ip_from` (không cần, ứng dụng đã tự lấy `cf-connecting-ip` khi phần tử phải cùng thuộc dải Cloudflare); nếu giữ thì bắt
  buộc kèm `real_ip_header CF-Connecting-IP`. (3) G16b thêm ca: nginx thiếu `proxy_set_header X-Forwarded-For` (tài liệu phải nói
  là sai cấu hình, và ca chứng minh mẫu mới chặn được XFF giả); nginx + `set_real_ip_from` + `X-Real-IP` giả qua Cloudflare giả.
  K16 chạy lại cùng ca.

#### B8-QT-2. "IP không tin được" chỉ áp khi `TRUSTED_PROXY=none`: ở các giá trị khác, peer là cổng mặc định của mạng Docker (hoặc loopback) mà nằm ngoài danh sách sẽ được coi là **IP khách hợp lệ** ⇒ khoá đăng nhập Wi-Fi và từ chối chấm công, lặng lẽ

- **Liên quan:** PLAN 4.13 luật 3 ("peer là loopback hoặc cổng mặc định của container … **mà `TRUSTED_PROXY=none`**"); bảng triển
  khai dòng "Compose sau Caddy/nginx trên host … `cidr:` với cổng mặc định của mạng Docker" và dòng "Compose, Cloudflare nối thẳng
  cổng `web`: `cloudflare`"; G16a (viết luật 3 **không** kèm điều kiện `none`: PLAN và issue lệch nhau); G16b (`install.sh` đặt
  `TRUSTED_PROXY`).
- **Bằng chứng:**
  - Mạng compose `trinity_default` có dải do Docker cấp lúc tạo (172.18.x, 172.19.x…), không phải `docker0` 172.17.0.1, và đổi
    được khi `docker compose down && up` sau khi máy có thêm mạng khác. `install.sh` chạy **trước** khi mạng tồn tại nên không
    biết được cổng thật; giá trị dễ ghi nhầm nhất là `cidr:172.17.0.1/32`. Peer (172.18.0.1) ∉ danh sách ⇒ theo bảng, IP khách =
    IP peer ⇒ luật 3 không bắt vì giá trị không phải `none` ⇒ so 172.18.0.1 với IP văn phòng ⇒ **mọi người dùng thuộc diện kiểm
    Wi-Fi bị chặn đăng nhập, mọi lần chấm công bị từ chối**, không có dải cảnh báo.
  - Cùng gốc ở dòng `cloudflare` của compose: cổng `web` công bố mặc định (`"${WEB_PORT:-3000}:3000"`, `docker-compose.yml`)
    nghe cả `[::]` qua `docker-proxy`; bản ghi AAAA được Cloudflare proxy thì Cloudflare nối origin bằng IPv6 ⇒ peer là cổng mặc
    định (IPv4) ⇒ ∉ dải Cloudflare ⇒ IP khách = cổng mặc định ⇒ khoá như trên.
  - Tương tự với loopback khi danh sách `cidr:` không khớp dạng địa chỉ thực tế của peer (vd proxy nối `::1`).
- **Đề xuất:** (1) Luật 3 áp lên **kết quả cuối**, ở mọi giá trị `TRUSTED_PROXY`: IP khách xác định ra là loopback, cổng mặc
  định (theo `/proc/net/route`) hoặc dấu "không tin được" ⇒ "không tin được" (cho qua + log + dải cảnh báo), không bao giờ so với
  danh sách IP văn phòng. Sửa câu PLAN cho khớp G16a. (2) Cho `cidr:` nhận từ khoá `docker-gateway` (giải lúc khởi động và mỗi lần
  đọc `/proc/net/route` đổi), hoặc compose cố định dải mạng (`networks.default.ipam.config`), để `install.sh` và tài liệu có giá
  trị đúng. (3) Ca test G16a/G16b: `cidr:` không chứa peer thật là cổng mặc định ⇒ "không tin được", không khoá; `cloudflare` với
  peer là cổng mặc định ⇒ như trên.

### NHỎ

| # | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|
| B8-N-1 | Cấu hình lai (D01): tệp nạp trước ở Next **xoá** `x-trinity-*` ở mọi request, kể cả header có chữ ký hợp lệ do Rust gửi. Next không còn là biên nhưng vẫn tự xác định IP từ peer 127.0.0.1 ⇒ "không tin được" + log lỗi cấu hình mỗi request; `api/fe-logging` giới hạn tốc độ theo IP **ngay trong Next** (`fe-logging/route.ts:24,52`) ⇒ mọi khách chung một xô ⇒ log frontend bị 429 | G16b; D01; 4.13 bảng dòng "Cấu hình lai" | Tệp nạp trước: có `x-trinity-client-ip` chữ ký hợp lệ thì giữ và đưa vào store; chỉ xoá khi sai/không có. Ca test trong D01 |
| B8-N-2 | Chuẩn hoá địa chỉ chưa ghi: Node nghe `::` cho ra `::ffff:a.b.c.d`; so `cidr:`/`CLOUDFLARE_IP_RANGES` mà không chuẩn hoá thì không bao giờ khớp. Mã hiện tại có làm (`attendance-ip.helper.ts:13`, `login-wifi-check.helper.ts:114`) nhưng hàm mới viết lại | G16a, K16 | Ghi "chuẩn hoá IPv4-mapped trước mọi so khớp"; thêm vào bảng ca |
| B8-N-3 | Chữ ký sai ⇒ 400 ở **mọi** request. API dẫn khoá từ một bí mật (`INTERNAL_SERVICE_SECRET` rồi `SERVICE_SECRET`) trong khi guard `@Internal` chấp nhận **cả hai** (`permission.guard.ts:92–94`); bản tự chạy bằng trình quản lý tiến trình mà `web` chỉ có `SERVICE_SECRET` còn API có `INTERNAL_SERVICE_SECRET` khác giá trị ⇒ toàn bộ `/api/v1` qua Next trả 400. Cổng sức khoẻ của `fast-delivery.md:44` (health API gọi thẳng + trang đăng nhập) không đi qua route handler nên **không tự lui** | 4.13 luật 2; G16a | API kiểm với khoá dẫn từ cả hai bí mật (giống guard); cổng sức khoẻ thêm một lời gọi `/api/v1/health` **qua Next**; log nêu rõ "lệch bí mật giữa web và API" |
| B8-N-4 | Tiêu chí X14 "bản cài cũ chỉ có cờ `*_TRUST_*` ⇒ bản mới không khởi động" không xảy ra trên Docker: `x-api-env` liệt kê biến tường minh, không có `env_file`, nên các cờ này **chưa bao giờ** tới container `api`. Ngược lại, bản tự chạy bằng trình quản lý tiến trình có cờ thì sau G16a API không lên (cổng sức khoẻ lui được, nhưng cần nói trước) | `docker-compose.yml` `x-api-env`; X14; G16a | X14 đổi thành: cờ cũ trong `.env` Docker ⇒ bản mới lên và log cảnh báo "cờ không còn tác dụng"; ca "dừng khởi động" chuyển sang hướng dẫn trình quản lý tiến trình; `CHANGELOG` ghi rõ việc này |
| B8-N-5 | Tệp ghép tunnel: `ports: !reset []` cần Docker Compose ≥ 2.24 (bản cũ báo lỗi YAML); ingress chỉ trỏ `127.0.0.1:3000` nên `/notif-ws` (Next không chuyển WebSocket) mất, chuông về chế độ 30 giây | G16b; `docs/deployment.md` mục 4 | Tài liệu ghi phiên bản Compose tối thiểu; ingress thêm luật `/notif-ws` → `http://api:4000` (cloudflared chung namespace với `web` nên phân giải được `api`) |
| B8-N-6 | "`install.sh` hỏi cách triển khai và đặt sẵn biến" không tới bản đang chạy: `install.sh` không bao giờ sửa `.env` có sẵn (dòng 7, 31–32) và luồng cập nhật là `git pull && docker compose up -d --build`. Thêm câu hỏi tương tác làm hỏng `./install.sh --up` không có tty | `install.sh`; `docs/deployment.md` "Updating" | `install.sh` hỏi chỉ khi có tty, mặc định `none`; thêm cờ `--trusted-proxy=…`; với `.env` có sẵn thì in giá trị đề xuất, không sửa |
| B8-N-7 | Tệp nạp trước chỉ chặn `change-me`, còn `insecureSecrets()` của API chặn cả bí mật < 32 ký tự; cùng một `.env` có thể lên ở `web` mà API thì không (hoặc ngược lại khi API ngoài production) | G16b; `bootstrap-app.ts:132–141` | Dùng cùng luật (mẫu hoặc < 32 ký tự) ở tệp nạp trước |

---

## C. Kiểm ISSUES

| Tiêu chí | Kết quả |
|---|---|
| Số liệu PLAN ↔ ISSUES | Khớp: 186 issue, 37/97/52, 219,5 ngày; "121,5 ngày các giai đoạn khác" = 219,5 − 98 |
| Phụ thuộc | 0 vòng, 0 tham chiếu thiếu. G16b → G16a; K16, K17 → G16a; D01 → G16b; W02b → W03 → X06 đúng chiều |
| Đường găng | X06 24,5 · D01 10,5 · X02a 12 · W02b 22 · tổng thể 25,5. Chuỗi ghi ở cuối ISSUES là nhánh dài bằng (đã chú thích) |
| Tiêu chí xong đo được | Đạt, trừ G16b/K16 (thiếu ca nginx, B8-QT-1; ca cổng mặc định ngoài danh sách, B8-QT-2) và X14 (ca cờ cũ trên Docker, B8-N-4) |

## Kết luận

**CHƯA ĐỦ**: còn 2 QUAN TRỌNG ở luật IP (mẫu và giả định nginx cho phép giả IP, B8-QT-1; luật "không tin được" chỉ áp cho `none`
nên cổng mặc định Docker ngoài danh sách bị coi là IP khách và khoá người dùng, B8-QT-2). Sửa bằng vài dòng ở 4.13, G16a, G16b, K16;
không thêm issue, không đổi đường găng; sửa xong là đủ để bắt đầu, không cần một lượt phản biện đầy đủ nữa. 7 NHỎ sửa trong PR của từng issue.
