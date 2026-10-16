# Contributing

Thanks for helping build Trinity. Issues and pull requests in English or Vietnamese are both welcome.

## Before you start
- Bug or small fix: open a pull request directly.
- Questions and ideas: [GitHub Discussions](../../discussions).
- New feature or bigger change: open an issue (or an idea in Discussions) first so we can agree on the approach.
- Security issue: **do not** open a public issue. Follow [SECURITY.md](SECURITY.md).

## Pull requests
1. Fork, create a branch from `main`.
2. Keep each PR to one change. Add or update tests.
3. Run `pnpm lint` and `pnpm --filter <package> typecheck` / `test` for the packages you changed before pushing.
4. Describe what changed and why. Screenshots for UI changes.
5. Changing an MCP tool (description, schema, error text)? Test it with a small model (Haiku) using everyday user prompts — see "Testing tool descriptions with a weak model" in [docs/integrations/mcp.md](docs/integrations/mcp.md).

## Contributor License Agreement (CLA)
Trinity is offered under AGPL-3.0 **and** a commercial license. So that we can keep offering both, every contributor signs the short [CLA](CLA.md) once. You keep the copyright to your work; you grant the maintainer the right to distribute it under AGPL-3.0 and under commercial terms.

On your first pull request the **CLA** check comments with a link. Sign by commenting exactly:

> I have read the CLA Document and I hereby sign the CLA

The check then turns green (comment `recheck` if it does not). Signatures are stored in the `cla-signatures` branch.

`main` is protected: contributions go through a pull request, and three checks must pass before merging: **Secret scan (gitleaks)**, **CLA**, and **Typecheck and tests (changed packages)**. A fourth job, **SQL on Postgres**, runs real-database tests when your change touches migrations, the Prisma schema, `*.pg.spec.ts` or raw SQL. CI does not run lint or full builds, so run `pnpm lint` and the build of what you touched locally. How maintainers ship: [docs/runbooks/fast-delivery.md](docs/runbooks/fast-delivery.md).

## Code of conduct
By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
