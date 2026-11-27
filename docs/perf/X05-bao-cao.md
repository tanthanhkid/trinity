# X05 — báo cáo hiệu năng (#263)

Phạm vi lượt này: **thông lượng và RAM của `GET /api/v1/contacts` có token** trên e2-micro (số do chủ dự án đo) và trên Mac
(đo lại cho bản Rust release). Chưa có: máy 2 GB, ca "10 request treo ở Graph", tệp xuất lớn nhất, tải lên 95 MB, so
bộ cấp phát (xem cuối). Các ca đó dùng `tests/load/rust-perf.sh` + `perf.mjs` trên Linux thật; số ghi vào
`docs/rust/BASELINE.md`.

## 1. Máy e2-micro (GCP, 2 vCPU chia sẻ, 1 GB RAM) — số do chủ dự án cung cấp

Tải vào từ xa, `GET /api/v1/contacts` có token. RTT Việt Nam – Mỹ khoảng 210 ms, nên p50 phần lớn là độ trễ mạng chứ không
phải thời gian xử lý.

| Đồng thời | rps | Độ trễ | Ghi chú |
|---|---|---|---|
| 50 | 184 | p50 257 ms | gần như chỉ là RTT (210 ms) cộng ~45 ms xử lý |
| 200 | 519 | p95 454 ms | **điểm bão hoà** |
| 400 | 393 | p95 1,8 s | quá tải: rps giảm, đuôi trễ tăng gấp 4 |

Nhận xét:

- rps tăng gần tuyến tính từ 50 lên 200 (vì tải bị giới hạn bởi RTT: mỗi kết nối chỉ làm được ~4 request/giây), đạt đỉnh
  quanh 200 rồi **giảm** ở 400. Sau điểm bão hoà thêm kết nối chỉ thêm hàng đợi: p95 từ 454 ms lên 1,8 s mà thông lượng
  mất 24 %.
- Với RTT 210 ms, 200 kết nối đồng thời tương ứng khoảng 500 request/giây từ người dùng ở xa; một công ty vài chục người
  dùng thật nằm xa dưới ngưỡng này.
- Hai vCPU chia sẻ (e2-micro có CPU bùng nổ) nên số đo dài hơi có thể thấp hơn nếu hết tín dụng CPU. Chưa đo RSS trên máy
  này; cần bổ sung bằng `perf-oha.sh` với PID (mục 4).

## 2. Mac, bản Rust release (đo lại trong lượt này)

**Máy đo: Mac arm64 (10 lõi, 16 GB), loopback, không mạng, `oha` và Postgres 16 chạy cùng máy.** Không so trực tiếp với
e2-micro: không có RTT, CPU mạnh hơn nhiều, bộ tạo tải tranh CPU với server. Dùng để biết **chi phí xử lý** và **RAM**, không
để dự báo rps trên máy nhỏ.

Điều kiện: `trinity serve` riêng (cổng riêng, không phải máy chủ localhost đang dùng), binary `--release` (lto thin) lấy từ
`main`, `DB_POOL_SIZE=8`, một công ty, DB tạm Postgres 16 riêng seed `--sample` (**chỉ 8 khách**, nên truy vấn nhẹ hơn
dữ liệu thật), mặc định `limit=50`, 30 giây mỗi mức sau 3 giây khởi động nóng. Chạy một lần (chưa lặp 3 lần lấy trung vị).

| Đồng thời | rps | p50 (ms) | p95 (ms) | p99 (ms) | Lỗi | RSS đỉnh (MB) |
|---|---|---|---|---|---|---|
| 50 | 6.231 | 6,9 | 13,5 | 26,8 | 0 % | 46 |
| 200 | 7.908 | 23,7 | 35,0 | 51,6 | 0 % | 47 |
| 400 | 8.323 | 45,8 | 65,9 | 85,1 | 0 % | 62 |

RSS: **nghỉ 37 MB**, đỉnh 62 MB, sau tải 59 MB (không trả lại hết ngay: chưa có bằng chứng rò, cần chạy dài hơn để kết
luận). Lần đầu script báo lỗi 0,1–0,2 %: đó là 400 request đang bay bị `oha` huỷ khi hết giờ ("aborted due to
deadline"), không phải lỗi máy chủ; script đã loại các mục này. Kiểm lại: 76.405 phản hồi, toàn 200.

So với bản Node trong `BASELINE.md` (cùng loại máy, nhưng kịch bản `limit=20`, 15 giây, 50 kết nối): Node 1.180 rps,
p95 125 ms, RSS 335–684 MB; Rust 6.231 rps, p95 13,5 ms, RSS 46 MB. Hai lần đo khác điều kiện nên chỉ dùng như bậc độ lớn
(khoảng 5 lần thông lượng, chục lần ít RAM).

Trên Mac rps vẫn tăng khi lên 400 vì CPU còn dư; điểm bão hoà thật phụ thuộc số lõi, nên điểm bão hoà quanh 200 của
e2-micro (2 vCPU chia sẻ) là do CPU chứ không do mã.

## 3. Cấu hình hiện có trong mã và khuyến nghị

Đọc từ `server/crates`:

| Thiết lập | Giá trị | Nguồn |
|---|---|---|
| Pool DB dùng chung | `DB_POOL_SIZE`, mặc định **8** (rồi `PRISMA_CONNECTION_LIMIT`) | `trinity-kernel/src/config/mod.rs` |
| Chờ lấy kết nối | `DB_ACQUIRE_TIMEOUT_MS`, mặc định **10 s** | `trinity-db/src/tenant.rs` |
| `statement_timeout` | mặc định **30 s** (`DB_STATEMENT_TIMEOUT_MS`) | `trinity-db/src/tenant.rs` |
| Số luồng tokio | **không đọc `WORKER_THREADS`**: `serve.rs` dùng `new_multi_thread()` mặc định (= số lõi) | `trinity-bin/src/serve.rs` |
| Giới hạn đồng thời / tải thừa | **không có** lớp giới hạn đồng thời hay `load_shed` ở tầng HTTP (chỉ `json_limit`, CORS, và giới hạn thân theo route upload) | `trinity-bin/src/serve.rs`, `trinity-http` |
| Bộ cấp phát | mimalloc có trong workspace nhưng chưa gắn `#[global_allocator]` | `server/Cargo.toml` |

Khuyến nghị (dựa trên mục 1–2 và mã trên):

1. **Pool**: giữ mặc định 8 cho máy 2 GB; **đặt 4 cho máy 1 GB** (PLAN 4.3: mỗi backend Postgres vài MB; `rust-perf.sh`
   profile `1gb` đã dùng 4). Với truy vấn ~vài ms, 4–8 kết nối đã đủ cho hàng trăm rps; pool lớn hơn chỉ tốn RAM
   Postgres. Không tăng pool để chữa quá tải CPU.
2. **Thêm giới hạn đồng thời ở tầng HTTP** (ví dụ `tower::limit::ConcurrencyLimitLayer` hoặc semaphore, đặt khoảng
   150–200 trên e2-micro, cấu hình bằng biến môi trường), kèm `load_shed` trả 503 + `Retry-After`. Lý do: ở c=400 p95 vọt
   lên 1,8 s mà rps giảm; từ chối sớm một phần giữ p95 gần mức 454 ms cho phần còn lại. Cần đo lại sau khi thêm. Hiện chỉ
   có `acquire_timeout` 10 s bảo vệ phía DB, quá dài so với nhịp người dùng.
3. **Hạ `DB_ACQUIRE_TIMEOUT_MS`** xuống 2–3 s trên máy nhỏ để quá tải hiện ra bằng lỗi nhanh thay vì hàng đợi 10 s.
4. **Nối `WORKER_THREADS`** vào `serve.rs` (hiện biến được khai báo nhưng không có tác dụng; `rust-perf.sh` đặt nó cho
   profile 1gb mà không có hiệu lực). Trên 2 vCPU chia sẻ nên đặt 2.
5. **Bộ cấp phát**: chốt mimalloc hay hệ thống cần so trên Linux (glibc malloc phân mảnh khác macOS); mục này chưa đo.

## 4. Chạy lại

```bash
server/scripts/perf-oha.sh http://127.0.0.1:PORT EMAIL MATKHAU [PID_serve]
LEVELS="50 200 400" DURATION=30s PATH_URL=/api/v1/contacts server/scripts/perf-oha.sh ...   # tuỳ chỉnh
```

Cần `oha`, `curl`, `python3`. Script đăng nhập một lần, không in token, in bảng rps/p50/p95/p99/lỗi và RSS đỉnh (lấy
mẫu `ps -o rss=` mỗi giây) khi có PID; chạy từ máy khác thì bỏ PID. Để đo RSS trên e2-micro: chạy script **ngay trên
máy đó** (loopback, cho số xử lý) rồi chạy từ xa không PID (cho số có RTT), ghi cả hai.

## 5. Chưa đo (tiêu chí #263 chưa đủ)

- **Máy 2 GB**: chưa có số nào (chỉ có 1 GB e2-micro và Mac).
- RSS, số kết nối Postgres, swap trên e2-micro.
- Ca 10 request treo ở Graph cùng đăng nhập (đích đăng nhập < 1 s), tệp xuất lớn nhất (< 100 s), tải lên 95 MB:
  dùng `tests/load/rust-perf.sh` trên Linux.
- So mimalloc với bộ cấp phát hệ thống; lặp ≥3 lần lấy trung vị; dữ liệu cỡ thật (hàng nghìn khách).
