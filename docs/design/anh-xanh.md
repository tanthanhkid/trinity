# «Ánh xanh» — hệ thiết kế Trinity Premium

Giữ nền Trinity (Inter, nền `#FBFBFA`, xanh `#3A75A6`, viền `#EBEBE8`) và thêm chiều sâu bằng ánh xanh:
mỗi màn **một** khối nhấn xanh đậm có quầng sáng, phần còn lại là lớp chuyển màu rất nhạt.
Desktop (≥ 1024px) và điện thoại là **hai bố cục khác nhau**, không co giãn một bố cục.

- Token: `apps/web/src/app/globals.css` (khối `:root` «Ánh xanh» + `.dark`), tiền tố `--ax-`.
- Token cũ (`--shadow-card`, `--shadow-pop`, `--color-app-primary-*`, `--color-app-blue-*`) ở
  `apps/web/src/styles/app-tokens.css` đã map sang cùng giá trị — màn chưa chuyển vẫn đồng bộ.
- Khung dashboard đã dùng nền trang `--ax-grad-page` (desktop) / `--ax-grad-page-mobile` (dưới 1024px).
- Body: Inter với `font-feature-settings: "cv11","ss01","ss03"` + `tabular-nums`.
- Test khoá: `apps/web/src/__tests__/components/anh-xanh/` (token khai đủ, giá trị gốc, tương phản ≥ 4,5:1).

## Token

| Nhóm | Token |
|---|---|
| Nền, chữ, viền | `--ax-bg` `--ax-bg-mobile` `--ax-surface` `--ax-ink` `--ax-ink-2` `--ax-ink-3` `--ax-line` `--ax-divider` `--ax-sunken` `--ax-hover` `--ax-press` `--ax-field-border(-hover)` `--ax-btn-border` `--ax-placeholder` |
| Màu chính | `--ax-primary` `--ax-primary-hover` `--ax-primary-press` `--ax-primary-ink` `--ax-primary-soft` `--ax-primary-soft-2` `--ax-primary-soft-border` |
| Khối nhấn | `--ax-hero-1/2/3` `--ax-hero-border` `--ax-on-hero-ink` `--ax-on-hero-ink-2` `--ax-on-hero-tile` `--ax-on-hero-primary-bg/ink/hover` `--ax-on-hero-secondary(-hover/-border)` |
| Trạng thái | `--ax-danger(-soft/-ink/-press/-border)` `--ax-warn(-soft)` `--ax-success(-soft)` `--ax-brand-red` (chỉ dấu thương hiệu) |
| Giai đoạn | `--ax-stage-{new,consult,quote,won,care}-{dot,bg,ink}` |
| Gradient nhấn | `--ax-grad-hero` |
| Gradient nhạt | `--ax-grad-page` `--ax-grad-page-mobile` `--ax-grad-soft` `--ax-grad-primary(-hover)` `--ax-grad-card` `--ax-grad-stat` `--ax-grad-composer` `--ax-grad-avatar-customer` `--ax-grad-avatar-staff` `--ax-grad-toast` `--ax-grad-bar` `--ax-grad-empty` |
| Độ nổi | `--ax-shadow-card` (thẻ) · `--ax-shadow-float` (khay, ngăn kéo, popover, toast, thanh dính) · `--ax-shadow-inset` (lõm) · `--ax-shadow-soft` `--ax-shadow-hero` `--ax-shadow-primary` `--ax-shadow-secondary` `--ax-shadow-danger` `--ax-shadow-avatar` |
| Focus | `--ax-focus-ring` (nút, link) · `--ax-field-focus` (ô nhập) · `--ax-scrim` (lớp phủ) |
| Bo góc lồng | `--ax-radius-field` 8 · `--ax-radius-card` 12 · `--ax-radius-sheet` 16 · `--ax-radius-sheet-mobile` 20 · `--ax-radius-hero` 20 · `--ax-radius-chip` 999 |
| Khoảng cách | `--ax-space-1..12` (4 · 8 · 12 · 16 · 20 · 24 · 32 · 48) |

Utility Tailwind: màu `bg-ax-*` / `text-ax-*` / `border-ax-*` (vd `text-ax-ink-3`), `shadow-ax-card|float|inset|hero`,
`rounded-ax-field|card|sheet|hero`. Gradient và khối dựng sẵn (tên bắt đầu `ax-`, không `bg-`, để `tailwind-merge`
không gộp mất): `ax-grad-hero`, `ax-grad-soft`, `ax-grad-primary`, `ax-grad-card`, `ax-grad-stat`,
`ax-grad-composer`, `ax-grad-toast`, `ax-grad-bar`, `ax-grad-empty`, `ax-page`, `ax-card`, `ax-float`, `ax-sunken`.
Chữ: `ax-text-display` (36) · `ax-text-title` (24) · `ax-text-heading` (20) · `ax-text-subhead` (17) ·
`ax-text-label` (12/500) · `ax-text-group` (11/600 in hoa) · `ax-amount` (số tiền, SĐT, KPI).

## Component

| Component | Import | Ghi chú |
|---|---|---|
| Button | `import { Button } from "@/components/ui/button"` | `variant`: `ax-primary` (gradient) · `ax-secondary` · `ax-ghost` · `ax-danger` · `ax-on-hero` · `ax-on-hero-secondary`; `size`: `ax-sm` 36 · `ax` 40 · `ax-lg` 48 · `ax-icon`. Biến thể cũ giữ nguyên. Nút-là-link: `cn(buttonVariants({ variant: "ax-primary", size: "ax" }))`. |
| Field | `import { AxField } from "@/components/ui/field"` · `import { Input, AX_INPUT_CLASS } from "@/components/ui/input"` | `AxField` = nhãn + ô + gợi ý/lỗi, tự nối aria. `<Input variant="ax">` cho ô tự ghép; `AX_INPUT_CLASS` cho `<textarea>`. |
| StageChip | `import { StageChip } from "@/components/ui/stage-chip"` | `tone`: `new` `consult` `quote` `won` `care` `neutral`; màu cột tự do: `dotColor`; `onClick` + `selected` ⇒ nút có `aria-pressed`. Chọn tông từ dữ liệu thật ở màn tính năng. |
| Avatar | `import { Avatar, AvatarFallback, AvatarImage, PersonAvatar } from "@/components/ui/avatar"` | `kind="customer"` bo 30% · `kind="staff"` tròn; size thêm `xl` 48, `2xl` 64. `PersonAvatar` dựng từ `name` + `src`. |
| HeroCard | `import { HeroCard, HeroCardLabel, HeroCardValue, HeroCardTile } from "@/components/ui/hero-card"` | Khối nhấn, mỗi màn đúng một. `compact` cho ô tổng nhỏ. Nút trên khối: `ax-on-hero*`. |
| Toast có Hoàn tác | `import { showUndoToast, UndoToast } from "@/components/ui/undo-toast"` | `showUndoToast("Đã lưu số điện thoại", { onUndo })` qua `<Toaster>` sẵn có; tự ẩn 5 giây; Hoàn tác gọi một lần. |
| EmptyState | `import { EmptyState } from "@/components/ui/empty-state"` | `variant="ax"`: khối lõm có quầng, icon nét 20, tiêu đề 15/600, lời nhắn, hành động. |
| BottomSheet | `import { BottomSheet, BottomSheetTrigger, BottomSheetContent, BottomSheetFooter, BottomSheetClose } from "@/components/ui/bottom-sheet"` | Khay đáy điện thoại (Dialog Base UI: khoá focus, Esc, trả focus). `title` bắt buộc. |
| StickyActionBar | `import { StickyActionBar } from "@/components/ui/sticky-action-bar"` | `layout="auto"`: dưới 1024px dính đáy + khoảng đệm, từ 1024px nổi sticky căn phải. Nút chính đặt CUỐI. |

### Ví dụ

```tsx
<HeroCard>
  <HeroCardLabel>Tổng cộng</HeroCardLabel>
  <HeroCardValue unit="₫">{formatNumber(total)}</HeroCardValue>
  <div className="mt-4 flex gap-2">
    <Button variant="ax-on-hero" size="ax-lg" className="flex-1">Thanh toán</Button>
    <Button variant="ax-on-hero-secondary" size="ax-lg">Lưu tạm</Button>
  </div>
</HeroCard>

<AxField label="Số điện thoại" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
  error={invalid ? "Số điện thoại cần đủ 10 chữ số" : undefined} />

<StageChip tone="consult">Đang tư vấn</StageChip>

<PersonAvatar kind="customer" name={contact.name} src={contact.avatarUrl} size="lg" />

await save(next)
showUndoToast("Đã lưu số điện thoại", { onUndo: () => save(prev) })

<EmptyState variant="ax" icon={Users} title="Chưa có khách nào" message="Khách mới sẽ hiện ở đây."
  action={<Button variant="ax-primary" size="ax">Thêm khách</Button>} />

<StickyActionBar>
  <Button variant="ax-secondary" size="ax">Bỏ sửa</Button>
  <Button variant="ax-primary" size="ax">Lưu thay đổi</Button>
</StickyActionBar>
```

## Quy tắc

- Mỗi màn **đúng một** `HeroCard`; còn lại dùng gradient nhạt (`ax-card`, `ax-grad-stat`, `ax-grad-soft`).
- Chữ trên khối nhấn trắng hoặc `--ax-on-hero-ink-2`; không tô gradient lên chữ; không gradient tím/loang nhiều màu,
  không glassmorphism, không viền trái màu.
- Tương phản chữ ≥ 4,5:1 đo trên điểm sáng/tối nhất của nền gradient; vùng chạm ≥ 44px trên điện thoại
  (nút `Button` tự lên 44px dưới 640px, `ax-icon` lên 44×44; chip, nút toast mở rộng bằng `::after`).
  Chip `selected` lấy sắc đỉnh gradient từ `--ax-chip-sheen` (bản tối không trộn trắng để chữ sáng giữ ≥ 4,5:1).
- Khách = avatar bo 30%; nhân viên = tròn.
- Hàng/danh sách: hover `--ax-hover`, chọn nền `--ax-primary-soft` + chữ `--ax-primary-ink`; vạch chia `--ax-divider`.
- Số tiền: đơn vị ₫ nhỏ 0.8em màu `--ax-ink-3`; thời gian tương đối kèm `title` giờ đầy đủ.

## Bẫy cho màn tính năng

- `Card` của shadcn bị một rule ngoài `@layer` ép bo 10px (`app-tokens.css`) — muốn bo 12 của «Ánh xanh» dùng `ax-card`.
- `[data-slot=button]:active` (globals.css) vẫn thu nhỏ 0.97 cho cả biến thể `ax-*` (thiết kế: lún 0.5px) — lệch nhỏ, cố ý giữ.
- Audit e2e «một nút chính mỗi màn» (`e2e/design/primary-cta.spec.ts`) đếm theo `background-color` = `bg-primary`;
  `ax-primary` là gradient nên KHÔNG được đếm — tự giữ quy tắc một nút chính mỗi vùng.
- `text-xs` của app là 14px (globals.css nâng tối thiểu); chữ 11–13px của thiết kế dùng `text-[12px]`/`text-[13px]` hoặc `ax-text-label`/`ax-text-group`.
- `size="ax-sm"` (36px) chỉ cho hàng dày đặc trên desktop; nút thường dùng `ax` (40), điện thoại tự lên 44.

## Chỗ lệch có chủ đích so với bảng thiết kế

- Chữ phụ trên khối nhấn 97% trắng (thiết kế 92%): 92% chỉ đạt 4,24:1 dưới quầng sáng góc phải trên.
- Chữ gợi ý ô nhập `#6B6F7B` (thiết kế `#8A8D96` = 3,3:1, dưới chuẩn 4,5:1).
- Chữ nút nguy hiểm lúc hover/nhấn `--ax-danger-ink` `#B0352F` (`#C2413B` trên `#FBEDEC` chỉ 4,48:1).
- **Chưa chốt** — chữ nhạt `--ax-ink-3`/`--muted-foreground` (#6B6F7B) đặt TRỰC TIẾP trên nền trang ở mép trên
  (khoảng 0–120px dưới thanh trên) chỉ ~3,8–4,3:1 vì quầng xanh; chữ chính/chữ phụ vẫn đạt. Trong thẻ thì không ảnh hưởng.
- Bản tối: thiết kế chỉ có bản sáng; khối `.dark` quy đổi tối thiểu về bảng màu tối sẵn có (khối nhấn và toast giữ nguyên).

## Màn «Công việc» — chi tiết một việc (`/kanban/<id>`)

- Trang riêng (link trực tiếp + điện thoại): `app/(dashboard)/kanban/[id]/`, giao diện ở `components/kanban/kanban-card-page.tsx`.
  Một bộ điều khiển dữ liệu, hai bố cục: desktop ≥1024px (khối nhấn + cột thuộc tính 360px) và điện thoại (danh sách Hạn/Người làm/Ưu tiên,
  khay đáy cho Hạn và Người làm, thanh «Hoàn thành việc» dính đáy). Hộp thoại ở `/kanban` giữ nguyên, thêm liên kết «Mở trang riêng».
- «Giai đoạn» của thiết kế = cột của bảng (số cột/tên theo bảng thật, chấm theo màu cột); «Hoàn thành việc» chuyển sang cột đánh dấu xong đầu tiên.
- Mọi thay đổi lưu ngay + toast Hoàn tác (`showUndoToast`) thay vì nút Lưu; riêng Mô tả có Lưu/Huỷ (soạn nhiều dòng, @ gắn thẻ).
- Giữ so với hộp thoại cũ: trường tuỳ biến, đính kèm, khách hàng (chọn/đổi), @mention, Markdown mô tả, xoá có Hoàn tác (người tạo/Quản trị).

## Màn Đăng đa kênh (`/social`)

- Tab dạng viên (khay `ax-sunken`, mục mở là thẻ trắng) thay tab gạch chân; giữ đủ 7 tab (Thống kê, Thư viện còn nguyên dù thiết kế chỉ vẽ 5).
- Soạn bài: desktop một màn (nội dung · kênh · khi nào đăng + cột xem trước dính bên phải + thanh hành động nổi dạng khối nhấn);
  điện thoại hai bước («Bài mới» → «Xem lại và đăng», cùng một DOM, ẩn/hiện bằng `max-lg:hidden`).
- Thanh hành động tự dựng bằng `ax-grad-hero` (không dùng `StickyActionBar`, vì thiết kế đặt nó là khối nhấn duy nhất của màn).

## Màn Khách hàng — chi tiết (`/contacts/<id>`)

- Desktop 3 cột (khối nhấn + giai đoạn + hẹn gọi lại | lịch sử + công việc | thông tin sửa tại chỗ), điện thoại một cột
  (chip giai đoạn, tóm tắt, khay «Bổ sung thông tin», thanh Gọi/Zalo dính đáy). Chỉ dựng MỘT bố cục theo `useMediaQuery("(min-width: 1024px)")`.
  Lưu tại chỗ qua `PATCH /contacts/:id` + `showUndoToast` (`_components/use-contact-patch.ts`); form đầy đủ cũ mở bằng «Chỉnh sửa đầy đủ» / «Sửa».

## Màn đã chuyển: Hoạt động AI (`/ai-actions`)

- Desktop (≥ 1024px): danh sách trái (`AiActionRow`) + chi tiết phải (`AiActionDetailPanel`, khối nhấn ở đầu chi tiết). Điện thoại: đầu trang là khối nhấn có bộ lọc, thẻ `AiActionCard`, bấm thẻ mở chi tiết toàn màn (`AiActionDetailScreen`, thanh đáy dính: Duyệt và thực hiện rồi Từ chối).
- Chọn bố cục bằng `matchMedia("(min-width: 1024px)")` (render đúng MỘT bố cục, không nhân đôi DOM).
- Nút Duyệt khi đổi cấu trúc cần gõ tên bảng dùng gradient đỏ 3 điểm của thiết kế (mobile2) đặt bằng `style`, vì `ax-danger` là nút viền trắng chữ đỏ.

## Màn Bảng tin (`/newsfeed`)

- Desktop ≥1024px: mục dọc bên trái (đếm số bài lấy từ danh sách «Tất cả») + cột bài 700px; thanh mời viết là `HeroCard`.
  Mobile: khối xanh dính đầu trang chứa tab mục, bài full-bleed, nút nổi «Viết bài» mở màn soạn/sửa toàn màn hình.
- Xoá bài: hỏi xác nhận (desktop) rồi ẩn bài và chờ 5 giây cho «Hoàn tác» mới gọi `DELETE /newsfeed/:id` (không đổi API;
  rời trang giữa lúc chờ thì xoá ngay). Mobile xoá thẳng từ khay đáy / màn sửa, chỉ có Hoàn tác.
- Lệch thiết kế: thời gian hiện tương đối («3 giờ trước») như code cũ; màn sửa mobile không có chọn mục vì API `PATCH` chỉ nhận nội dung.
