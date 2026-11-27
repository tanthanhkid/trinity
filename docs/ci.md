# CI/CD và tính năng GitHub

Nguyên tắc: check **bắt buộc** phải nhanh (mục tiêu ≤ 5 phút); việc nặng chạy song song, không bắt buộc, hoặc chạy hằng đêm.

## Giai đoạn viết lại Rust: CI nhẹ trên PR (từ 26/11/2026)
Repo public dùng runner chung có giới hạn chạy đồng thời; nhiều PR cùng lúc (agent + Dependabot) làm hàng đợi dài. Trong lúc
viết lại backend sang Rust (`docs/rust/PLAN.md`):
- **Không chạy trên PR**, chỉ push `main` (+ chạy tay; e2e web có ở Nightly): `Web build and UI checks`, `Rust build (amd64/arm64)`.
- CodeQL là "default setup" của GitHub (chạy cả trên PR), không nằm trong repo nên PR này không đổi được. Muốn bớt hàng đợi: chủ repo vào Settings → Code security → CodeQL analysis → Configure → bỏ chạy trên pull request (chỉ push + lịch), hoặc `gh api -X PATCH repos/tanthanhkid/trinity/code-scanning/default-setup -f state=configured -f schedule=weekly` để chỉnh lại; không check bắt buộc nào phụ thuộc CodeQL.
- `Tests with Postgres` lọc **ở mức job** (output `sql` của `Rust changes`): PR không đổi SQL thì job bị bỏ qua, không khởi động container Postgres.
- Mọi workflow chạy trên PR có `concurrency` huỷ lượt cũ khi đẩy commit mới (`ci.yml`, `pr-triage.yml`, `dependency-review.yml`). `cla.yml` để nguyên (check bắt buộc, còn chạy theo bình luận ký CLA).
- Dependabot: **đóng băng PR cập nhật phiên bản** (`open-pull-requests-limit: 0` mọi hệ); PR vá lỗ hổng (security updates) vẫn mở.
- Check bắt buộc **không đổi**: `ci-ok`, `Secret scan (gitleaks)`, `CLA`.

Hết giai đoạn: bỏ điều kiện `github.event_name != 'pull_request'` ở `web-ui` và `rust-build` trong `ci.yml`, trả giới hạn
Dependabot về 5 / 3 / 3 / 2 (npm / cargo / github-actions / docker).

## Check bắt buộc cho merge vào `main`
| Check | Workflow | Nội dung |
|---|---|---|
| `ci-ok` | `ci.yml` | Tổng hợp `Lint` + `Typecheck` + `Unit tests` + `Removed connectors` + `Secret scan (gitleaks)` + `Rust changes` + `Rust fmt` + `Rust clippy` + `Rust unit` |
| `Removed connectors` (qua `ci-ok`) | `ci.yml` | `node scripts/check-removed-connectors.mjs`: tìm tên biến env, mã định danh và gói của kết nối đã gỡ (Google Sheets/OAuth, YouTube/TikTok/Google Business/Instagram, Shopee/Lazada/KiotViet/Sapo/WooCommerce/MISA, SePay/VNPay/MoMo, Vercel, Deno/extensions, `docx`); đỏ khi có tham chiếu mới. Chỗ lưu trữ hợp lệ (migration, schema lưu trữ, CHANGELOG, `docs/rust/`, handler 410) nằm ở danh sách `ALLOW` đầu script; mục "KNOWN LEFTOVERS" là mã còn sót, cần dọn rồi xoá khỏi danh sách |
| `Secret scan (gitleaks)` | `ci.yml` | gitleaks trên lịch sử PR |
| `Rust fmt`, `Rust clippy`, `Rust unit` (qua `ci-ok`) | `ci.yml` | `cargo fmt --all --check`; `cargo clippy --locked --workspace --all-targets -- -D warnings`; `cargo test --locked --workspace` (mọi test không `#[ignore]`: unit, `tests/`, doctest). Bước biên dịch/kiểm dùng `SQLX_OFFLINE=true` (không cần DB). Job `Rust changes` lọc một chỗ cho mọi job Rust: các bước chỉ thực thi khi PR đổi `server/`, `.github/actions/rust-toolchain/` hoặc `ci.yml`, nên PR không đụng backend Rust xong trong vài giây. Cache `Swatinem/rust-cache` riêng từng job, lưu ở push `main` (và chạy tay), PR chỉ đọc |
| `CLA` | `cla.yml` | Người góp mã ký CLA một lần bằng bình luận |

## Không bắt buộc (chạy song song, xem kết quả khi cần)
| Job | Workflow | Khi nào | Nội dung |
|---|---|---|---|
| `Tests with Postgres (migrate + db specs)` | `ci.yml` | PR (khi đổi SQL/migration/schema, `*.pg.spec`/`*.db.spec`, mã có test DB thật hoặc `.ts` có `$queryRaw`/`$executeRaw`; lọc ở mức job) + push main | Postgres 16: migrate, so `server/contracts/schema.sql` với schema thật (`public` sau migrate + `platform` + trigger; sinh lại bằng `pnpm --filter @trinity/prisma contract:schema`), rồi `*.pg.spec` / `*.db.spec` |
| `Web build and UI checks` | `ci.yml` | push main + chạy tay (tạm không chạy trên PR, mục trên) | `next build`, ngân sách JS, tương phản, UI audit, break-it |
| `Web export (static)` | `ci.yml` | push main + chạy tay (như `Rust build`) | `pnpm --filter ./apps/web build:export` (W02a), `scripts/check-web-export.sh`, thư mục `apps/web/out` là artifact `web-out` 7 ngày; `Rust build` tải artifact này về trước khi biên dịch |
| `Rust build (amd64)`, `Rust build (arm64)` | `ci.yml` | push main + chạy tay (tạm không chạy trên PR, mục trên; PR đã có clippy + unit trong `ci-ok`) | `cargo build --release --locked --all-targets` trên runner x64 và runner arm, `trinity --version`, `server/scripts/check-binary-size.sh` in kích thước binary đã nhúng web và đỏ khi ≥ 80 MB, binary là artifact 7 ngày. Hướng dẫn máy phát triển: `server/README.md` |
| `Rust S3 (MinIO)` | `ci.yml` | push main + chạy tay (không chạy trên PR, như Rust build) | Chạy MinIO bằng docker, tạo bucket, `cargo test -p trinity-storage --test s3_minio` (upload, `Range`, URL ký sẵn tải được, xoá). Không bắt buộc, không nằm trong `ci-ok`; `REQUIRE_MINIO=1` làm thiếu biến thì đỏ |
| `Rust pg tests` | `ci.yml` | PR (khi đổi `server/`, `packages/prisma/prisma/` hoặc `ci.yml`) + push main | Postgres 16: `prisma migrate deploy`, `cargo sqlx prepare --workspace --check` trên DB thật (bắt `.sqlx/` cũ hoặc lệch schema Prisma), rồi `cargo test --workspace --tests -- --ignored` (test pg, đọc `TEST_DATABASE_URL`; Prisma CLI ở `PRISMA_BIN`). Quy ước test pg: `server/README.md`. Không bắt buộc vì cần DB; từ K06 các issue lấy job này làm tiêu chí |
| `Rust deny` | `ci.yml` | PR (khi đổi `Cargo.toml`/`Cargo.lock`/`deny.toml` trong `server/`) + push main | `cargo deny check` theo `server/deny.toml`: giấy phép tương thích AGPL-3.0, phụ thuộc cấm, nguồn crate; lỗ hổng RustSec chỉ trên PR (push main không kiểm advisories để advisory mới không làm đỏ main) |
| `Dependency review` | `dependency-review.yml` | PR | Chặn dependency lỗ hổng ≥ high |
| `Label by path / size`, `Conventional PR title` | `pr-triage.yml` | PR | Nhãn + kiểm tiêu đề `type(scope): …` |
| `Nightly` (full test, Postgres, e2e Playwright, `pnpm audit`, OSV, `Rust advisories (cargo deny)`) | `nightly.yml` | 02:00 giờ VN + chạy tay | Toàn bộ test; báo cáo Playwright là artifact |
| `Scorecard` | `scorecard.yml` | push main + hằng tuần | OpenSSF Scorecard → Code scanning |
| CodeQL | "default setup" của GitHub | PR + push + hằng tuần | JavaScript/TypeScript, Actions (cách giảm tải: mục "Giai đoạn viết lại Rust") |
| `Stale` | `stale.yml` | Hằng ngày | Issue 90+30 ngày, PR 45+21 ngày; bỏ qua `pinned`, `security`, `roadmap`, `help wanted`, `good first issue` |

PR chỉ lint/typecheck/test **gói bị đổi** (và gói phụ thuộc với typecheck); push `main` chạy tất cả.

## Phát hành
1. Commit theo conventional commits (`feat(web): …`, `fix: …`). Tiêu đề PR cũng theo dạng này vì repo chỉ cho squash merge và lấy tiêu đề PR làm commit.
2. `release.yml` (release-please) mở **Release PR** tăng phiên bản trong `package.json`. `CHANGELOG.md` viết tay giữ nguyên; ghi chú tự sinh nằm trong GitHub Release.
   Từ X08, Release PR cũng tăng phiên bản workspace Rust (`server/Cargo.toml`, dòng có `x-release-please-version`); job `sync-lock` của `release.yml` chạy `cargo update --workspace` trên nhánh Release PR để `server/Cargo.lock` khớp (nếu không, `--locked` đỏ).
3. Merge Release PR → tag `vX.Y.Z` + GitHub Release → `docker.yml` dựng image `trinity` (target `trinity` của `Dockerfile`: binary Rust kèm web tĩnh; amd64 trên runner x64, arm64 trên runner arm native, rồi gộp manifest), đẩy GHCR, kèm SBOM, provenance (`actions/attest-build-provenance`) và chữ ký cosign keyless.
4. Lưu ý: PR do `GITHUB_TOKEN` tạo không tự kích hoạt CI. Với Release PR, đóng rồi mở lại (hoặc bấm "Update branch") để các check chạy.

Từ X08, sau khi tạo Release, `release.yml` còn dựng binary `trinity` cho linux amd64 và arm64 (nhúng web export), đính vào Release: `trinity-<tag>-linux-<arch>.tar.gz`, `.sha256`, `.cosign.bundle` (cosign keyless, `cosign sign-blob`), attestation provenance, SBOM CycloneDX (`sbom-trinity-rust.cdx.json`; `sbom-web.cdx.json` khi pnpm có lệnh `sbom`) và `THIRD_PARTY_RUST.md` (`cargo about`). Phần ghi chú Release được nối đoạn "Kiểm chứng bản phát hành". Chạy cục bộ phần giấy phép/SBOM: `scripts/gen-notices.sh` (cần `cargo install --locked cargo-about cargo-cyclonedx`). Image `trinity` đa kiến trúc có ký vẫn đi theo `docker.yml` khi X06 đổi target; X08 chưa đổi `docker.yml`.

### Giấy phép

Giấy phép phụ thuộc Rust chỉ nhận loại tương thích AGPL-3.0: `server/deny.toml` (cổng `cargo deny`) và `server/about.toml` (`accepted`) giữ cùng một danh sách; đổi một nơi thì đổi nơi kia. Phân tích tương thích và bản đếm tay nằm ở `THIRD_PARTY_NOTICES.md`.

Image phát hành duy nhất là `ghcr.io/tanthanhkid/trinity` (binary Rust kèm web tĩnh, chạy cùng `postgres` theo `docker-compose.yml`); ký, SBOM và `cargo about` cho workspace Rust: X08. Người chạy bằng trình quản lý tiến trình lấy binary `trinity-<tag>-linux-<arch>` từ GitHub Release (hoặc artifact `trinity-linux-*` của `contract-rust.yml`). Hướng dẫn nâng cấp bản cài dùng image Node cũ: [upgrade-from-node.md](upgrade-from-node.md).

Thử Dockerfile mà không phát hành: Actions → Docker image → Run workflow (không đẩy: chỉ amd64; chọn push: luôn amd64 + arm64; tag `latest` chỉ khi bật input `latest` hoặc đường release).

Kiểm chứng chữ ký (`<version>` không có tiền tố v, vd `0.4.0`; hoặc dùng `@sha256:<digest>`): `cosign verify ghcr.io/tanthanhkid/trinity:<version> --certificate-identity-regexp 'https://github.com/tanthanhkid/trinity/' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.

## Chạy lại
- Một job: trang PR → Checks → job → "Re-run".
- Workflow chạy tay: Actions → chọn workflow → "Run workflow" (CI, Nightly, Docker, Scorecard, Stale, Release có `workflow_dispatch`).
- CLA: bình luận `recheck`.

## Quy ước
- Mọi action ghim SHA kèm comment phiên bản; Dependabot (`github-actions`) cập nhật hằng tuần (đang đóng băng, xem trên).
- Mỗi job khai `permissions` tối thiểu; chỉ dùng `GITHUB_TOKEN`, không PAT/secret riêng.
- Dependabot: npm gom minor/patch theo tuần, cargo (`server/`, gom minor/patch), github-actions, docker. **Đang đóng băng** PR cập nhật phiên bản (mục "Giai đoạn viết lại Rust"); security updates vẫn chạy.
