# Service contracts

How the Trinity services talk to each other.

- **In-process ports** (monolith): `crm`, `commerce`, `payroll`, `notification` and `auth` run in ONE NestJS process
  (`apps/monolith`). They call each other through dependency-injected ports (`apps/monolith/src/internal-ports`),
  never through HTTP loopback.
- **Service secret** (`INTERNAL_SERVICE_SECRET`, fallback `SERVICE_SECRET`): routes marked `@Internal()` accept the
  `x-service-secret` header.
- **Shared types**: see `packages/shared-types`.
- **Public integrations**: webhooks, MCP/OAuth and the public API are documented in [../integrations](../integrations).
