"use client"

import { Input } from "@/components/ui/input"
import { OptionSelect } from "./option-select"
import type { TargetField } from "./google-sheets-types"

/**
 * Ánh xạ trường CRM ↔ cột Sheet. Có `headers` (đã đọc Sheet) ⇒ chọn từ danh sách; chưa có (xuất ra Sheet mới)
 * ⇒ gõ tên cột sẽ tạo ở dòng tiêu đề.
 */
export function GoogleColumnMapper({
  fields,
  headers,
  value,
  onChange,
}: {
  fields: TargetField[]
  headers: string[] | null
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  const set = (key: string, col: string) => {
    const next = { ...value }
    if (col) next[key] = col
    else delete next[key]
    onChange(next)
  }
  return (
    <div className="space-y-2" role="group" aria-label="Ánh xạ cột">
      {fields.map((f) => (
        <div key={f.key} className="grid grid-cols-[1fr_1fr] items-center gap-2 max-sm:grid-cols-1">
          <span className="text-sm">
            {f.label}
            {f.required && <span className="ml-1 text-red-600">*</span>}
          </span>
          {headers ? (
            <OptionSelect
              label={`Cột cho ${f.label}`}
              value={value[f.key] ?? ""}
              options={[{ value: "", label: "— Không ánh xạ —" }, ...headers.map((h) => ({ value: h, label: h }))]}
              onChange={(v) => set(f.key, v)}
              placeholder="— Không ánh xạ —"
              className="h-9 w-full max-sm:h-11"
            />
          ) : (
            <Input aria-label={`Tên cột cho ${f.label}`} className="max-sm:h-11" placeholder="Để trống = không xuất" value={value[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />
          )}
        </div>
      ))}
    </div>
  )
}
