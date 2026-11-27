# Service contracts

How the parts of Trinity talk to each other.

- **One process**: the domain modules (`mod-*` crates under `server/crates/`) are linked into the single `trinity` binary and call
  each other as ordinary functions, never through HTTP loopback.
- **HTTP contract**: the public routes, request/response shapes and permissions are frozen in `server/contracts/`
  (`openapi.json`, `routes.json`, `rbac.json`); `trinity check-routes` compares the routes the binary declares with `routes.json`.
- **Service secret** (`INTERNAL_SERVICE_SECRET`, fallback `SERVICE_SECRET`): routes marked internal accept the
  `x-service-secret` header.
- **Public integrations**: webhooks, MCP/OAuth and the public API are documented in [../integrations](../integrations).
