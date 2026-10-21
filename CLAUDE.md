# Working on Trinity

## Shipping
- Workflow: [docs/runbooks/fast-delivery.md](docs/runbooks/fast-delivery.md).
- Small changes (wording, UI, an obvious bug) go straight to `main` from the owner account. Large or schema changes go through a pull request that merges as soon as the fast CI job is green. Review comments (Codex) are handled afterwards: a P1 is fixed in the next commit, P2s in a follow-up.
- Tasks the maintainer assigned ship to production once the checks pass. Report what shipped (commit, screens); no screenshot-approval round.
- Every production deploy: copy `.env` first, dump the database when the change has a migration, check health and the screens you touched, roll back at once on errors. Never delete customer data.
- CI runs on pull requests only: gitleaks, CLA, typecheck and tests for changed packages, SQL on Postgres when SQL changed, and — when a PR touches `apps/web` — "Web build and UI checks" (a real `next build`, the UI audit and the break-it scenarios on headless Chrome). There is still no full build for the API services in CI: run `pnpm --filter <package> typecheck` and `test` locally for those; the deploy build catches their build errors.

## Public repository rules
- No deployment-specific details in the repo: hostnames, IPs, server paths, SSH aliases, Page or account ids, keys. Docs describe the generic flow; maintainers keep their own environment notes outside the repo.
- No secrets in commits; gitleaks runs on every PR.

## Product rules
- Every new feature needs its MCP tool. No delete tools; public actions need explicit user confirmation (`confirmed_by_user`). UI text never says "MCP".
- Documentation for architecture, deployment and integrations lives in `docs/`; update it in the same commit as the code.
