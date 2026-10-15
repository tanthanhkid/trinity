"use client"

import { ArrowDown, ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * thay tiêu đề cột bấm-để-sắp-xếp (không có trên danh sách thẻ)
 * bằng một dòng "Sắp xếp theo [cột] [↑/↓]". CHỈ hiện ở điện thoại (<640px).
 */
export function MobileSortBar<K extends string>({
  options,
  value,
  dir,
  onKeyChange,
  onDirToggle,
}: {
  options: { key: K; label: string }[]
  value: K
  dir: "asc" | "desc"
  onKeyChange: (key: K) => void
  onDirToggle: () => void
}) {
  return (
    <div className="flex items-center gap-2 sm:hidden">
      <Select value={value} onValueChange={(v) => v && onKeyChange(v as K)}>
        <SelectTrigger aria-label="Sắp xếp theo" className="flex-1">
          <SelectValue>
            {(v) => `Sắp xếp: ${options.find((o) => o.key === v)?.label ?? "—"}`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.key} value={o.key}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={dir === "asc" ? "Đang tăng dần, bấm để giảm dần" : "Đang giảm dần, bấm để tăng dần"}
        onClick={onDirToggle}
      >
        {dir === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
      </Button>
    </div>
  )
}
