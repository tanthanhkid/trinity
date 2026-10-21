import { cva, type VariantProps } from "class-variance-authority"
import { DS_V2_ENABLED } from "@/lib/design-system-flags"

// Hình dạng nút theo cờ design system: bật → pill (rounded-full) cho mọi size,
// tắt (mặc định) → rounded-lg.
const BUTTON_BASE_SHAPE = DS_V2_ENABLED ? "rounded-full" : "rounded-lg"

export const buttonVariants = cva(
  `group/button inline-flex shrink-0 items-center justify-center ${BUTTON_BASE_SHAPE} border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
  {
    variants: {
      variant: {
        // shadow-brand-glow LUÔN gắn class (KHÔNG rẽ nhánh theo cờ) — token
        // --shadow-brand-glow = "none" khi cờ ds-v2 tắt (globals.css) nên
        // legacy mode không có tác dụng hình ảnh gì.
        default: "bg-primary text-primary-foreground shadow-brand-glow [a]:hover:bg-primary/80",
        // viền cũ `border-border` (--border, #e9eef6) + nền
        // `bg-background` (--background, #f4f9fc) chỉ 1,10:1 trên nền trang
        // và 1,17:1 trên thẻ trắng — nút "outline" tan vào nền. Dùng
        // `border-input` (--input, #7d8ba0 — cùng token với ô nhập)
        // + `bg-card` (--card, #ffffff) → 3,26:1 trên nền
        // trang / 3,46:1 trên trắng (đạt chuẩn ĐỒ HOẠ 1.4.11). Hover GIỮ
        // NGUYÊN `hover:bg-muted` — không đổi hành vi hover, chỉ đổi màu nghỉ.
        outline:
          "border-input bg-card shadow-[var(--shadow-field)] hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
        // tông NHẠT cho trạng thái ĐANG CHỌN (chip lọc, segmented,
        // tab pill, trang hiện tại) — chọn ≠ hành động nên KHÔNG dùng nền đặc
        // `bg-primary` (dành riêng cho 1 hành động chính mỗi vùng). Chữ dùng
        // `--color-app-primary-ink` (#1e40af): `text-primary` #2563eb trên
        // nền primary/10 chỉ 4,49:1 (<4,5), ink đạt ~7:1.
        soft: "bg-primary/10 text-[var(--color-app-primary-ink)] hover:bg-primary/15 aria-pressed:bg-primary/15 aria-expanded:bg-primary/15 data-[active=true]:bg-primary/15 dark:bg-primary/20 dark:hover:bg-primary/25",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        // xs/sm/icon-xs/icon-sm khôi phục override radius riêng
        // (rounded-[min(var(--radius-md),Npx)]) khi cờ ds-v2 TẮT — size nhỏ hơn
        // thì bo nhỏ hơn. Khi cờ bật kế thừa rounded-full từ base, không override.
        xs: DS_V2_ENABLED
          ? "h-6 gap-1 px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3"
          : "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: DS_V2_ENABLED
          ? "h-7 gap-1 px-2.5 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5"
          : "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-9",
        "icon-xs": DS_V2_ENABLED
          ? "size-6 in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3"
          : "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": DS_V2_ENABLED
          ? "size-7 in-data-[slot=button-group]:rounded-lg"
          : "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export type ButtonVariantsProps = VariantProps<typeof buttonVariants>
