# Working on Trinity

- Delivery workflow: [docs/runbooks/fast-delivery.md](docs/runbooks/fast-delivery.md). Small changes go straight to `main` from the owner
  account; large or schema changes go through a pull request that merges as soon as the fast CI job is green. Review comments are handled afterwards.
- CI runs on pull requests only: gitleaks, CLA, typecheck and tests for changed packages, and SQL on Postgres when SQL changed.
  Run `pnpm --filter <package> typecheck` and `test` locally for what you touched; there is no full build in CI.
- Every new feature needs its MCP tool (no delete tools; public actions need explicit user confirmation). UI text never says "MCP".
- Documentation for architecture, deployment and integrations lives in `docs/`; update it in the same commit as the code.
