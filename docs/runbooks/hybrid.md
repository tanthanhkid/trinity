# Runbook — Rust trước, Node phía sau (không còn Next)

> **Lưu trữ (X06, 27/11/2026).** Cấu hình lai Rust + Node đã bị gỡ khỏi repo: backend là một binary Rust, không còn tiến trình Node, tệp sở hữu hay `docker-compose.hybrid.yml`. Tài liệu này chỉ còn để tham khảo cho đường lui 14 ngày (checkout tag phát hành trước X06) và để hiểu lịch sử các đợt chuyển; đường dẫn tới mã Node trong đó trỏ vào lịch sử git, không còn trong cây hiện tại. Cài đặt hiện hành: [deployment.md](../deployment.md).

Issue D01 (PLAN mục 4.13, 4.14), cập nhật ở W02b. Rust nhận cổng công khai 3000, phục vụ web tĩnh (`WEB_DIR`, thư mục `out/` của `next build`), tự xử lý route đã
được giao cho nó trong tệp sở hữu và chuyển tiếp phần còn lại (`/api/v1`, `/notif-ws`, `/uploads`, `/.well-known`) sang Node. Từ W02b không còn tiến trình Next:
`docker-compose.yml` mặc định chính là cấu hình này (tệp `docker-compose.hybrid.yml` đã gộp vào đó).

**Ai được dùng.** W02b → W03 → X06 merge liền nhau trong một bản phát hành; không có tag nào giữa W02b và X06. Image phát hành (`docker.yml`)
vẫn dựng target `web` cũ nên **không được gắn tag** cho tới khi X06 đổi sang image `trinity`.

## 1. Sơ đồ

```
trình duyệt -> [Caddy/nginx/Cloudflare] -> Rust :3000 (biên duy nhất, đặt TRUSTED_PROXY ở đây)
                                             |-- trang, /_next, tệp tĩnh, /api/build-id -> Rust (WEB_DIR)
                                             |-- /api/v1, /notif-ws, /uploads, /.well-known -> Node 127.0.0.1:4000
                                             `-- route thuộc Rust (theo tệp sở hữu)
```

- Rust bỏ mọi header IP do client gửi, tự xác định IP theo `TRUSTED_PROXY`, rồi gửi `x-trinity-client-ip` có chữ ký (ký ngay lúc gửi header)
  sang Node. Node nhận header đó vì peer là loopback thật.
- `INTERNAL_SERVICE_SECRET` (hoặc `SERVICE_SECRET`) phải **giống nhau** ở Rust và Node. Lệch ⇒ 400 trên mọi request, log nói rõ.
- `/notif-ws` đi qua Rust. Luật reverse proxy cũ trỏ thẳng cổng 4000 phải gỡ (hoặc trỏ về cổng của Rust), xem mục 6.

## 2. Docker Compose

Cần Docker Compose >= 2.24 không còn bắt buộc (không dùng `!reset`).

```
cp .env.example .env            # hoặc ./install.sh; đặt các bí mật như bình thường
docker compose up -d --build
```

`docker-compose.yml` có:

| Service | Ghi chú |
|---|---|
| `trinity` (target `trinity` của `Dockerfile`, chứa `/srv/web`) | Công bố `${WEB_BIND:-0.0.0.0}:${WEB_PORT:-3000}:3000`; `TRUSTED_PROXY`, `CLOUDFLARE_IP_RANGES`, `INTERNAL_SERVICE_SECRET`; `WEB_DIR=/srv/web`; `NODE_FALLBACK_URL=http://127.0.0.1:4000`; `COMPAT_API_PORT=4001` (4000 đang do Node giữ); `TRINITY_OWNERSHIP_FILE=/etc/trinity/ownership.json` |
| `api` | `network_mode: service:trinity`, không công bố cổng, `LISTEN_HOST=127.0.0.1`, `TRUSTED_PROXY=none`, cùng tệp sở hữu |

Vì chung network namespace nên tên `api` không phân giải được, mọi địa chỉ phía Node đều là `127.0.0.1`. `postgres` vẫn gọi được theo tên.

**Tệp sở hữu** nằm ở `deploy/hybrid/ownership.json` (mặc định `routes: []`, `jobs: {}`, `migrate: "node"`, `web: "rust"`: mọi thứ thuộc Node trừ trang web, khoá `web` từ K18), gắn vào container
theo thư mục `./deploy/hybrid:/etc/trinity:ro` để việc đổi tên nguyên tử trên host được thấy trong container. Đổi sở hữu theo runbook X01 (`docs/runbooks/cutover.md`), rồi
`docker compose kill -s HUP trinity`.

**Thứ tự khởi động.** `migrate` (Prisma) chạy xong, rồi `trinity` và `api` (chung namespace). Compose không cho `trinity` chờ `api`
(vì `api` phải chung namespace với `trinity`), nên trong vài chục giây đầu Rust trả 502 cho phần chuyển sang Node; không mất dữ liệu.
Cổng sức khoẻ `trinity healthcheck` (do issue `serve` thêm) đi qua cả Rust và Node nên chỉ xanh khi cả hai sẵn sàng.

Biến cần đặt (xem `.env.example`, mục "Rust in front, Node behind"): `TRUSTED_PROXY` (đặt cho `trinity`; bảng giá trị ở `docs/deployment.md`, mục "Client IP"),
`WEB_BIND`, `RUST_DB_POOL_SIZE` (mặc định 4). Hạ pool Node trong lai bằng `TENANT_MAX_CLIENTS` và `TENANT_CONNECTION_LIMIT` thấp
(PLAN mục 7, RAM của cả hai đầu).

## 3. Bản chạy bằng trình quản lý tiến trình (systemd, PM2)

Hai tiến trình: Rust (`trinity serve`, cổng 3000, `WEB_DIR=<repo>/apps/web/out`) và Node (`PORT=4000`, `LISTEN_HOST=127.0.0.1`). Dùng chung một `.env` (cùng bí mật)
và cùng `TRINITY_OWNERSHIP_FILE`. `TRUSTED_PROXY` đặt cho Rust (Caddy/nginx cùng máy: `cidr:127.0.0.1/32`; thêm Cloudflare:
`cloudflare-behind:127.0.0.1/32`). Đặt `TimeoutStopSec=45` cho Rust. `NODE_FALLBACK_URL=http://127.0.0.1:4000`; `COMPAT_API_PORT` khác 3000 và 4000 (ví dụ 4001).
Vá web không cần dựng lại binary: dựng lại `apps/web` (`pnpm --filter web build`) rồi thay thư mục `WEB_DIR`.

### 3.1 Lấy binary từ artifact CI theo commit

Job `rust-binaries` (workflow `contract-rust.yml`, K31) tạo hai artifact `trinity-linux-x86_64` và `trinity-linux-aarch64`, mỗi artifact gồm
binary và tệp `.sha256`; giữ 14 ngày; tải cần `gh auth login`.

```
SHA=$(git rev-parse HEAD)                       # commit đã build và đã qua CI
RUN=$(gh run list --workflow contract-rust.yml --commit "$SHA" --status success --json databaseId --jq '.[0].databaseId')
ARCH=$(uname -m)                                # x86_64 hoặc aarch64
mkdir -p /opt/trinity/releases/$SHA && cd /opt/trinity/releases/$SHA
gh run download "$RUN" --name "trinity-linux-$ARCH"
sha256sum -c "trinity-linux-$ARCH.sha256"       # phải in OK, không thì dừng
chmod +x "trinity-linux-$ARCH"
"./trinity-linux-$ARCH" --version
ln -sfn "/opt/trinity/releases/$SHA/trinity-linux-$ARCH" /opt/trinity/trinity.next
```

Tổng kiểm chỉ chứng minh tệp không hỏng giữa đường, chưa chứng minh nguồn gốc (chữ ký cosign thuộc X08). Lấy `SHA` từ kho của bạn, không từ tên artifact.
Kiểm cấu hình trước khi thay: `TRINITY_OWNERSHIP_FILE=... /opt/trinity/trinity.next check-config` (mã 0 mới đi tiếp).

### 3.2 Thứ tự triển khai

1. Sao lưu `.env` và tệp sở hữu; dump DB nếu có migration (như runbook fast-delivery).
2. **Migrate (Prisma)**: `pnpm --filter @trinity/prisma migrate:deploy`.
3. **Khởi động Node**, đợi cổng sức khoẻ Node xanh.
4. **Thay binary Rust**: chuyển liên kết `trinity` sang binary mới rồi khởi động lại. Rust từ chối phục vụ công ty có `migrated_to` cũ hơn bản
   migration nó biên dịch cùng (trả 503), nên phải migrate trước bước này.
5. Chạy cổng sức khoẻ mục 3.3. Đỏ thì lui (mục 5).

### 3.3 Cổng sức khoẻ

Cả hai tiến trình, theo thứ tự; mỗi cổng phải xanh trước khi tuyên bố xong:

| # | Kiểm | Lệnh |
|---|---|---|
| 1 | Node sống | `curl -fsS http://127.0.0.1:4000/api/v1/health` |
| 2 | Rust sống và chuỗi Rust, Node thông | `curl -fsS http://127.0.0.1:3000/api/v1/health` |
| 3 | Rust phục vụ web tĩnh | `curl -fsS -o /dev/null http://127.0.0.1:3000/login` |
| 4 | `/notif-ws` qua Rust trả 101 | `curl -si -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGVzdA==' http://127.0.0.1:3000/notif-ws/ | head -1` |
| 5 | **`migrated_to`**: không công ty nào cũ hơn migration mới nhất | lệnh dưới, kết quả phải rỗng |

```
LATEST=$(ls server/prisma/migrations | grep -v toml | LC_ALL=C sort | tail -1)
psql "$DATABASE_URL" -Atc "select id from platform.companies where migrated_to is null or migrated_to < '$LATEST' collate \"C\""
```

`migrated_to` so theo byte như Rust. Công ty 1 không có dòng trong cột này: kiểm bằng `trinity migrate --status`.

## 4. Tiêu chí đạt (máy thử)

Bộ hợp đồng đạt qua Rust; Playwright đạt trên web do Rust phục vụ (W04); chuông realtime tới client qua Rust; hai client khác IP có bộ đếm giới hạn tốc độ riêng ở Node (IP thật qua header có
chữ ký của Rust); tắt Rust thì lui về cấu hình cũ dưới 2 phút.

## 5. Lui về cấu hình cũ (dưới 2 phút)

Nếu tệp sở hữu đã giao route hay job cho Rust thì **trước hết** trả chúng về Node theo X01 (`docs/runbooks/cutover.md`, mục 4.2: sửa tệp rồi `SIGHUP`). Với tệp mặc định thì không cần.

Docker Compose: lui = dùng bản phát hành trước (`git checkout <tag trước>` rồi `docker compose up -d --build --force-recreate`); bản đó còn `web` (Next) và `api` cổng 4000.

Trình quản lý tiến trình: lui = bản phát hành trước (có Next); nếu chỉ lui binary, chuyển liên kết `trinity` về bản trước. Hoàn lại luật reverse proxy cũ (mục 6). Migration không bị hoàn
tác: DB tương thích hai chiều.

## 6. Reverse proxy

Mọi thứ, gồm `/notif-ws/`, đi về cổng của Rust (3000). Luật cũ trỏ `/notif-ws/*` vào 4000 phải gỡ.

```
crm.example.com {
  reverse_proxy localhost:3000
}
```

nginx: một `location /` với `proxy_http_version 1.1`, `Upgrade` và `Connection "upgrade"` cho WebSocket, và **bắt buộc**
`proxy_set_header X-Forwarded-For $remote_addr;` cùng `proxy_set_header X-Real-IP "";` (xem "Client IP" trong `docs/deployment.md`).
`TRUSTED_PROXY` đặt cho `trinity`.

## 6b. Shadow (K28): bật và đọc báo cáo

Dùng cho tiêu chí "48 giờ shadow, mỗi route `safe_for_shadow` đạt `min_samples`" của mỗi đợt (PLAN 6.5).

1. Đặt `SHADOW_SAMPLE_RATE` cho `trinity` (ví dụ `0.1` = 10% GET `safe_for_shadow` do Node phục vụ; mặc định `0` = tắt hoàn toàn) và tuỳ chọn `SHADOW_REPORT_FILE` (mặc định `./shadow-report.json` trong thư mục chạy; đặt vào chỗ ghi được, ví dụ `/var/lib/trinity/shadow-report.json`). Khởi động lại `trinity`.
2. Shadow chỉ chạy sau khi Node đã trả response (response chính đi nguyên, không đổi, không chờ), với phiên DB chỉ đọc, chặn gọi mạng, bỏ qua cache đếm. Tối đa 4 lần chạy song song, thân tối đa 1 MiB, hạn 10 giây; hết chỗ thì bỏ mẫu.
3. Đọc báo cáo: `trinity shadow-report` (hoặc `--file <đường dẫn>`, `--json`). Mỗi dòng: `OK` hoặc `XX`, route, `mẫu <có>/<min_samples>`, giống, khác, lệch mã, bỏ; dòng `khác tại <đường dẫn JSON>` liệt kê chỗ khác (không có giá trị). Mã thoát 0 khi mọi route đạt, 1 khi còn route chưa đạt, 2 khi không đọc được tệp. Báo cáo ghi mỗi 60 giây; dòng đầu cho biết cửa sổ đo (giờ) và cảnh báo nếu tệp đã cũ.
4. Bộ đếm nằm trong bộ nhớ: mỗi lần khởi động lại `trinity` (kể cả deploy) là đếm lại từ 0, nên cửa sổ 48 giờ phải liền mạch. Route `XX` do thiếu mẫu thì quét bù bằng X13; route ghi "KHÔNG SHADOW ĐƯỢC" cần rà lại `safe_for_shadow` của nó.
5. Tắt: bỏ `SHADOW_SAMPLE_RATE` (hoặc đặt `0`) rồi khởi động lại.

## 7. Điểm chưa chắc

- `WEB_UPSTREAM_URL` (đích Next của `trinity serve`) không còn dùng ở compose; mã đọc nó còn trong `serve.rs`, gỡ ở lượt dọn sau khi K18 và W02b cùng vào `main`.
- Cấu hình này chưa được chạy thử (nơi viết không có Docker); các tiêu chí mục 4 cần chạy trên máy thử trước khi dùng thật.
