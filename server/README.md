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
    trinity-storage  trinity-realtime  trinity-docgen  trinity-obs  trinity-ops
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
| Lỗ hổng (RustSec, đêm) | `cargo audit --file Cargo.lock` (cấu hình `.cargo/audit.toml`) |
| Fuzz (nightly, đêm; không chạy trong `ci-ok`) | `cargo +nightly fuzz run <target>` (target ở `fuzz/`, danh sách ở [`docs/rust/SECURITY-REVIEW.md`](../docs/rust/SECURITY-REVIEW.md)) |

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

## Bảng ca đóng băng (`contracts/cases/`)

Hàm thuần chuyển từ bản TS cũ đã khớp từng byte: đầu vào và kết quả nằm trong một tệp JSON đóng băng (cột kết quả do bản TS
sinh trước khi bản TS bị gỡ ở X06), test Rust chạy cùng tệp và là chuẩn so từ đây. `contracts/cases/kernel.json` (K26: bỏ dấu, số điện thoại, khoảng ngày, định dạng
số và ngày, so sánh chuỗi) chạy ở `crates/trinity-kernel/tests/shared_cases.rs`; cách thêm ca và quyết định từng chỗ: [`docs/rust/locale-vi.md`](../docs/rust/locale-vi.md).
`contracts/cases/plan.json` (K25: khoá và nhãn tính năng, gói, cổng tính năng 403, hạn mức người dùng, cửa sổ cố định của giới hạn tốc độ) chạy ở
`crates/trinity-rbac/tests/plan_cases.rs` và `crates/trinity-http/tests/rate_limit_cases.rs`.
Thêm ca: ghi tay kết quả mong đợi theo luật nghiệp vụ rồi chạy các test trên; ca mới phải được người review xem.

## Migrate

`trinity migrate` chạy bộ migration Prisma nhúng trong binary, ghi `_prisma_migrations` đúng như
`prisma migrate deploy` (hai công cụ dùng chung lịch sử, loại trừ nhau bằng cùng advisory lock; PLAN 4.5).

| Việc | Lệnh |
|---|---|
| Schema `public` (công ty 1) | `trinity migrate` |
| Một schema | `trinity migrate --schema c_12` |
| Mọi công ty (`MULTI_TENANT=true`), song song `TENANT_MIGRATE_CONCURRENCY` (4) | `trinity migrate --companies` |
| Chỉ xem trạng thái (mã 1 khi còn thiếu) | thêm `--status` |
| Dùng thư mục migration khác bộ nhúng | thêm `--dir <thư mục>` |

URL lấy như máy chủ (`DATABASE_URL`; đa công ty `TENANT_DATABASE_URL`, `DIRECT_DATABASE_URL` trước). `--companies` đọc
`platform.companies`, bảng do bước `ensurePlatform` tạo (hiện là lúc khởi động bản Node với `MULTI_TENANT=true`). Nên đặt
`ALTER DATABASE <db> SET client_connection_check_interval = '1s'` (Postgres 14+): khi `prisma migrate deploy` hết giờ
chờ khoá, yêu cầu khoá mồ côi của nó tự hết thay vì chặn các lượt migrate sau.

## Chạy localhost

Cần Postgres đã có DB trống và bản `trinity` đã build (`cargo build -p trinity-bin --release`, binary ở `target/release/trinity`).
Biến môi trường tối thiểu (cùng tên với bản Node):

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | URL Postgres, ví dụ `postgresql://user:pass@localhost:5432/trinity` |
| `JWT_SECRET` | khoá ký JWT (production: ≥ 32 ký tự, không để `change-me-*`) |
| `TRINITY_HTTP_PORT` | cổng nghe (mặc định 3000); `LISTEN_HOST` đổi địa chỉ nghe (mặc định mọi giao diện) |
| `CORS_ORIGIN` | origin của web (mặc định `http://localhost:3000`; chạy web Next ở cổng khác thì đặt cho khớp) |
| `UPLOADS_DIR` | thư mục tệp tải lên (mặc định `./uploads`) |
| `NODE_FALLBACK_URL`, `TRINITY_OWNERSHIP_FILE` | chỉ khi chạy lai với bản Node; không đặt thì Rust nhận mọi route |
| `WEB_UPSTREAM_URL` | địa chỉ Next (ví dụ `http://127.0.0.1:3001`): trang web và `/_next` chưa thuộc Rust đi Next, `/api/v1`, `/notif-ws`, `/uploads`, `/docs` đi Node; không đặt thì mọi thứ đi Node |
| `SHADOW_SAMPLE_RATE`, `SHADOW_REPORT_FILE` | chỉ khi chạy lai (K28): tỉ lệ lấy mẫu shadow 0..1 (mặc định 0 = tắt); `serve` ghi báo cáo mỗi 60 giây ra tệp (mặc định `./shadow-report.json`), xem bằng `trinity shadow-report` (chỉ route, số đếm, đường dẫn JSON khác biệt, không có giá trị dữ liệu) |

```sh
export DATABASE_URL=postgresql://user:pass@localhost:5432/trinity JWT_SECRET=dev-secret-0123456789abcdef0123456789
trinity migrate        # tạo/cập nhật schema
trinity seed           # vai trò Quản trị, cấu hình mặc định, tài khoản admin
trinity serve          # nghe ở http://localhost:3000 ; Ctrl+C để dừng êm
trinity healthcheck    # mã 0 nếu GET /api/v1/health trả 200
```

`trinity serve --port 4000 --host 127.0.0.1` ghi đè cổng và địa chỉ. Module chưa chuyển sang Rust (xem `docs/rust/PLAN.md`, mục "trinity serve")
trả 404 khi chạy một mình; để dùng chúng, chạy kèm bản Node và đặt `NODE_FALLBACK_URL` cùng tệp sở hữu route.

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

## Cấu hình (`trinity-kernel::config`)

Binary đọc **cùng tên biến** với bản Node (`.env.example`, PLAN 4.13). Bảng mọi biến đã biết nằm ở
`crates/trinity-kernel/src/config/vars.rs`, mỗi biến một loại:

- **Server**: binary đọc. Biến chưa có trường riêng trong `Config` đọc bằng `config.var("TÊN")` (tên phải có trong bảng).
- **Elsewhere**: thuộc tiến trình khác (web Next, compose, test e2e); binary biết tên, không đọc, không cảnh báo.
- **Retired**: không còn dùng (`REDIS_URL`, `PORT`, `BACKEND_URL`, biến của serverless, Vercel Blob, Google Sheets,
  YouTube/TikTok, kết nối sàn…). Đặt thì bị bỏ qua kèm một dòng cảnh báo lúc khởi động. Cổng chính đọc từ
  `TRINITY_HTTP_PORT` (mặc định 3000), cổng tương thích từ `COMPAT_API_PORT` (mặc định 4000); hai cổng trùng là lỗi.

Test bảng kiểm mọi biến trong `.env.example` có trong bảng: thêm biến vào `.env.example` thì thêm vào `vars.rs` cùng PR.
Ở production, thiếu `DATABASE_URL` hoặc secret còn giá trị mẫu `change-me-*` hay ngắn hơn 32 ký tự làm binary dừng với mã khác 0 (cùng câu
báo như `insecureSecrets()` của bản Node). `DB_POOL_SIZE` (mặc định 8) thắng `PRISMA_CONNECTION_LIMIT`. Bốn biến địa
chỉ gốc Graph/Zalo (`FACEBOOK_GRAPH_BASE_URL`, `ZALO_OAUTH_BASE_URL`, `ZALO_OPENAPI_BASE_URL`, `ZALO_ZNS_BASE_URL`)
theo luật của bản TS: `http://` chỉ cho host loopback, không query; giá trị sai làm binary không khởi động.

Hướng dẫn cho người vận hành (tiếng Anh): [docs/deployment.md](../docs/deployment.md#rust-server-configuration-preview).
Kiểm cấu hình mà không chạy máy chủ: `trinity check-config` (mã 0 = dùng được, mã 1 = sẽ từ chối khởi động; cảnh báo
và lỗi ra stderr).

### Tệp sở hữu (`TRINITY_OWNERSHIP_FILE`)

Trong cấu hình lai, tệp JSON này ghi bên phục vụ (`rust` | `node`) của từng nhóm route, từng job và migrate nền
(PLAN 4.14; strangler proxy K17 và scheduler K20 dùng chung bộ đọc `trinity-kernel::ownership`):

```json
{
  "routes": [
    { "prefix": "/api/v1/settings", "owner": "rust" },
    { "prefix": "/api/v1/settings/channel-guard", "owner": "node" },
    { "prefix": "/api/v1/contacts", "methods": ["GET"], "owner": "rust" }
  ],
  "jobs": { "lead-scoring.run": "rust" },
  "migrate": "node"
}
```

Luật khớp: tiền tố dài nhất (theo ranh giới `/`), rồi dòng ghi phương thức thắng dòng không ghi; `GET` phủ luôn `HEAD`
(ghi cả hai là lỗi), bỏ trường `methods` = mọi phương thức (`null` là lỗi). Tên job theo bản TS (`lead-scoring.run`,
`stale-work.digest`…); tên lạ chỉ bị cảnh báo. Route, job không có
dòng nào thuộc `node`. Hai dòng cùng tiền tố tranh một phương thức, job ghi hai lần, trường lạ đều làm tệp bị từ chối
với lỗi chỉ dòng, cột.

## Kiểm dữ liệu vào (`trinity-http::validate`)

Body và query được kiểm như `ServiceAwareValidationPipe` của bản TS: route có tiền tố trong `LENIENT_PREFIXES` (auth,
payroll, notification) bỏ trường lạ, route khác trả 400 `property x should not exist`. Luật không chép tay: test
`apps/monolith/src/__tests__/dto-validation-contract.spec.ts` xuất metadata class-validator/class-transformer thật của
DTO ra `contracts/dto/schema.json`, kèm golden do `ValidationPipe` của Nest sinh (`validation.golden.json`,
`transform.golden.json`, `parse-int.golden.json`). Bản Rust chạy cùng thuật toán trên JSON thô rồi mới deserialize vào
struct, nên mảng câu lỗi 400 khớp bản TS từng câu (kể cả câu tiếng Việt, thứ tự decorator, lỗi lồng `items.0.x`).

Thêm một DTO cho handler Rust:

1. Thêm class vào `SAMPLES` (hoặc `TRANSFORM_MODULES`) trong spec trên, sinh lại:
   `UPDATE_GOLDEN=1 pnpm --filter @trinity/monolith exec jest src/__tests__/dto-validation-contract` (cần
   `pnpm --filter "./packages/*" build` trước).
2. `cargo xtask gen-dto <TênDto>` in khung struct (kiểu suy từ luật, `impl Dto`); chép vào crate module rồi sửa kiểu.
3. Handler dùng `ValidJson<T>` / `ValidQuery<T>`; tham số đường dẫn số dùng `parse_int_param` (thay `ParseIntPipe`).

Luật, `@ValidateIf` hay `@Transform` chưa có bản Rust làm `schema.json` nạp lỗi (test `schema_nap_duoc_…` đỏ), không
đoán. Không dùng `garde` như PLAN 4.2 dự kiến: class-validator báo lỗi kiểu như một câu trong cùng mảng, theo thứ tự
decorator, trước khi có kiểu Rust; garde chạy sau serde nên không giữ được hình dạng lỗi đó.
