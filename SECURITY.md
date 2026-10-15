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
