"use client"

import { useMemo, useState } from "react"
import { ShellCheckbox as Checkbox } from "@/components/app-shell/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface PickerOption {
  id: number
  label: string
  sublabel?: string
}

/**
 * Danh sách checkbox có ô tìm kiếm — dùng chung cho 3 nhóm Phòng/Team/Nhân
 * viên ở `settings-login-wifi-check-targets.tsx`. Roster đã
 * fetch 1 lần ở component cha (số lượng nhân viên có giới hạn) —
 * lọc HOÀN TOÀN client-side, KHÔNG gọi API mỗi lần gõ.
 */
export function LoginWifiCheckTargetPicker({
  title,
  options,
  selectedIds,
  onToggle,
  searchable = false,
  emptyLabel = "Không có lựa chọn nào",
}: {
  title: string
  options: PickerOption[]
  selectedIds: Set<number>
  onToggle: (id: number) => void
  searchable?: boolean
  emptyLabel?: string
}) {
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.sublabel?.toLowerCase().includes(q),
    )
  }, [options, search])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{title}</p>
        {selectedIds.size > 0 && (
          <span className="text-xs text-muted-foreground">Đã chọn {selectedIds.size}</span>
        )}
      </div>
      {searchable && (
        <Input
          placeholder="Tìm theo tên/email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 max-sm:h-11"
        />
      )}
      <div className="max-h-56 overflow-y-auto rounded-lg border p-2">
        {options.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">{emptyLabel}</p>
        ) : filtered.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">Không khớp tìm kiếm</p>
        ) : (
          filtered.map((o) => (
            <div key={o.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/50 max-sm:min-h-11">
              <Checkbox
                id={`lwct-${title}-${o.id}`}
                checked={selectedIds.has(o.id)}
                onCheckedChange={() => onToggle(o.id)}
              />
              <Label
                htmlFor={`lwct-${title}-${o.id}`}
                className="cursor-pointer text-sm font-normal leading-tight max-sm:flex-1 max-sm:self-stretch max-sm:py-2.5"
              >
                {o.label}
                {o.sublabel && (
                  <span className="ml-1.5 text-xs text-muted-foreground">({o.sublabel})</span>
                )}
              </Label>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
