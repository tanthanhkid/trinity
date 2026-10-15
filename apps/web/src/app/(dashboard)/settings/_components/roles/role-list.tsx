'use client'

import { Copy, Shield, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { RoleSummary } from './use-roles-api'

interface Props {
  roles: RoleSummary[]
  selectedId: number | null
  isLoading: boolean
  onSelect: (id: number) => void
  onClone: (role: RoleSummary) => void
  onDelete: (role: RoleSummary) => void
}

/** Cột trái: danh sách vai trò + chip "Hệ thống" + số người giữ. */
export function RoleList({ roles, selectedId, isLoading, onSelect, onClone, onDelete }: Props) {
  const selected = roles.find((r) => r.id === selectedId) ?? null
  return (
    <aside className="flex flex-col gap-3 rounded-[var(--radius)] border bg-white p-3 shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
      {isLoading && <p className="px-2 py-4 text-center text-sm text-muted-foreground">Đang tải...</p>}
      <ul className="space-y-1" aria-label="Danh sách vai trò">
        {roles.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r.id)}
              aria-current={r.id === selectedId ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-xl px-3 py-2 max-sm:min-h-11 text-left text-sm transition-colors hover:bg-muted',
                r.id === selectedId && 'bg-[var(--color-app-primary-soft)] font-medium',
              )}
            >
              <Shield className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              {r.is_system && (
                <Badge variant="secondary" className="bg-purple-50 text-purple-700">
                  Hệ thống
                </Badge>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">{r.member_count} người</span>
            </button>
          </li>
        ))}
        {!isLoading && roles.length === 0 && (
          <li className="px-2 py-4 text-center text-sm text-muted-foreground">Chưa có vai trò</li>
        )}
      </ul>
      {selected && (
        <div className="flex gap-2 border-t pt-3 max-sm:hidden">
          <Button variant="outline" size="sm" className="h-9 flex-1" onClick={() => onClone(selected)}>
            <Copy className="mr-1.5 h-4 w-4" /> Nhân bản
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-9 flex-1"
            disabled={selected.is_system}
            title={selected.is_system ? 'Không thể xoá vai trò hệ thống' : undefined}
            onClick={() => onDelete(selected)}
          >
            <Trash2 className="mr-1.5 h-4 w-4" /> Xoá
          </Button>
        </div>
      )}
    </aside>
  )
}
