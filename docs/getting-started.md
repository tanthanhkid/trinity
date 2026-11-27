# Getting started

## Option 1 — Docker (recommended)

Requirements: Docker 24+ with the Compose plugin.

```bash
git clone <your-fork-or-this-repo> trinity && cd trinity
cp .env.example .env
# Edit .env: replace every `change-me-*` value (openssl rand -hex 32 is a good generator).
docker compose up --build
```

What happens:

1. `postgres` starts.
2. `trinity migrate` and `trinity seed` run once and apply the migrations and the seed: the system role, the setting options,
   the first admin account and (only when you set `SEED_DEMO_DATA=true`; default `false`) a few demo contacts with obviously fake data.
3. `trinity serve` serves the web app and the API on port 3000.

Open <http://localhost:3000>. The admin e-mail is `SEED_ADMIN_EMAIL` (default `admin@example.com`). If
`SEED_ADMIN_PASSWORD` was empty, the generated password is printed once:

```bash
docker compose logs | grep -A2 "Admin account"
```

Health check: <http://localhost:3000/api/v1/health>. Swagger UI (<http://localhost:3000/docs>) is off in production; set `SWAGGER_ENABLED=true` in `.env` and restart to turn it on.

Stop and remove everything (including data): `docker compose down -v`.

## Option 2 — Local development (Rust + PostgreSQL, no Docker)

Requirements: the Rust toolchain pinned in `server/rust-toolchain.toml`, PostgreSQL 14+ (16 recommended) and `psql` on Linux, WSL
or macOS. The first-time setup (rustup, sqlx-cli) is in [../server/README.md](../server/README.md).

```bash
cd server
./scripts/localhost.sh      # creates the database if missing, then check-config, migrate, seed --sample, serve
```

Port 3000, sample accounts and how to reset the database: [rust/localhost.md](rust/localhost.md). Step by step:
`cargo run -p trinity-bin -- migrate`, `-- seed --sample`, `-- serve`.

`trinity serve` serves the static web app from `WEB_DIR` when it is set. To work on the UI, use Node 22 (`.nvmrc`) and pnpm 10:

```bash
pnpm install --frozen-lockfile
pnpm --filter web build:export            # static site in apps/web/out; run the server with WEB_DIR=<repo>/apps/web/out
pnpm --filter web dev                     # or the dev server (port 3000: set TRINITY_HTTP_PORT=3100 for the Rust server and point the web app at it)
```

Moving an existing install made with the older Node images: [upgrade-from-node.md](upgrade-from-node.md) (Vietnamese).

## First sign-in: the start wizard

A fresh system opens a short full-screen wizard (no AI assistant needed):

1. **Type of business**: education center, retail and services, clinic/spa/vet, real estate, or *Other* (basic CRM). Each of the first four loads the matching custom-object template.
2. **Modules**: switches ticked for your type (the core set is locked on); add or remove any, then press **Build my system**. This saves the feature switches, applies the template, adds 2–3 clearly fake **sample records** and marks the system built. Running it again is safe (existing tables are kept, no new samples).
3. **First customer**: add one with the short form (or skip). Sample records delete themselves as soon as the first real customer or custom record exists, whether it was created in the UI, through the API or by an AI assistant. The ids of the samples live in the setting row `sample_records`, which is removed after the cleanup.
4. **Channels and first post**: only when the server has social networks configured; both can be skipped.

Accounts created after the system was built skip the wizard. The same build is available as `POST /api/v1/setup/build` (`{"industry": "education_center", "features": ["payments"]}`) and as the MCP tool `setup_build`. Connecting an AI assistant stays optional (Settings › Connections & AI).

## Useful commands

Backend (in `server/`; on a shared machine use `scripts/cargo-q` instead of `cargo`):

| Command | Purpose |
|---|---|
| `cargo check --workspace --all-targets` | Compile check, offline (no database needed) |
| `cargo fmt --all --check` / `cargo clippy --workspace --all-targets -- -D warnings` | Format and lint |
| `cargo test -p <crate>` | Unit tests of a crate (tests that need Postgres are `#[ignore]`d and read `TEST_DATABASE_URL`, see [../server/README.md](../server/README.md)) |
| `cargo run -p trinity-bin -- check-config` | Check the environment |

Web (at the repository root):

| Command | Purpose |
|---|---|
| `pnpm --filter web typecheck` | Type-check the web app |
| `pnpm --filter web lint` | ESLint for the web app |
| `pnpm --filter web e2e` | Playwright end-to-end tests (see `apps/web/e2e/README.md`) |

## Next steps

- Connect an AI assistant over MCP: [integrations/mcp.md](integrations/mcp.md)
- Webhooks: [integrations/webhooks.md](integrations/webhooks.md)
- Custom objects (build your own tables): [custom-objects.md](custom-objects.md)
- Architecture: [architecture.md](architecture.md) — Deployment: [deployment.md](deployment.md)
