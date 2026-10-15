"use client"

import { cva, type VariantProps } from "class-variance-authority"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cn } from "@/lib/utils"

/* =============================================================================
 * Nút của giao diện v2.
 *
 * 🔴 Vì sao KHÔNG sửa `components/ui/button-variants.ts`: file đó DÙNG CHUNG với
 * v1, đổi là đổi diện mạo v1 — trái bất biến "merge v2 không ảnh hưởng v1".
 *
 * 🔴 Vì sao KHÔNG chỉ thêm `className` ở từng chỗ gọi: đó là cách làm nửa vời:
 * có hàng trăm chỗ gọi `<Button>` trong v2; mỗi chỗ tự
 * ghi một cặp `bg-…` + `hover:bg-…` riêng nên diện mạo lệch nhau, và chỗ nào
 * quên `hover:` thì rơi về hover ALPHA của variant dùng chung (xem dưới).
 *
 * 🔴 Hover ĐẶC, không alpha. `button-variants.ts` đặt `bg-primary/80`: alpha pha
 * với thứ nằm SAU nút nên nền lúc hover không nằm trong bảng token — nút chính
 * 4,53:1 với chữ trắng lúc nghỉ, hover tụt xuống ~3,3:1. Mọi trạng thái ở đây
 * dùng token đặc và đã ĐO (số ghi trong `app-tokens.css`):
 *
 *   primary   trắng/primary 4,53 → hover trắng/primary-deep 5,51
 *   outline   ink-2/trắng 7,39   → hover blue/trắng 5,11
 *   ghost     ink-2/trắng 7,39   → hover blue/surface-2 4,79
 *   soft      primary-ink/primary-soft 5,65 → hover 5,18
 *   danger    trắng/red-deep 5,26 → hover trắng/red-deep-hover 6,59
 *   danger-soft  #b13442/red-soft 5,21 → hover 4,54
 *   azure     trắng/blue 5,11    → hover trắng/blue-deep 7,18
 *
 * Nút primary dùng bậc ĐẶC đã hạ sáng (`--color-app-primary`) thay vì gradient,
 * vì chặng sáng của gradient chỉ ~2,3:1 với chữ trắng (xem đầu `app-tokens.css`).
 *
 * `shellButtonClass()` là bản HÀM cho `<Link>`: Base-UI Button KHÔNG có `asChild`
 * nên nút-là-link phải tự ghép class, KHÔNG bọc `<Button>` quanh
 * `<Link>`.
 * ========================================================================== */

export const shellButtonClass = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-[7px] whitespace-nowrap",
    "border border-transparent font-semibold outline-none select-none",
    "transition-[background-color,border-color,color,box-shadow] duration-150",
    "active:translate-y-px",
    "focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1",
    "disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none",
    "aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-app-primary)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.25),0_4px_12px_rgba(9,133,119,.28)] hover:bg-[var(--color-app-primary-deep)]",
        azure:
          "bg-[var(--color-app-blue)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.22),0_4px_12px_rgba(15,110,203,.26)] hover:bg-[var(--color-app-blue-deep)]",
        outline:
          "border-[var(--color-app-line)] bg-[var(--card)] text-[var(--color-app-ink-2)] shadow-[var(--shadow-card)] hover:border-[var(--color-app-blue)] hover:text-[var(--color-app-blue)]",
        ghost:
          "bg-transparent text-[var(--color-app-ink-2)] hover:bg-[var(--color-app-surface-2)] hover:text-[var(--color-app-blue)]",
        soft:
          "bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)] hover:bg-[var(--color-app-primary-soft-hover)]",
        danger:
          "bg-[var(--color-app-red-deep)] text-white hover:bg-[var(--color-app-red-deep-hover)]",
        "danger-soft":
          "bg-[var(--color-app-red-soft)] text-[var(--color-app-tag-red-ink)] hover:bg-[var(--color-app-red-soft-hover)]",
        link: "h-auto bg-transparent p-0 text-[var(--color-app-blue)] underline-offset-4 hover:underline",
      },
      size: {
        /** `.btn` — 38px, radius-sm 10px, chữ 14px (tối thiểu của giao diện mới). */
        md: "h-[38px] rounded-[10px] px-3 text-sm [&_svg]:size-3.5",
        /** `.btn-sm` — 33px, radius-xs 8px, 12px chữ. */
        sm: "h-[33px] rounded-lg px-2.5 text-xs [&_svg]:size-3",
        /** `.btn-lg` — 44px, radius 14px, 14px chữ. */
        lg: "h-11 rounded-[14px] px-[18px] text-sm [&_svg]:size-4",
        /** `.btn-icon` — vuông 37px. */
        icon: "size-[37px] rounded-[10px] p-0 [&_svg]:size-3.5",
        /** `.btn-icon.btn-sm` — vuông 31px. */
        "icon-sm": "size-[31px] rounded-lg p-0 [&_svg]:size-3",
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "primary", size: "md", block: false },
  },
)

export type ShellButtonVariants = VariantProps<typeof shellButtonClass>

export function ShellButton({
  className,
  variant,
  size,
  block,
  ...props
}: ButtonPrimitive.Props & ShellButtonVariants) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-v2-btn={variant ?? "primary"}
      className={cn(shellButtonClass({ variant, size, block }), className)}
      {...props}
    />
  )
}

/**
 * Cụm nút dính nhau (`.btn-group`): bo góc chỉ ở 2 đầu,
 * viền chồng 1px, nút đang chọn mang `.on` (nền `blue-soft`, chữ `blue`).
 *
 * Dùng cho cặp Kanban|Danh sách ở màn danh sách khách. Trước đây cặp đó là 2 `<Button>`
 * rời trong 1 `div` có `border` + `p-0.5` — nhìn ra 2 nút lồng trong khung, không
 * phải 1 cụm.
 */
export function ShellButtonGroup({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "inline-flex [&>*]:rounded-none [&>*]:border-[var(--color-app-line)] [&>*]:shadow-none",
        "[&>*:first-child]:rounded-l-lg [&>*:last-child]:rounded-r-lg [&>*+*]:-ml-px",
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * Trạng thái ĐANG CHỌN trong `ShellButtonGroup` — `.btn-group .btn.on` của theme.
 *
 * 🔴 Chữ dùng `--color-app-blue-deep`, KHÔNG phải `--color-app-blue` như theme:
 * đo lại cặp theme khai (`#0f6ecb` trên `#e3eefb`) chỉ **4,35:1** — dưới AA, và
 * nó nằm ngoài bảng cặp của `contrast.test.ts` nên không ai thấy. Bậc deep
 * `#0a57a6` trên cùng nền = **6,11:1** (đúng cặp `--accent-foreground`/`--accent`
 * mà theme đã dùng ở chỗ khác). Cặp mới đã thêm vào test.
 */
export const SHELL_BUTTON_GROUP_ON =
  "relative z-[1] border-[var(--color-app-blue)] bg-[var(--color-app-blue-soft)] text-[var(--color-app-blue-deep)] hover:bg-[var(--color-app-blue-soft)] hover:text-[var(--color-app-blue-deep)]"
