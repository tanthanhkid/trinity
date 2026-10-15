"use client"

import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CHOICE_COLORS, CHOICE_COLOR_CLASS } from "@/lib/custom-objects/field-meta"
import { cn } from "@/lib/utils"
import type { SelectChoice } from "@/types/custom-objects"

/**
 * Soạn danh sách lựa chọn của trường “Chọn một / Chọn nhiều”. Mã (`value`) của lựa chọn ĐÃ CÓ khoá cố định (để dữ liệu
 * cũ vẫn khớp khi đổi tên hiển thị); lựa chọn mới để trống mã → BE tự sinh từ tên.
 */
export function ChoicesEditor({ value, onChange, lockedValues }: { value: SelectChoice[]; onChange: (v: SelectChoice[]) => void; lockedValues: ReadonlySet<string> }) {
  const set = (i: number, patch: Partial<SelectChoice>) => onChange(value.map((c, k) => (k === i ? { ...c, ...patch } : c)))
  return (
    <div className="space-y-2">
      {value.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input value={c.label} maxLength={100} placeholder={`Lựa chọn ${i + 1}`} aria-label={`Tên lựa chọn ${i + 1}`} onChange={(e) => set(i, { label: e.target.value })} />
          <div className="flex shrink-0 gap-2" role="group" aria-label="Màu">
            {CHOICE_COLORS.slice(0, 5).map((col) => (
              <button key={col} type="button" aria-label={`Màu ${col}`} aria-pressed={c.color === col}
                className={cn("relative size-6 rounded-full border after:absolute after:-inset-2 after:content-['']", CHOICE_COLOR_CLASS[col], c.color === col && "ring-2 ring-ring")}
                onClick={() => set(i, { color: c.color === col ? undefined : col })} />
            ))}
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label={`Xoá lựa chọn ${i + 1}`} onClick={() => onChange(value.filter((_, k) => k !== i))}
            title={lockedValues.has(c.value) ? "Nếu đang có bản ghi dùng lựa chọn này, hệ thống sẽ không cho xoá" : undefined}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, { value: "", label: "" }])}>
        <Plus className="mr-1 size-3.5" /> Thêm lựa chọn
      </Button>
    </div>
  )
}
