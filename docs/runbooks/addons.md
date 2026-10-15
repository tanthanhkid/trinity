# Runbook — Add-ons (agent self-extension of the system)

Code written by the customer's agent (ChatGPT/Claude via MCP), run ISOLATED on Deno; failures do not affect the main app. Code: `services/crm/src/extensions`,
`services/crm/ext-deno`, tool MCP `services/crm/src/integrations/mcp/tools/extension-*.ts`, UI `apps/web/src/components/extensions`.

## Enable / disable
- `EXTENSIONS_ENABLED=true` (OFF by default) + `deno` (≥ 2.x) installed + `prisma migrate deploy` done.
- Always off when `TRINITY_RUNTIME=serverless` (Vercel demo). Off = no timer, no Deno process, the 8 MCP tools hidden, `/extensions/*` API returns 404.
- Runs in the same process as the monolith: a timer every 30 s picks up `active` jobs matching their schedule (Vietnam time), run SEQUENTIALLY; `active` tools are loaded into a
  resident Deno ext-host (one Worker per tool with its own permissions). **Restarting the monolith ⇒ the ext-host dies with it and is rebuilt at startup**.
- Permissions: `extensions.view` (view), `extensions.draft` (AI drafts/test-runs/deploys approved versions/disables/rolls back), `extensions.approve` (a HUMAN approves/rejects/deploys/disables/enables).

## Resource caps
In Docker, set `mem_limit`/`cpus` for the `api` service in `docker-compose.yml`. On a Linux server without Docker, wrap `deno` with
`systemd-run --scope -p MemoryMax=256M -p MemorySwapMax=0 -p CPUQuota=60% -p TasksMax=64 -- deno "$@"` then point `EXTENSIONS_DENO_BIN` at that script
(keep stdin — the code-loading channel — intact). `--max-old-space-size` only caps the V8 heap, not off-heap memory, so the cgroup is the last safety net.

## Quick local check
```bash
brew install deno            # skip if already installed
cd services/crm && pnpm test extensions            # unit + real Deno integration (skipped if deno is absent)
TEST_DATABASE_URL=postgresql://localhost:5432/<migrated db> pnpm test extensions.service   # same scenarios on real Postgres
cd ../../apps/monolith && RBAC_TEST_DATABASE_URL=… pnpm test:rbac -- test/rbac/extensions   # OAuth+MCP+approval flow via web JWT
```

## When an add-on disables itself
Bell notification "… đã tự tắt vì lỗi liên tục" ("… disabled itself after repeated errors") → Add-ons ("Chương trình con") › open that item › Run log (phone numbers masked) → fix (ask the agent to `update_extension`) → approve the new version → Run/Enable again.
