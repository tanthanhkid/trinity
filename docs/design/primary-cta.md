# Design standard: "One primary action per screen" (Primary CTA)

References: Material Design 3 (button emphasis: filled > tonal > outlined > text), Apple HIG ("one primary action"), Shopify Polaris ("one primary button per page"), the 60-30-10 color rule, the Von Restorff effect. Trinity's brand color: `--primary` = `#2563eb` (blue).

## Rules

| # | Rule |
|---|---|
| C1 | **A solid brand-color fill (`<Button>` variant `default`, or anything `bg-primary`) is ONLY for the PRIMARY ACTION.** Each display region (page / tab / dialog / drawer / sheet) has **at most 1** such visible button. Looking at the screen, a solid blue button = the main job of that screen. |
| C2 | **Secondary actions** → `variant="outline"`. **Tertiary actions** (cancel, reset, see more, utility icons) → `variant="ghost"` or `variant="link"`. |
| C3 | **SELECTED state** (active filter chip, segmented control, toggle, chart switch button, pill-style tab, current pagination page) **does NOT use a solid brand fill** → use the light tone `variant="soft"` (`bg-primary/10` + text `--color-app-primary-ink`) or `aria-pressed`/`data-active` with the same tone. Reason: selecting ≠ acting; a solid fill here competes with the primary button. |
| C4 | **The primary button has a fixed position:** top-right of the page header (`PageHeader`), the RIGHTMOST button, with a leading icon (e.g. `Plus`). In a dialog/drawer: the footer, rightmost, with the Cancel button (`ghost`/`outline`) to its left. |
| C5 | **The "Search"/"Apply" button of a filter bar** is NOT the page's primary action → `outline` (or filter as you type). |
| C6 | **Destructive actions** (delete, lock, cancel order) → `variant="destructive"`. In a delete CONFIRMATION dialog, the delete button is that dialog's primary button and uses `destructive` (not blue). |
| C7 | **No hardcoded button colors**: `bg-blue-*`, `bg-slate-900`, `bg-[#…]` and homemade gradients are forbidden for buttons; only use the variants in `components/ui/button-variants.ts`. Other semantic colors (green "success", orange warning) are for badges/status only, not buttons. |
| C8 | **Empty state:** if the header already has a primary button for the same action → the empty-state CTA uses `outline` (avoid 2 blue buttons). If the screen has no header action → the empty-state CTA may be the primary button. |
| C9 | **View-only/report screens** with no create/edit action may have NO primary button (don't force one). Don't turn navigation buttons ("Report center", "View details") into solid buttons; use `outline`/`link`. |
| C10 | **A disabled primary button keeps variant `default`** (e.g. POS "Pay" when the cart is empty) — it is still the main job. |
| C11 | Shared chrome (sidebar, topbar) is NOT within the scope of this standard — do not modify it. |
| C12 | The primary button label = **short verb + object** in Vietnamese ("Thêm khách hàng" — Add customer, "Tạo chiến dịch" — Create campaign, "Lưu thay đổi" — Save changes), not uppercased via CSS. |

## How to check
- By eye: screenshot the screen and count solid blue buttons in the content area (excluding sidebar/topbar) = 0 or 1.
- By machine: e2e `apps/web/e2e/design/primary-cta.spec.ts` counts visible elements in `main` (outside `[role=dialog]`) whose `background-color` equals the `bg-primary` color → must be ≤ 1.

## Examples

Correct — 1 primary button, secondary is `outline`, selected is `soft`:

```tsx
<PageHeader title="Khách hàng">
  <Button variant="outline">Xuất Excel</Button>
  <Button><Plus /> Thêm khách hàng</Button>   {/* primary button, rightmost */}
</PageHeader>

{filters.map((f) => (
  <Button key={f.id} size="sm" variant={active === f.id ? "soft" : "outline"} aria-pressed={active === f.id}>
    {f.label}
  </Button>
))}

<DialogFooter>
  <Button variant="ghost" onClick={close}>Huỷ</Button>
  <Button>Lưu thay đổi</Button>
</DialogFooter>
```

Wrong:

```tsx
<Button>Tìm kiếm</Button>                          {/* C5: a filter bar is not the main job */}
<Button variant={active ? "default" : "outline"}>  {/* C3: selected state uses a solid fill */}
<Button className="bg-blue-600 text-white">Lưu</Button>   {/* C7: hardcoded button color */}
<Button>Thêm</Button><Button>Nhập file</Button>    {/* C1: 2 solid buttons in the same region */}
```

## Variant `soft`

`components/ui/button-variants.ts`: `bg-primary/10 text-[var(--color-app-primary-ink)] hover:bg-primary/15 aria-pressed:bg-primary/15 ...`.
The text uses `--color-app-primary-ink` (#1e40af) because `text-primary` on a primary/10 background is only 4.49:1 (<4.5).
