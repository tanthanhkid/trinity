# Security policy

Trinity holds business data: customers, orders, payroll. We take security reports seriously.

## Reporting a vulnerability
- **Do not** open a public issue.
- Use GitHub's **"Report a vulnerability"** button ([Security tab → Report a vulnerability](../../security/advisories/new)). Reports stay private between you and the maintainers.
- Include steps to reproduce, affected version, and impact.

We aim to acknowledge reports within **3 working days** and to ship a fix for critical issues within **14 days**. We will credit you in the release notes unless you prefer otherwise.

## Supported versions
Security fixes go to the latest release. Trinity Cloud customers are patched automatically.

## Scope notes
- AI assistants act with the permissions of the user who connected them. Writes run directly within those permissions and scopes (the `crm.write` OAuth scope gates them, and every action is logged under *AI activity*); admins can switch on *Require approval for AI changes* to make the assistant only draft changes that a person approves.
- Add-ons created by AI run isolated with limited permissions. A sandbox escape is in scope and critical.

- Client IP (office-IP checks at login and attendance, rate limits) is determined once by the edge process (web, preload `apps/web/peer-ip.cjs`) from the TCP peer and the `TRUSTED_PROXY` setting; client headers such as `X-Forwarded-For`, `X-Real-IP` or `CF-Connecting-IP` are trusted only from the proxy that setting names, and the IP passed between Trinity processes is HMAC-signed (`x-trinity-client-ip`, ±60 s, a bad signature is rejected with 400). A way to make the server accept a client-chosen IP under a correct `TRUSTED_PROXY` is in scope. When the IP cannot be trusted (misconfiguration), office-IP checks let users through instead of comparing a wrong address, rate limits combine a per-peer ceiling with per-email/per-client keys, and admins see a warning banner. Details: [docs/deployment.md](docs/deployment.md#client-ip-trusted_proxy).

## Automated checks
CodeQL, dependency review, OpenSSF Scorecard, secret scanning with push protection and Dependabot run on this repository (see [docs/ci.md](docs/ci.md)). Private vulnerability reporting is enabled.
