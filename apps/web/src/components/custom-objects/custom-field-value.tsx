import Link from "next/link"
import { CHOICE_COLOR_CLASS, resolveChoiceColor } from "@/lib/custom-objects/field-meta"
import { CustomScalarValue } from "./custom-scalar-chip"
import { cn } from "@/lib/utils"
import { MentionText } from "@/components/refs/mention-text"
import { RefChip } from "@/components/refs/ref-chip"
import type { CustomFieldDef, CustomRecord, CustomRelationLabel, SelectChoice } from "@/types/custom-objects"

function ChoiceBadge({ choices, raw }: { choices?: readonly SelectChoice[]; raw: string }) {
  const cls = CHOICE_COLOR_CLASS[resolveChoiceColor(choices, raw)]
  const label = choices?.find((c) => c.value === raw)?.label ?? raw
  return <span className={cn("inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium", cls)}>{label}</span>
}

function RelationLink({ field, rel }: { field: CustomFieldDef; rel: CustomRelationLabel }) {
  if (!rel.accessible || rel.title === null) {
    return <span className="text-muted-foreground" title="Đã xoá hoặc ngoài phạm vi của bạn">Không xem được</span>
  }
  const href = field.type === "user" ? null
    : field.options.target === "contact" ? `/contacts/${rel.id}`
    : field.options.target_key ? `/x/${field.options.target_key}/${rel.id}` : null
  return href
    ? <Link href={href} onClick={(e) => e.stopPropagation()} className="text-primary underline-offset-2 hover:underline">{rel.title}</Link>
    : <span>{rel.title}</span>
}

/**
 * Hiển thị 1 giá trị trường (danh sách + chi tiết). Null/thiếu → "—". SĐT đã được BE che theo quyền —
 * FE không tự che. Liên kết chỉ có tên khi BE xác nhận trong phạm vi; còn lại hiện "Không xem được".
 */
export function CustomFieldValue({ field, record }: { field: CustomFieldDef; record: Pick<CustomRecord, "data" | "relations"> }) {
  const v = record.data[field.key]
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return <span className="text-muted-foreground">—</span>
  switch (field.type) {
    case "select": {
      const raw = String(v)
      return <ChoiceBadge raw={raw} choices={field.options.choices} />
    }
    case "multi_select":
      return (
        <span className="flex flex-wrap gap-1">
          {(Array.isArray(v) ? v : []).map((x) => (
            <ChoiceBadge key={String(x)} raw={String(x)} choices={field.options.choices} />
          ))}
        </span>
      )
    case "relation": case "user": {
      const rel = record.relations[field.key]
      const list = Array.isArray(rel) ? rel : rel ? [rel] : []
      if (list.length === 0) return <span className="text-muted-foreground">—</span>
      return (
        <span className="flex flex-wrap gap-x-2 gap-y-0.5">
          {list.map((r, i) => (
            <span key={r.id}><RelationLink field={field} rel={r} />{i < list.length - 1 ? "," : ""}</span>
          ))}
        </span>
      )
    }
    case "url": {
      // BE chỉ lưu http(s); FE phòng thủ thêm: giá trị lạ (dữ liệu cũ/nhập từ nơi khác) không bao giờ thành href `javascript:`.
      const href = String(v)
      return /^https?:\/\//i.test(href)
        ? <a href={href} target="_blank" rel="noreferrer noopener" className="break-all text-primary underline-offset-2 hover:underline">{href}</a>
        : <span className="break-all">{href}</span>
    }
    case "email":
      return <a href={`mailto:${String(v)}`} className="break-all text-primary underline-offset-2 hover:underline">{String(v)}</a>
    case "long_text":
      return <MentionText text={String(v)} />
    case "link": {
      const rel = record.relations[field.key]
      const list = Array.isArray(rel) ? rel : rel ? [rel] : []
      return (
        <span className="flex flex-wrap gap-1">
          {list.map((r) => (
            <RefChip key={`${r.type}:${r.id}`} view={r.accessible && r.title !== null && r.type ? { type: r.type, id: r.id, ref: `${r.type}:${r.id}`, code: r.code ?? null, title: r.title, table: r.table ?? "", href: r.href ?? null } : null} />
          ))}
        </span>
      )
    }
    default:
      return <CustomScalarValue field={field} value={v} />
  }
}
