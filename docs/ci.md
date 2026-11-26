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
| `ci-ok` | `ci.yml` | Tổng hợp `Lint` + `Typecheck` + `Unit tests` + `Secret scan (gitleaks)` + `Rust changes` + `Rust fmt` + `Rust clippy` + `Rust unit` |
| `Secret scan (gitleaks)` | `ci.yml` | gitleaks trên lịch sử PR |
| `Rust fmt`, `Rust clippy`, `Rust unit` (qua `ci-ok`) | `ci.yml` | `cargo fmt --all --check`; `cargo clippy --locked --workspace --all-targets -- -D warnings`; `cargo test --locked --workspace` (mọi test không `#[ignore]`: unit, `tests/`, doctest), rồi spec TS của bảng ca dùng chung `server/contracts/cases/` (`kernel-cases.spec.ts`, `formula-cases.spec.ts`) và mọi spec `*-contract.spec.ts` trong `services/crm` (hợp đồng đóng băng `server/contracts/`: so từng byte, sinh lại bằng biến `UPDATE_*` ghi ở đầu mỗi spec). Hai bước sau dùng `SQLX_OFFLINE=true` (không cần DB). Job `Rust changes` lọc một chỗ cho mọi job Rust: các bước chỉ thực thi khi PR đổi `server/`, `.github/actions/rust-toolchain/` hoặc `ci.yml`, nên PR không đụng backend Rust xong trong vài giây. Cache `Swatinem/rust-cache` riêng từng job, lưu ở push `main` (và chạy tay), PR chỉ đọc |
| `CLA` | `cla.yml` | Người góp mã ký CLA một lần bằng bình luận |

## Không bắt buộc (chạy song song, xem kết quả khi cần)
| Job | Workflow | Khi nào | Nội dung |
|---|---|---|---|
| `Build api (monolith)` | `ci.yml` | PR + push main | `tsc` build monolith |
| `Tests with Postgres (migrate + db specs)` | `ci.yml` | PR (khi đổi SQL/migration/schema, `*.pg.spec`/`*.db.spec`, mã có test DB thật hoặc `.ts` có `$queryRaw`/`$executeRaw`; lọc ở mức job) + push main | Postgres 16: migrate + `*.pg.spec` / `*.db.spec` |
| `Web build and UI checks` | `ci.yml` | push main + chạy tay (tạm không chạy trên PR, mục trên) | `next build`, ngân sách JS, tương phản, UI audit, break-it |
| `Rust build (amd64)`, `Rust build (arm64)` | `ci.yml` | push main + chạy tay (tạm không chạy trên PR, mục trên; PR đã có clippy + unit trong `ci-ok`) | `cargo build --release --locked --all-targets` trên runner x64 và runner arm, `trinity --version`, binary là artifact 7 ngày. Hướng dẫn máy phát triển: `server/README.md` |
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
3. Merge Release PR → tag `vX.Y.Z` + GitHub Release → `docker.yml` dựng `trinity-api` / `trinity-web` (amd64 trên runner x64, arm64 trên runner arm native, rồi gộp manifest), đẩy GHCR, kèm SBOM, provenance (`actions/attest-build-provenance`) và chữ ký cosign keyless.
4. Lưu ý: PR do `GITHUB_TOKEN` tạo không tự kích hoạt CI. Với Release PR, đóng rồi mở lại (hoặc bấm "Update branch") để các check chạy.

Thử Dockerfile mà không phát hành: Actions → Docker image → Run workflow (không đẩy: chỉ amd64; chọn push: luôn amd64 + arm64; tag `latest` chỉ khi bật input `latest` hoặc đường release).

Kiểm chứng chữ ký (`<version>` không có tiền tố v, vd `0.4.0`; hoặc dùng `@sha256:<digest>`): `cosign verify ghcr.io/tanthanhkid/trinity-api:<version> --certificate-identity-regexp 'https://github.com/tanthanhkid/trinity/' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.

## Chạy lại
- Một job: trang PR → Checks → job → "Re-run".
- Workflow chạy tay: Actions → chọn workflow → "Run workflow" (CI, Nightly, Docker, Scorecard, Stale, Release có `workflow_dispatch`).
- CLA: bình luận `recheck`.

## Quy ước
- Mọi action ghim SHA kèm comment phiên bản; Dependabot (`github-actions`) cập nhật hằng tuần (đang đóng băng, xem trên).
- Mỗi job khai `permissions` tối thiểu; chỉ dùng `GITHUB_TOKEN`, không PAT/secret riêng.
- Dependabot: npm gom minor/patch theo tuần, cargo (`server/`, gom minor/patch), github-actions, docker. **Đang đóng băng** PR cập nhật phiên bản (mục "Giai đoạn viết lại Rust"); security updates vẫn chạy.
