import { formatScalar } from "@/lib/custom-objects/format-value"
import { cn } from "@/lib/utils"
import type { CustomFieldDef } from "@/types/custom-objects"

const CHIP = "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
const TONE = {
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  gray: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  neutral: "bg-muted text-foreground",
} as const

function Chip({ tone, strong, children }: { tone: keyof typeof TONE; strong?: boolean; children: React.ReactNode }) {
  return <span className={cn(CHIP, TONE[tone], strong && "font-semibold")}>{children}</span>
}

/**
 * Trình bày giá trị SCALAR bằng chip/chữ nhất quán (chỉ đổi giao diện — nội dung chữ vẫn do `formatScalar` quyết định,
 * null → "—" xử lý TRƯỚC ở `CustomFieldValue`). SĐT: chỉ font số, KHÔNG che/đổi (BE đã che theo quyền).
 */
export function CustomScalarValue({ field, value }: { field: CustomFieldDef; value: unknown }) {
  const text = formatScalar(field, value)
  if (text === "—") return <span className="text-muted-foreground">—</span>
  switch (field.type) {
    case "percent":
      return <Chip tone={value === 0 ? "gray" : "amber"}>{text}</Chip>
    case "currency":
      return <Chip tone="green" strong>{text}</Chip>
    case "formula": {
      const fmt = field.options.format ?? "number"
      if (fmt === "currency") return <Chip tone="green" strong>{text}</Chip>
      if (fmt === "percent") return <Chip tone={value === 0 ? "gray" : "amber"}>{text}</Chip>
      return <Chip tone="neutral">{text}</Chip>
    }
    case "number":
      return <Chip tone="neutral">{text}</Chip>
    case "boolean":
      return <Chip tone={value === true ? "green" : "gray"}>{text}</Chip>
    case "date": case "datetime":
      return <span className="tabular-nums text-muted-foreground">{text}</span>
    case "phone":
      return <span className="tabular-nums">{text}</span>
    default:
      return <span className="break-words">{text}</span>
  }
}
