# Runbook — Fast delivery (commit to production in under 5 minutes)

How the maintainers ship. The goal is a short loop: a fix is live minutes after it is written, and a bad release is undone in seconds.

## 1. Getting a change onto `main`
- **Small changes** (wording, UI, an obvious bug): the repository owner commits straight to `main`. No pull request, no waiting for review.
  The Codex review runs afterwards; a P1 it finds gets fixed in the next commit.
- **Large changes or anything that touches the database schema**: open a pull request and merge it as soon as the fast CI job is green.
  P2 review comments go to a follow-up pull request.
- Contributors outside the owner account always go through a pull request (branch protection + CLA).

## 2. CI (pull requests only)
| Check | Runs | Typical time |
|---|---|---|
| Secret scan (gitleaks) | every PR | ~10 s |
| CLA | every PR | ~10 s |
| Typecheck and tests (changed packages) | every PR; typecheck covers changed packages and their dependents, unit tests run in the changed packages only | 1–2 min |
| SQL on Postgres | its steps run only when migrations, `schema.prisma`, `*.pg.spec.ts` or `$queryRaw`/`$executeRaw` code changed | ~20 s when skipped |

Nothing runs on push to `main`. Lint and the full web/api builds are not part of CI; the deploy build catches build errors.
The Docker image builds only for `v*` tags (or by manual dispatch).

## 3. Deploying — one command, targets in parallel
The deploy script runs the serverless targets and the self-hosted server **at the same time**:
- **Serverless (Vercel):** each project builds itself from the commit. Only the public demo deploys by default; a separate test
  instance deploys only when asked for (a flag on the script), since it adds minutes and nobody reviews there. A long-lived instance that already has its admin deploys with
  `SKIP_DB_SEED=1`: migrations still apply, the seed is skipped.
- **Self-hosted server (PM2):** build on the workstation, ship artifacts, restart.
  - **Selective build** from the diff between the server's `.deployed-commit` and the new commit: web only when `apps/web/` or `packages/` changed,
    `pnpm install` only when a `package.json` or the lockfile changed. Unchanged parts are not rebuilt or shipped; with only the API changed,
    only the API process restarts. The Next.js and TypeScript build caches stay in the build checkout, so repeat builds take seconds.
  - **Build errors stop the deploy** before anything is shipped; the server keeps running the previous release.
  - **Backups:** `.env` is copied (mode 600) every time. The database is dumped **only when the diff contains a migration or a schema change**.
  - **Previous release kept as a directory** (moved aside, not archived; the last three are kept), so rollback is a move back plus a restart.
  - **Health gate:** API health and the web login page must answer 200 within 40 s, otherwise the script rolls back automatically.
    A rollback after a migration does not undo the database; restore the dump taken just before.

## 4. Measured (October 2026)
| Step | Time |
|---|---|
| CI on a pull request | under 1 min (was 5–9 min, plus ~9 min again on `main`) |
| Build packages + API + web with warm cache | ~10 s |
| Ship + server switch + health | ~30 s |
| Vercel demo build (parallel with the server) | ~2.5 min: API compile + packaging ~70 s, upload ~25 s; Next.js itself hits its cache (~2 s) |

Turborepo remote caching does not apply: the workspace builds with pnpm filters, not Turborepo, and Next.js already reuses its own cache on Vercel.
