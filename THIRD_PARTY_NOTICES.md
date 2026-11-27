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
| Tinos font (`server/crates/trinity-docgen/assets/fonts/Tinos-*.ttf`) | Apache-2.0 | Copyright Google / Steve Matteson (Croscore fonts). Used to render payslip PDFs. License: <https://www.apache.org/licenses/LICENSE-2.0>. |
| `sharp` and `@img/sharp-libvips-*` | Apache-2.0 / LGPL-3.0-or-later (libvips) | Image processing. The libvips binaries are LGPL; they are dynamically loaded and unmodified. |
| `xlsx` (SheetJS community edition) | Apache-2.0 | Spreadsheet import/export. The npm package is no longer maintained upstream; replacing it with `exceljs` (already a dependency) is on the roadmap. |
| `jszip` | MIT OR GPL-3.0-or-later | Used under the MIT option. |
| `caniuse-lite` | CC-BY-4.0 | Browser-support data used at build time. |

## Rust dependencies (backend rewrite)

The Rust workspace (`server/`) is compiled into the `trinity` binary. Its machine-generated list is produced by
`scripts/gen-notices.sh` (`cargo about`, configured in `server/about.toml` and `server/about.hbs`) and attached to every
GitHub Release as `THIRD_PARTY_RUST.md`, together with CycloneDX SBOMs (`sbom-*.cdx.json`).

Hand-made count (read from the `license` field of each crate in `server/Cargo.lock`, 541 registry crates, 27 Nov 2026;
the generated file supersedes it): all are permissive. Dominant expressions: `MIT OR Apache-2.0` (about 300 including
slash and reversed forms), `MIT` (103), `Unicode-3.0` (22), `Zlib OR Apache-2.0 OR MIT` (15). Other expressions that
occur: `ISC` (`rustls-webpki`, `untrusted`, `simple_asn1`), `Apache-2.0 AND ISC` (`ring`),
`BSD-3-Clause` (`subtle`, `matchit` together with MIT), `CDLA-Permissive-2.0` (`webpki-roots`, `webpki-root-certs`: Mozilla
root certificate data), `Unlicense OR MIT`, `Apache-2.0 OR BSL-1.0`, `CC0-1.0 OR MIT-0 OR Apache-2.0`. No crate is
GPL-only, LGPL-only, MPL-only or has a non-commercial or "no warranty only" licence. One crate pair offers
`LGPL-2.1-or-later` as a third alternative (`MIT OR Apache-2.0 OR LGPL-2.1-or-later`): Trinity uses the MIT option.
`aws-lc-rs` / `aws-lc-sys` appear in `Cargo.lock` only as inactive optional dependencies (TLS uses `ring`); `cargo deny`
(`bans`) fails the build if they ever enter the graph.

### Compatibility with AGPL-3.0

Trinity is AGPL-3.0-only. `server/deny.toml` (`cargo deny check licenses`) and `server/about.toml` accept only: Apache-2.0
(also with LLVM exception), BSD-2/3-Clause, BSL-1.0, CC0-1.0, CDLA-Permissive-2.0, ISC, MIT, MIT-0, MPL-2.0,
Unicode-3.0, Unlicense, Zlib. All are one-way compatible with AGPL-3.0: permissive licences may be included in an AGPL
work; Apache-2.0 is compatible with GPLv3 and AGPLv3 (not with GPLv2-only); MPL-2.0 is compatible via its secondary-licence
clause (section 3.3) and keeps file-level copyleft for MPL files; CDLA-Permissive-2.0 covers data only. Rejected by
design: GPL-2.0-only, SSPL, BUSL, Commons Clause, CC-BY-NC and anything unlisted. Keep the two lists identical.

## Brand assets

`apps/web/public/brand/*` and `apps/web/public/logo/*` are Trinity brand assets; see [TRADEMARK.md](TRADEMARK.md).
Treat them as "all rights reserved" and replace them in forks.
