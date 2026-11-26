# Backend Trinity bằng Rust (`server/`)

Cargo workspace của bản viết lại backend. Kế hoạch, bố cục crate và lý do chọn thư viện:
[`docs/rust/PLAN.md`](../docs/rust/PLAN.md) (mục 4.1, 4.2, 4.4, 8, 11); danh sách issue:
[`docs/rust/ISSUES.md`](../docs/rust/ISSUES.md).

```
server/
  Cargo.toml            workspace; bảng phiên bản thư viện dùng chung ([workspace.dependencies])
  Cargo.lock            ghim chính xác mọi crate (CI build với --locked)
  rust-toolchain.toml   toolchain ghim (rustup tự cài khi chạy cargo trong server/)
  deny.toml             cargo-deny: giấy phép tương thích AGPL-3.0, lỗ hổng, nguồn crate
  .cargo/config.toml    SQLX_OFFLINE=true mặc định, alias `cargo xtask`
  .sqlx/                dữ liệu kiểm truy vấn offline, một tệp mỗi truy vấn (commit vào repo)
  scripts/cargo-q       hàng đợi biên dịch chung trên một máy
  xtask/                công cụ workspace (sinh model, kiểm route…)
  crates/
    trinity-bin         binary `trinity`
    trinity-kernel  trinity-db  trinity-auth  trinity-rbac  trinity-http  trinity-jobs
    trinity-storage  trinity-realtime  trinity-docgen  trinity-obs
    mod-*               module nghiệp vụ, thêm theo từng issue (glob `crates/*`, không phải sửa Cargo.toml gốc)
```

## Cài máy phát triển (máy sạch, không Docker, không sudo)

1. **Rust** qua rustup cho người dùng hiện tại:

   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
   . "$HOME/.cargo/env"
   cd server && rustup toolchain install   # cài đúng bản ghim trong rust-toolchain.toml, kèm rustfmt và clippy
   ```

2. **sqlx-cli** đúng phiên bản sqlx của workspace, chỉ Postgres, TLS bằng rustls:

   ```sh
   cargo install sqlx-cli --version 0.9.1 --no-default-features --features postgres,rustls --locked
   ```

3. **Postgres 16** cài thường (chỉ cần khi thêm/sửa truy vấn hoặc chạy test pg):
   macOS `brew install postgresql@16 && brew services start postgresql@16`;
   Debian/Ubuntu `apt install postgresql-16`. Tạo một DB riêng cho mình, ví dụ `createdb trinity_<tên>`.

4. **Node + pnpm** như phần còn lại của repo (`pnpm install --frozen-lockfile` ở gốc repo), để migrate bằng Prisma.

Kiểm cài đặt (trong `server/`):

```sh
cargo check --workspace --all-targets          # offline: không cần DB
cargo run -q -p trinity-bin -- --version       # trinity <phiên bản>
```

## Lệnh hằng ngày

Chạy trong `server/`. Trên máy dùng chung, thay `cargo` bằng `scripts/cargo-q` (mục cuối).

| Việc | Lệnh |
|---|---|
| Kiểm một crate | `cargo check -p <crate>` |
| Định dạng | `cargo fmt --all` (CI: `cargo fmt --all --check`) |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` |
| Lint SQL và giữ kết nối (PLAN 4.3) | `cargo xtask lint` (ngoại lệ có chủ đích: `/* trinity-lint: allow-star */` trong câu SQL, `// trinity-lint: allow-http-hold` trên dòng gọi HTTP) |
| Test không cần DB của một crate (unit, tests/, doctest) | `cargo test -p <crate>` |
| Test pg (đánh dấu `#[ignore]`, chạy có chủ đích) | `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p <crate> --tests -- --ignored` |
| Giấy phép, lỗ hổng | `cargo deny check` (cần [cargo-deny](https://github.com/EmbarkStudios/cargo-deny)) |

Build release, test pg đầy đủ, bộ hợp đồng và build hai kiến trúc chạy trên CI ([`docs/ci.md`](../docs/ci.md)).

## Truy vấn SQL và `.sqlx/`

Không ORM, không `sqlx migrate` (lịch sử migration vẫn là thư mục Prisma, PLAN 4.5).

- **Truy vấn tĩnh** dùng `sqlx::query!`, `query_as!`, `query_scalar!`: kiểu cột và tham số được kiểm lúc biên dịch.
  `.cargo/config.toml` đặt `SQLX_OFFLINE=true`, nên macro đọc dữ liệu đã lưu trong `.sqlx/` thay vì nối DB:
  `cargo check`, clippy và CI không cần Postgres. Truy vấn chưa có dữ liệu trong `.sqlx/` làm biên dịch lỗi
  (`SQLX_OFFLINE=true but there is no cached data for this query`).
- **Truy vấn có bộ lọc động** dùng `sqlx::QueryBuilder` hoặc `query_as` không macro, giá trị luôn đi qua bind (không
  nối chuỗi giá trị vào SQL). Loại này không được kiểm lúc biên dịch nên **bắt buộc có test pg**.
  Test pg đánh dấu `#[ignore = "cần Postgres…"]` và đọc `TEST_DATABASE_URL`; thiếu biến thì test lỗi, không âm thầm qua.

**Quy ước test pg** (CI dựa vào đây, docs/ci.md):

- `#[ignore]` chỉ dành cho test cần Postgres; test chậm hay chưa xong không được đánh `#[ignore]` (dùng cờ khác).
  Job `Rust unit` (bắt buộc) chạy `cargo test --workspace`, tức mọi test không `#[ignore]` kể cả `tests/` và doctest;
  job `Rust pg tests` chạy `cargo test --workspace --tests -- --ignored` (không doctest) trên Postgres 16 đã migrate.
- Test pg đặt trong `tests/` của crate, đọc `TEST_DATABASE_URL`; cần Prisma CLI thì đọc `PRISMA_BIN` (mặc định
  `packages/prisma/node_modules/.bin/prisma`, có sau `pnpm install`).
- URL DB luôn ghi rõ user (`postgresql://$USER@localhost:5432/...`): Prisma không tự lấy user hệ điều hành như
  `psql`, thiếu user thì `prisma migrate deploy` báo `P1010`.

Khi thêm hoặc sửa một truy vấn tĩnh:

```sh
export DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên>
# 1. Migrate DB riêng của mình bằng Prisma (ở gốc repo). Làm lại mỗi khi có migration mới.
(cd .. && pnpm --filter @trinity/prisma exec prisma migrate deploy)
# 2. Sinh lại dữ liệu kiểm truy vấn (sqlx-cli tự tắt chế độ offline trong lượt này)
cargo sqlx prepare --workspace
# 3. Trước khi đẩy: .sqlx/ phải khớp mã
cargo sqlx prepare --workspace --check
git add .sqlx
```

`.sqlx/` giữ một tệp mỗi truy vấn (tên theo hash câu SQL), nên các PR song song chỉ thêm tệp mới và rebase không xung
đột. Tệp của truy vấn đã xoá được `prepare` dọn đi. Job `Rust pg tests` trên CI migrate một Postgres 16 bằng Prisma,
chạy `cargo sqlx prepare --workspace --check` trên DB đó (không offline) rồi chạy mọi test `#[ignore]` bằng `--ignored`.

## Hàng đợi biên dịch chung

Máy phát triển 16 GB chỉ chịu **một tiến trình biên dịch Rust tại một lúc** (PLAN mục 11). Mọi agent và người dùng
cùng máy gọi cargo qua `scripts/cargo-q` thay cho `cargo`:

```sh
scripts/cargo-q check -p trinity-db
scripts/cargo-q test -p trinity-db --lib
scripts/cargo-q sqlx prepare --workspace
```

`cargo-q` giữ một khoá `flock` (mặc định `~/.cache/trinity/cargo.lock`, đổi bằng `TRINITY_CARGO_LOCK`) trong suốt lệnh
cargo; lệnh tới sau in `đang có lượt biên dịch khác, chờ...` rồi chạy khi khoá nhả. Tiến trình chết thì khoá tự nhả.

Quy ước kèm theo:

- Chỉ `cargo check -p <crate>` và test của crate mình đụng; không build release hay chạy test cả workspace tại máy.
- Nên dùng chung thư mục build giữa các worktree để không biên dịch lại thư viện:
  `export CARGO_TARGET_DIR=$HOME/.cache/trinity/target`.
- Kiểm bộ nhớ trước lượt nặng (`memory_pressure` trên macOS); còn dưới 25% thì chờ.
