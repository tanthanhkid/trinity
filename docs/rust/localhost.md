# Chạy thử backend Rust trên localhost

Mục tiêu: khởi động backend Rust trên Postgres trống, có dữ liệu mẫu để đăng nhập thử. Không dùng cho production.

## Yêu cầu
- Rust (theo `server/rust-toolchain.toml`), Postgres 14+ đang chạy, `psql` trong PATH.
- Linux, WSL hoặc macOS (script bash). Trên Windows chạy trong WSL.

## Các bước
```bash
cd server
cp scripts/localhost.env.example scripts/localhost.env   # tuỳ chọn, sửa DATABASE_URL/mật khẩu
./scripts/localhost.sh
```
Script: kiểm `DATABASE_URL` (mặc định `postgres://postgres:postgres@localhost:5432/trinity`), tạo DB nếu thiếu, sinh
`JWT_SECRET` và `INTERNAL_SERVICE_SECRET` (>= 32 ký tự) nếu chưa đặt, rồi chạy `check-config`, `migrate`,
`seed --sample`, `serve`. Cổng mặc định 3000 (`TRINITY_HTTP_PORT`). Thêm `--no-serve` để chỉ dựng dữ liệu.

Chạy tay từng bước: `cargo run -p trinity-bin -- migrate`, `-- seed --sample`, `-- serve`.

## Biến môi trường tối thiểu
| Biến | Ghi chú |
|---|---|
| `DATABASE_URL` | bắt buộc |
| `JWT_SECRET` | bắt buộc (ngoài production chỉ cần đặt; nên >= 32 ký tự) |
| `INTERNAL_SERVICE_SECRET` | nên đặt, >= 32 ký tự |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | tài khoản Quản trị; không đặt mật khẩu thì sinh ngẫu nhiên và in một lần |
| `SAMPLE_PASSWORD` | mật khẩu tài khoản mẫu (mặc định `Demo@12345`) |

## Tài khoản mẫu
| Email | Vai trò | Mật khẩu |
|---|---|---|
| `admin@example.com` (hoặc `SEED_ADMIN_EMAIL`) | Quản trị | `SEED_ADMIN_PASSWORD` (script mặc định `Admin@12345`) |
| `truongnhom@demo.local` | Trưởng nhóm (phạm vi nhóm) | `Demo@12345` |
| `sale1@demo.local` | Sale (phạm vi của mình) | `Demo@12345` |
| `sale2@demo.local` | Sale (phạm vi của mình) | `Demo@12345` |

Dữ liệu mẫu: 2 nhóm, nhân sự tương ứng, 8 khách hàng, 4 cơ hội, 5 thẻ việc trên bảng "Việc của tôi", 2 sản phẩm.
`seed --sample` chạy lặp lại không nhân đôi và không đổi mật khẩu tài khoản đã có.

## Đặt lại DB
```bash
psql "postgres://postgres:postgres@localhost:5432/postgres" -c 'DROP DATABASE trinity' -c 'CREATE DATABASE trinity'
./scripts/localhost.sh
```
(Hoặc `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` trong DB `trinity`.) Mật khẩu admin chỉ áp dụng khi tài khoản mới tạo, nên đặt lại DB để đổi.
