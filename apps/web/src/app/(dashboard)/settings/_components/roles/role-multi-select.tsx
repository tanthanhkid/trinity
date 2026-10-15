'use client'

import { Checkbox } from '@/components/ui/checkbox'
import type { RoleSummary } from './use-roles-api'

interface Props {
  roles: RoleSummary[]
  value: number[]
  onChange: (ids: number[]) => void
  /** Vai trò hệ thống chỉ Quản trị gán được (BE chặn — UI báo trước). */
  canGrantSystem: boolean
  loading?: boolean
  disabled?: boolean
}

/**
 * Chọn NHIỀU vai trò — danh sách checkbox INLINE (không portal, nằm trong
 * Dialog). Vai trò cộng dồn quyền.
 */
export function RoleMultiSelect({ roles, value, onChange, canGrantSystem, loading, disabled }: Props) {
  function toggle(id: number, on: boolean) {
    onChange(on ? [...value, id] : value.filter((x) => x !== id))
  }
  if (loading) return <p className="text-sm text-muted-foreground">Đang tải vai trò...</p>
  if (roles.length === 0) return <p className="text-sm text-muted-foreground">Chưa có vai trò nào</p>
  return (
    <ul className="max-h-48 max-sm:max-h-[40dvh] space-y-1 overflow-y-auto rounded-lg border p-2" aria-label="Chọn vai trò">
      {roles.map((r) => {
        const locked = disabled || (r.is_system && !canGrantSystem && !value.includes(r.id))
        return (
          <li key={r.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm max-sm:min-h-11 hover:bg-muted">
              <Checkbox
                checked={value.includes(r.id)}
                disabled={locked}
                onCheckedChange={(on) => toggle(r.id, on)}
                aria-label={r.name}
              />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              {r.is_system && <span className="text-xs text-purple-700">Hệ thống</span>}
            </label>
          </li>
        )
      })}
    </ul>
  )
}
