# Rà soát bảo mật backend Rust (X10)

Kèm [PLAN.md](PLAN.md) mục 10.2 ("Bảo mật (OWASP)", CORS, CSRF, phiên, rate limit). Bản này làm bằng **đọc mã** trên `main`
ngày 27/11/2026; chưa chạy fuzz hay `cargo audit` (hai việc đó chạy ở CI đêm, mục 3 và 4). Tiêu chí xong của X10: không còn
phát hiện mức cao; mỗi target fuzz chạy 1 giờ không lỗi. Hai tiêu chí đó chỉ đóng được sau lượt chạy thật.

Cột "Mức rà": **đạt** = đã đọc mã và test hiện có phủ; **mẫu** = đã đọc một phần, còn việc ở mục 5; **chưa** = chưa rà.

## 1. Danh sách kiểm theo PLAN 10.2

| Hạng mục | Mã | Mức rà | Ghi chú |
|---|---|---|---|
| SSRF: webhook ra, CIMD, tải media | `trinity-http/src/outbound/ssrf.rs`, `safe_get.rs`; dùng ở `webhooks/sender.rs`, `mod-oauth`, `mod-social` | đạt | Chỉ https, cổng 443/8443, không `user:pass@`; mọi IP phân giải phải công cộng; bộ phân giải của chính client reqwest (chống DNS rebinding); IPv4-mapped, NAT64, 6to4 và IP dạng thập phân/hex qua chuẩn hoá WHATWG; không theo chuyển hướng; cờ cho phép mạng nội bộ chỉ mở khi `NODE_ENV` là test/development |
| SQL injection | `trinity-db/src/prisma_migrate.rs::validate_schema`, `trinity-ops/src/lib.rs::q`, lint `cargo xtask lint` | mẫu | Tên schema chỉ nhận chuỗi số (≤ 20 chữ số) trước khi ghép vào `search_path`; định danh ghép tay đi qua `q()` nhân đôi dấu `"`. Các `format!` SQL còn lại ghép hằng số (`*_COLS`, `*_SELECT`) hoặc mảnh dựng từ danh sách trắng; giá trị luôn `push_bind`/`$n`. Chưa duyệt từng chỗ ở `mod-reports`, `mod-kanban`, `mod-deals` (mục 5) |
| Chèn công thức khi xuất CSV/xlsx | `mod-custom/src/export.rs::csv_cell`, `trinity-docgen/src/xlsx.rs` (`FORMULA_LEAD`) | đạt | Khớp `csv-format.ts` của bản TS; target fuzz `csv_cell` kiểm đọc ngược. Chi tiết nhỏ ở mục 5 |
| So sánh hằng thời gian cho bí mật | `trinity-auth/src/guard.rs::safe_equal`, `webhooks/signature.rs`, `mod-oauth/src/crypto.rs`, `mod-social/src/{state,media_link}.rs`, `mod-zalo/src/signature.rs`, `mod-facebook/src/webhook.rs`, `mod-settings/src/features.rs` | đạt | Mọi so sánh chữ ký/bí mật đọc được đều qua `subtle::ConstantTimeEq`; token API và refresh so qua băm trong truy vấn DB |
| Giới hạn kích thước body | `trinity-http/src/edge/body.rs` | đạt | `JSON_LIMIT` 5 MiB, `STREAM_LIMIT` 200 MiB, chặn từ `Content-Length` rồi đếm khi đọc; `serde_json` mặc định giới hạn đệ quy 128 nên JSON lồng sâu trả lỗi chứ không tràn stack |
| Độ sâu và độ dài đầu ra AI/audit | `mod-mcp/src/ai_output.rs` (`MAX_DEPTH` 6), `trinity-integrations/src/audit.rs` (`MAX_DEPTH` 4) | đạt | Che số điện thoại, bỏ khoá nhạy cảm, cắt độ sâu/độ dài |
| Che số điện thoại với AI/webhook | `webhooks/payload.rs::{mask_phone, scrub_digit_runs}`, `mod-mcp/src/args.rs::reject_digit_probe` | đạt | Có chặn dò bằng chuỗi chữ số |
| Chữ ký webhook vào | `webhooks/signature.rs` | đạt | HMAC-SHA256 `t.<thân>`, dung sai 300 giây, `t` chỉ chữ số ≤ 12 ký tự, header ≤ 512 đơn vị UTF-16; target fuzz `signature` |
| Kiểm quyền theo đối tượng (id ngoài phạm vi → 404) | từng `mod-*` | mẫu | Bảo đảm bằng test pg và bộ hợp đồng theo ba vai (tiêu chí chung của ISSUES); chưa có bảng liệt kê từng route/đối tượng (mục 5) |
| Phiên và JWT | `trinity-auth/src/jwt.rs`, `password.rs` | đạt | Khoá thuật toán HS256, `leeway = 0`, bcrypt cost 10 trong `spawn_blocking` |
| Không lộ stack ở 5xx | `trinity-kernel/src/error.rs` | đạt | 5xx luôn `Internal Server Error`, không kèm `errors` |
| Bí mật không vào log | toàn workspace | mẫu | Tìm `tracing::*!` có `password`, `secret`, `token`, `authorization`: chỉ thấy id và số đếm, không thấy giá trị. Cần thêm `Debug` thủ công cho struct chứa bí mật khi có struct mới (mục 5) |
| Đường dẫn tệp (thoát thư mục) | `trinity-storage/src/key.rs` | đạt | Từ chối `..`, test cho `../../etc/passwd` |
| CORS, CSRF | `trinity-http/src/edge/cors.rs` | chưa | CSRF không có bề mặt vì xác thực bằng header `Authorization` (PLAN 10.2); CORS chưa đọc kỹ |
| Rate limit, IP thật | `trinity-http/src/rate_limit.rs`, `edge/client_ip*`, `mod-auth/src/rate_limit.rs` | chưa | Thuộc K16/K17, có ca test riêng; chưa rà ở X10 |
| Header bảo mật của máy chủ | | mẫu | Có `nosniff` ở phục vụ tệp (`trinity-storage/src/serve.rs`); chưa có lớp chung cho phản hồi khác |

## 2. Phạm vi không nằm trong bản rà này

Web tĩnh do Rust phục vụ (W02b), chuyển tiếp Strangler, kênh mạng xã hội/Zalo ngoài phần chữ ký. Khi các issue đó vào `main`
thì lặp lại mục 1 cho chúng.

## 3. Fuzz

Harness ở `server/fuzz/` (cargo-fuzz, ngoài workspace nên `cargo build --workspace` và clippy không dựng nó).

| Target | Hàm được fuzz | Bất biến |
|---|---|---|
| `mcp_jsonrpc` | `mod_mcp::protocol::handle` | không panic; mã HTTP hợp lệ; thân trả về là JSON hợp lệ |
| `signature` | `verify_signature_header` | không panic; chữ ký tự ký qua; sửa thân thì trượt |
| `webhook_payload` | `parse_inbound_payload` | không panic; `Err` có câu lỗi; `Ok` có SĐT |
| `csv_cell` | `mod_custom::export::csv_cell` | đọc ngược đúng chuỗi gốc (có `'` đầu khi cần); không bắt đầu bằng ký tự công thức |
| `xlsx_read` | `trinity_docgen::xlsx::read_xlsx` | không panic, không treo, không phình bộ nhớ |

Rust hiện chưa có bộ đọc CSV nhập (PLAN 6.3 nêu "bộ đọc CSV"): `csv_cell` kiểm phía ghi, `xlsx_read` kiểm bộ đọc tệp nhập
duy nhất đang có. Khi có bộ đọc CSV thì thêm target cho nó.

Chạy:

```sh
cd server
cargo install cargo-fuzz --locked
cargo +nightly fuzz run mcp_jsonrpc -- -max_total_time=3600 -rss_limit_mb=2048 -timeout=10 fuzz/seeds/mcp_jsonrpc
```

CI: job `rust-fuzz` trong `.github/workflows/nightly.yml` chạy mỗi target 10 phút mỗi đêm (matrix, không bắt buộc cho
merge). Kiểm tiêu chí X10 (1 giờ mỗi target): chạy tay workflow Nightly với `fuzz_seconds = 3600`. Lỗi tìm được thì tải
artifact `fuzz-crash-<target>`, thêm mẫu lỗi vào `fuzz/seeds/<target>/` cùng bản sửa.

## 4. Phụ thuộc

- `cargo-deny` (`server/deny.toml`): giấy phép tương thích AGPL-3.0, nguồn crate, cấm OpenSSL/aws-lc, cảnh báo RustSec;
  chạy ở PR đổi phụ thuộc (job `Rust deny`) và hằng đêm (`rust-advisories`).
- `cargo-audit` (`server/.cargo/audit.toml`): job `rust-audit` hằng đêm, cảnh báo cũng làm đỏ. Danh sách ngoại lệ trùng
  `advisories.ignore` của `deny.toml` (hiện hai mục chrono/chrono-tz không còn bảo trì, theo dõi ở #301); sửa cả hai nơi.
- Cây `server/fuzz/` có `Cargo.lock` riêng khi chạy; nó không phát hành và không vào `deny` của PR.
- Phía Node còn nguyên: `pnpm audit` và OSV-Scanner ở nightly, dependency-review ở PR.

## 5. Việc còn lại

1. Rà từng câu SQL ghép bằng `format!` ở `mod-reports`, `mod-kanban`, `mod-deals`, `mod-hr`: xác nhận mọi mảnh ghép là hằng số
   hoặc từ danh sách trắng.
2. Bảng "route × đối tượng × kiểm quyền" cho các module ghi dữ liệu theo id, kèm ca test 404 ngoài phạm vi còn thiếu.
3. Đặt trần kích thước sau giải nén trước khi đọc xlsx người dùng tải lên, rồi dùng target `xlsx_read` làm hồi quy.
4. Header bảo mật (HSTS, `Referrer-Policy`, `X-Content-Type-Options`, chống nhúng khung) thành lớp chung khi Rust phục vụ
   web tĩnh (W02b/X06).
5. `csv_cell` không thêm `'` cho ô bắt đầu bằng xuống dòng `\n` (đúng như `csv-format.ts`; xlsx thì có). Đổi cả hai
   phía cùng lúc nếu muốn siết, vì bộ golden so từng ký tự.
6. Khi thêm struct chứa bí mật: cài `Debug` che giá trị (hiện chưa thấy chỗ nào lộ).
7. Rà CORS, rate limit và IP thật sau khi K16/K17 ổn định.
