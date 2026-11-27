# Runbook — Fast delivery (commit to production in under 5 minutes)

How the maintainers ship. The goal is a short loop: a fix is live minutes after it is written, and a bad release is undone in seconds.

## 1. Getting a change onto `main`
- **Small changes** (wording, UI, an obvious bug): the repository owner commits straight to `main`. No pull request, no waiting for review.
  The Codex review runs afterwards; a P1 it finds gets fixed in the next commit.
- **Large changes or anything that touches the database schema**: open a pull request and merge it as soon as the fast CI job is green.
  P2 review comments go to a follow-up pull request.
- Contributors outside the owner account always go through a pull request (branch protection + CLA).

## 2. CI (pull requests and push to `main`)
Full description: [docs/ci.md](../ci.md). Required to merge: `ci-ok`, `CLA`, `Secret scan (gitleaks)`.
| Check | Runs | Typical time |
|---|---|---|
| Lint, Typecheck, Unit tests (feed `ci-ok`) | every PR, in parallel; only changed packages (typecheck also their dependents). Push to `main`: all packages | 1–2 min |
| Secret scan (gitleaks) | every PR | ~10 s |
| CLA | every PR | ~10 s |
| Build api (monolith) | every PR, not required | ~1 min |
| Tests with Postgres (migrate + db specs) | PR steps run only when migrations, `schema.prisma`, `*.pg.spec.ts` or `$queryRaw`/`$executeRaw` code changed; always on `main`. Not required | ~2 min |
| Web build and UI checks | PR steps run only when `apps/web/`, `packages/`, the lockfile or the CI workflow changed; always on `main`. Runs `next build` (static export to `apps/web/out`), checks the export, starts the test static server, then the checks in `apps/web/e2e/premium/` (see its README). Not required | ~5 min |

A nightly workflow runs the full test suite, the Playwright e2e and dependency audits.

The browser checks run on headless Chrome with a temporary profile. Every `/api/v1` call is answered from fixtures through CDP `Fetch`, so no server or real data is involved. The checks are:

- contrast of the design tokens;
- touch targets, keyboard focus, horizontal overflow at 360px and reduced motion on five main screens;
- the "break-it" scenarios (offline, 500/401, empty lists, expired channel token, failed post, undo).
The Docker image builds only for `v*` tags (or by manual dispatch).

## 3. Deploying — one command
The deploy script builds and ships the self-hosted server:
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
| Required CI on a pull request (`ci-ok`) | about 1.5–2 min; heavier jobs run in parallel and are not required |
| Build packages + API + web with warm cache | ~10 s |
| Ship + server switch + health | ~30 s |

Turborepo remote caching does not apply: the workspace builds with pnpm filters, not Turborepo, and Next.js already reuses its own build cache.
