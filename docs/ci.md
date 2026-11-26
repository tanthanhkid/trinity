# CI/CD và tính năng GitHub

Nguyên tắc: check **bắt buộc** phải nhanh (mục tiêu ≤ 5 phút); việc nặng chạy song song, không bắt buộc, hoặc chạy hằng đêm.

## Check bắt buộc cho merge vào `main`
| Check | Workflow | Nội dung |
|---|---|---|
| `ci-ok` | `ci.yml` | Tổng hợp `Lint` + `Typecheck` + `Unit tests` + `Secret scan (gitleaks)` + `Rust changes` + `Rust fmt` + `Rust clippy` + `Rust unit` |
| `Secret scan (gitleaks)` | `ci.yml` | gitleaks trên lịch sử PR |
| `Rust fmt`, `Rust clippy`, `Rust unit` (qua `ci-ok`) | `ci.yml` | `cargo fmt --all --check`; `cargo clippy --locked --workspace --all-targets -- -D warnings`; `cargo test --locked --workspace` (mọi test không `#[ignore]`: unit, `tests/`, doctest), rồi spec TS của bảng ca dùng chung `server/contracts/cases/` (`kernel-cases.spec.ts`). Hai bước sau dùng `SQLX_OFFLINE=true` (không cần DB). Job `Rust changes` lọc một chỗ cho mọi job Rust: các bước chỉ thực thi khi PR đổi `server/`, `.github/actions/rust-toolchain/` hoặc `ci.yml`, nên PR không đụng backend Rust xong trong vài giây. Cache `Swatinem/rust-cache` riêng từng job, lưu ở push `main` (và chạy tay), PR chỉ đọc |
| `CLA` | `cla.yml` | Người góp mã ký CLA một lần bằng bình luận |

## Không bắt buộc (chạy song song, xem kết quả khi cần)
| Job | Workflow | Khi nào | Nội dung |
|---|---|---|---|
| `Build api (monolith)` | `ci.yml` | PR + push main | `tsc` build monolith |
| `Tests with Postgres (migrate + db specs)` | `ci.yml` | PR (khi đổi SQL/migration) + push main | Postgres 16: migrate + `*.pg.spec` / `*.db.spec` |
| `Web build and UI checks` | `ci.yml` | PR (khi đổi web/packages) + push main | `next build`, ngân sách JS, tương phản, UI audit, break-it |
| `Rust build (amd64)`, `Rust build (arm64)` | `ci.yml` | PR (khi đổi `server/`, action `rust-toolchain` hoặc `ci.yml`) + push main | `cargo build --release --locked --all-targets` trên runner x64 và runner arm, `trinity --version`, binary là artifact 7 ngày. Hướng dẫn máy phát triển: `server/README.md` |
| `Rust pg tests` | `ci.yml` | PR (khi đổi `server/`, `packages/prisma/prisma/` hoặc `ci.yml`) + push main | Postgres 16: `prisma migrate deploy`, `cargo sqlx prepare --workspace --check` trên DB thật (bắt `.sqlx/` cũ hoặc lệch schema Prisma), rồi `cargo test --workspace --tests -- --ignored` (test pg, đọc `TEST_DATABASE_URL`; Prisma CLI ở `PRISMA_BIN`). Quy ước test pg: `server/README.md`. Không bắt buộc vì cần DB; từ K06 các issue lấy job này làm tiêu chí |
| `Rust deny` | `ci.yml` | PR (khi đổi `Cargo.toml`/`Cargo.lock`/`deny.toml` trong `server/`) + push main | `cargo deny check` theo `server/deny.toml`: giấy phép tương thích AGPL-3.0, phụ thuộc cấm, nguồn crate; lỗ hổng RustSec chỉ trên PR (push main không kiểm advisories để advisory mới không làm đỏ main) |
| `Dependency review` | `dependency-review.yml` | PR | Chặn dependency lỗ hổng ≥ high |
| `Label by path / size`, `Conventional PR title` | `pr-triage.yml` | PR | Nhãn + kiểm tiêu đề `type(scope): …` |
| `Nightly` (full test, Postgres, e2e Playwright, `pnpm audit`, OSV, `Rust advisories (cargo deny)`) | `nightly.yml` | 02:00 giờ VN + chạy tay | Toàn bộ test; báo cáo Playwright là artifact |
| `Scorecard` | `scorecard.yml` | push main + hằng tuần | OpenSSF Scorecard → Code scanning |
| CodeQL | "default setup" của GitHub | PR + push + hằng tuần | JavaScript/TypeScript, Actions |
| `Stale` | `stale.yml` | Hằng ngày | Issue 90+30 ngày, PR 45+21 ngày; bỏ qua `pinned`, `security`, `roadmap`, `help wanted`, `good first issue` |

PR chỉ lint/typecheck/test **gói bị đổi** (và gói phụ thuộc với typecheck); push `main` chạy tất cả.

## Phát hành
1. Commit theo conventional commits (`feat(web): …`, `fix: …`). Tiêu đề PR cũng theo dạng này vì repo chỉ cho squash merge và lấy tiêu đề PR làm commit.
2. `release.yml` (release-please) mở **Release PR** tăng phiên bản trong `package.json`. `CHANGELOG.md` viết tay giữ nguyên; ghi chú tự sinh nằm trong GitHub Release.
3. Merge Release PR → tag `vX.Y.Z` + GitHub Release → `docker.yml` dựng `trinity-api` / `trinity-web` (amd64 trên runner x64, arm64 trên runner arm native, rồi gộp manifest), đẩy GHCR, kèm SBOM, provenance (`actions/attest-build-provenance`) và chữ ký cosign keyless.
4. Lưu ý: PR do `GITHUB_TOKEN` tạo không tự kích hoạt CI. Với Release PR, đóng rồi mở lại (hoặc bấm "Update branch") để các check chạy.

Thử Dockerfile mà không phát hành: Actions → Docker image → Run workflow (không đẩy: chỉ amd64; chọn push: luôn amd64 + arm64; tag `latest` chỉ khi bật input `latest` hoặc đường release).

Kiểm chứng chữ ký (`<version>` không có tiền tố v, vd `0.4.0`; hoặc dùng `@sha256:<digest>`): `cosign verify ghcr.io/tanthanhkid/trinity-api:<version> --certificate-identity-regexp 'https://github.com/tanthanhkid/trinity/' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.

## Chạy lại
- Một job: trang PR → Checks → job → "Re-run".
- Workflow chạy tay: Actions → chọn workflow → "Run workflow" (CI, Nightly, Docker, Scorecard, Stale, Release có `workflow_dispatch`).
- CLA: bình luận `recheck`.

## Quy ước
- Mọi action ghim SHA kèm comment phiên bản; Dependabot (`github-actions`) cập nhật hằng tuần.
- Mỗi job khai `permissions` tối thiểu; chỉ dùng `GITHUB_TOKEN`, không PAT/secret riêng.
- Dependabot: npm gom minor/patch theo tuần (tối đa 5 PR), cargo (`server/`, gom minor/patch), github-actions, docker.
