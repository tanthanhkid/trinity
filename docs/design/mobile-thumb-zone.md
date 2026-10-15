# Standard: "Button placement on phones" (thumb zone)

Extends the one-primary-action standard (`primary-cta.md`, C1–C12). Scope: the web app opened on a phone, **< 640px** (`max-sm:`, same breakpoint as `ShellResponsiveList`). **Desktop with a mouse (≥640px, `pointer: fine`) does NOT change by a single pixel** — every platform change sits behind `max-sm:`, `@media (max-width: 639px)` or (only for the M3 touch targets) `@media (pointer: coarse)`.

Sources: Steven Hoober's "thumb zone", Apple HIG (44×44pt), Material Design 3 (FAB, bottom sheet), WCAG 2.2 SC 2.5.5/2.5.8, Fitts's law.

## Rule table

| # | Rule | Provided by the platform | What each screen must do |
|---|---|---|---|
| M1 | The primary button of a LIST screen → extended FAB at bottom right | `MOBILE_FAB_CLASS` | add `className={MOBILE_FAB_CLASS}` to the header's primary button itself |
| M2 | The primary button of a FORM/PAYMENT/SAVE → sticky bottom bar | `<MobileActionBar>` | wrap the form footer: Cancel (ghost) first, primary button LAST |
| M3 | Touch targets ≥ 44×44 (<640px AND iPad/touch `pointer: coarse`), spaced ≥ 8px; every button ≥ 24×24 at ALL widths (WCAG 2.5.8) | CSS `Button`, Switch (`::after`), Tab trigger, calendar buttons of `VnDateInput`/`VnDatetimeInput` | a raw `<button>`/chip/icon in a table must reach `min-h-11 min-w-11` itself |
| M4 | Header: title + at most 2 secondary buttons, the rest in a "⋯" menu | — | the screen does it itself (`DropdownMenu`, `variant="outline" size="icon"`, aria-label "Thao tác khác" — "More actions") |
| M5 | Filters with > 2 fields → a "Filters (n)" button ("Bộ lọc (n)") + bottom slide-up sheet | `<MobileFilterSheet>` | wrap the filter fields (leave the main search box outside) |
| M6 | A dialog = bottom sheet; footer stacked vertically, primary button at the BOTTOM | `DialogContent`, `DialogFooter`, `ConfirmDialog` | do not build your own `fixed inset-0` modal |
| M7 | Tabs in a single row, horizontally scrollable | `TabsList`/`TabsTrigger` (including `layout="wrap"`, `ShellTabsList`) | hand-built tabs must follow |
| M8 | Many-column tables → a card list | `ShellResponsiveList` + `ShellListCard` (provided) | the screen switches itself |
| M9 | 16px page margin | `main` `max-sm:px-4 max-sm:pb-28` | do not add nested `px-*`/`mx-*`/`max-w` |
| M10 | Dangerous actions not next to the primary button | — | put in the "⋯" menu or at the end of the form, always with `ConfirmDialog` |

## Usage

```tsx
// M1 — list screen
<Button className={MOBILE_FAB_CLASS}><Plus /> Thêm khách hàng</Button>

// M2 — form
<MobileActionBar>
  <Button variant="ghost" onClick={cancel}>Huỷ</Button>
  <Button type="submit">Lưu khách hàng</Button>
</MobileActionBar>

// M5 — filters
<MobileFilterSheet activeCount={n} onReset={reset} title="Bộ lọc">
  <Select …/> <Select …/> <VnDateInput …/>
</MobileFilterSheet>
```

Signatures:
- `MOBILE_FAB_CLASS: string` — `@/components/app-shell/mobile-primary`.
- `MobileActionBar({ className?: string; children: ReactNode })` — `@/components/app-shell/mobile-action-bar`. Renders the bar + an `h-24` spacer (only <640px). CSS-only.
- `MobileFilterSheet({ activeCount?: number; onReset?: () => void; title?: string; children: ReactNode })` — `@/components/app-shell/mobile-filter-sheet`. ≥640 renders children inline; <640 a button + `Sheet side="bottom"`. Uses `useIsPhone()` (`@/hooks/use-is-phone`), so SSR/first hydration is the desktop layout and then switches immediately.

## Technical notes

- The FAB and `MobileActionBar` share `z-40` (below Dialog/Sheet `z-50`) — do NOT use both on one screen.
- `fixed` is anchored to ancestors with `transform`/`filter`/`backdrop-filter`/`contain`: do not place the FAB inside such a block.
- Touch targets: CSS in `app/globals.css` (`@layer components`, media <640px + a coarse branch ≥640px). A regular `Button` has `min-height: 44px` (icon adds `min-width`); `xs`/`icon-xs`/`link`, buttons inside `input-group`, and dialog/sheet close buttons do NOT change layout but grow via `::after`. `min-height` beats any `h-*`, so a screen's `h-8`/`h-9` classes cannot break it; for a shorter button use `size="xs"`.
- iPad/touch ≥640px: `@media (pointer: coarse) and (min-width: 640px)` in the same CSS block only adds a transparent `::after` of `max(100%, 44px)` to EVERY `Button` (and dialog/sheet close buttons) — it does NOT change `min-height`, so iPad tables/filter bars/topbars keep their layout. Switch (`pointer-coarse:sm:after:size-11`) and horizontal Tab triggers (`::before` -inset-y-2) have their own coarse variants in `components/ui/`. The `::after` of two adjacent buttons overlaps by a few px if they are < 8px apart (the later DOM node wins) — keep spacing ≥ 8px (`gap-2`). Mouse (`pointer: fine`) is unaffected.
- iPad, RAW buttons/tabs: the same coarse ≥640px branch also has the selector `:is(button, [role="button"], [role="tab"]):not([class*="after:"])` (+ a `.touch-target` marker class for other elements such as `<a>`) opening a 44px `::after` — covering the topbar (collapse/expand menu, bell, account menu), filter chips, buttons in tables… ONE shared place, no layout change; <640px and mouse are unchanged. Elements that use an `after:` utility themselves (Switch, underline tabs) are skipped so their pseudo-element is not broken — they must have their own `pointer-coarse:` variant. The e2e test `design/mobile-thumb-zone.spec.ts` measures the EFFECTIVE touch target (box ∪ absolutely positioned `::before/::after`), threshold still 40px; an `::after` clipped by an `overflow:hidden` ancestor is still counted, so buttons inside a clipping frame need spare room.
- 24×24 floor at all widths: small raw `<button>`/links (show/hide password, clear date, sortable column headers, Kanban column names, "See …" links) enlarge the touch target with `relative`/`absolute` + `after:absolute after:-inset-* after:content-['']`, WITHOUT enlarging the icon or changing layout.
- A checkbox is a native `<input>` (no `::after`): only enlarge it to 20px; the 44px touch target comes from the screen's wrapping `<label>`.
- `CommandDialog` (the search palette) intentionally KEEPS its top anchor and does not become a bottom sheet (the keyboard would cover the bottom).
- Dropdown/Select inside `MobileFilterSheet` portal to body: check whether they wrongly close the sheet.
- e2e: `pnpm --filter web e2e:design` runs `e2e/design/mobile-thumb-zone.spec.ts` (390×844, `expect.soft`, prints measurements).
