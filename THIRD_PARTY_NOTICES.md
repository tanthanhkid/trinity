# Third-party notices

Trinity is released under AGPL-3.0 (see [LICENSE](LICENSE)). It depends on many open-source packages; their licenses
apply to them. A machine-generated list for the production dependency tree can be produced with:

```bash
pnpm licenses list --prod
```

Summary of the production tree at the time of release (generated with the command above): MIT 825, Apache-2.0 146,
ISC 64, BSD-3-Clause 15, BSD-2-Clause 8, BlueOak-1.0.0 3, other permissive or dual licenses 16, and one LGPL
component (below). Please re-run the command before every release.

## Components that need a specific mention

| Component | License | Notes |
|---|---|---|
| Tinos font (`services/payroll/src/assets/fonts/Tinos-*.ttf`) | Apache-2.0 | Copyright Google / Steve Matteson (Croscore fonts). Used to render payslip PDFs. License: <https://www.apache.org/licenses/LICENSE-2.0>. |
| `sharp` and `@img/sharp-libvips-*` | Apache-2.0 / LGPL-3.0-or-later (libvips) | Image processing. The libvips binaries are LGPL; they are dynamically loaded and unmodified. |
| `xlsx` (SheetJS community edition) | Apache-2.0 | Spreadsheet import/export. The npm package is no longer maintained upstream; replacing it with `exceljs` (already a dependency) is on the roadmap. |
| `jszip` | MIT OR GPL-3.0-or-later | Used under the MIT option. |
| `caniuse-lite` | CC-BY-4.0 | Browser-support data used at build time. |

## Brand assets

`apps/web/public/brand/*` and `apps/web/public/logo/*` are Trinity brand assets; see [TRADEMARK.md](TRADEMARK.md).
Treat them as "all rights reserved" and replace them in forks.
