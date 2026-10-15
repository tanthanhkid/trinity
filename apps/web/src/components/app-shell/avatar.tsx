import { cn } from "@/lib/utils"

/* =============================================================================
 * Ảnh đại diện chữ-cái với 6 gradient.
 *
 * Nền màu theo DỮ LIỆU (tên khách quyết định dải màu) nên không có màu chữ nào
 * cứu được các dải sáng: 6 gradient dùng bậc ĐẬM để chữ trắng đạt AA ở CẢ HAI
 * chặng (số đo ở `styles/app-tokens.css`).
 *
 * Dải màu chọn theo HÀM BĂM của tên, KHÔNG theo chỉ số dòng: cùng một khách thì
 * cùng một màu ở mọi màn (bảng, Kanban, chi tiết) và không đổi màu khi sắp xếp
 * hay phân trang lại.
 * ========================================================================== */

const GRADIENTS = [
  "from-[var(--color-app-ava-1-a)] to-[var(--color-app-ava-1-b)]",
  "from-[var(--color-app-ava-2-a)] to-[var(--color-app-ava-2-b)]",
  "from-[var(--color-app-ava-3-a)] to-[var(--color-app-ava-3-b)]",
  "from-[var(--color-app-ava-4-a)] to-[var(--color-app-ava-4-b)]",
  "from-[var(--color-app-ava-5-a)] to-[var(--color-app-ava-5-b)]",
  "from-[var(--color-app-ava-6-a)] to-[var(--color-app-ava-6-b)]",
] as const

const SIZE = {
  xs: "size-7 rounded-md text-sm",
  sm: "size-[26px] rounded-[10px] text-xs",
  md: "size-[30px] rounded-[10px] text-xs",
  lg: "size-10 rounded-[11px] text-sm",
} as const

/**
 * 2 chữ đầu của 2 từ đầu tiên (tiếng Việt đọc theo họ + tên), 1 chữ nếu chỉ có
 * 1 từ, `?` nếu rỗng. Dùng `[...str]` (iterator theo CODE POINT) chứ không
 * `charAt` — chữ có dấu tổ hợp sẽ bị cắt mất dấu nếu lấy theo đơn vị UTF-16.
 */
export function shellInitials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  const first = [...words[0]][0] ?? ""
  if (words.length === 1) return first.toUpperCase()
  const second = [...words[words.length - 1]][0] ?? ""
  return (first + second).toUpperCase()
}

/** Băm ổn định (djb2 rút gọn) → chỉ số dải màu. Cùng tên ⇒ cùng màu ở mọi màn. */
function hashIndex(seed: string, buckets: number): number {
  let h = 5381
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0
  return Math.abs(h) % buckets
}

export function ShellAvatar({
  name,
  size = "xs",
  className,
}: {
  name: string | null | undefined
  size?: keyof typeof SIZE
  className?: string
}) {
  const label = shellInitials(name)
  const grad = GRADIENTS[hashIndex(name?.trim() || "?", GRADIENTS.length)]
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center bg-gradient-to-br font-bold text-[var(--color-app-ava-ink)]",
        grad,
        SIZE[size],
        className,
      )}
    >
      {label}
    </span>
  )
}
