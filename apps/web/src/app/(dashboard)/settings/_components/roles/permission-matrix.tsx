'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { Grants, Scope } from '@trinity/rbac'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CatalogPermission, RbacCatalog } from './use-roles-api'

const DEFAULT_SCOPE: Scope = 'own'

interface Props {
  catalog: RbacCatalog
  value: Grants
  onChange: (next: Grants) => void
  /** Vai trò hệ thống / không đủ quyền sửa: hiện read-only. */
  readOnly?: boolean
  /** Quyền người đang sửa KHÔNG có (guardrail — BE vẫn chặn, UI chỉ báo trước). */
  disabledKeys?: ReadonlySet<string>
}

/** Ma trận quyền: nhóm collapsible, "Chọn cả nhóm", quyền scoped có Select phạm vi. */
export function PermissionMatrix({ catalog, value, onChange, readOnly = false, disabledKeys }: Props) {
  const byGroup = useMemo(() => {
    const m = new Map<string, CatalogPermission[]>()
    for (const g of catalog.groups) m.set(g, [])
    for (const p of catalog.permissions) m.get(p.group)?.push(p)
    return [...m.entries()].filter(([, list]) => list.length > 0)
  }, [catalog])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggleGroup = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g)
      else next.add(g)
      return next
    })

  function setPerm(p: CatalogPermission, on: boolean, scope?: Scope) {
    const next = { ...value }
    if (!on) delete next[p.key]
    else next[p.key] = p.scoped ? (scope ?? next[p.key] ?? DEFAULT_SCOPE) : true
    onChange(next)
  }

  function setGroup(list: CatalogPermission[], on: boolean) {
    const next = { ...value }
    for (const p of list) {
      if (disabledKeys?.has(p.key)) continue
      if (on) next[p.key] = p.scoped ? (typeof next[p.key] === 'string' ? next[p.key] : DEFAULT_SCOPE) : true
      else delete next[p.key]
    }
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {byGroup.map(([group, list]) => {
        const selectable = list.filter((p) => !disabledKeys?.has(p.key))
        const checked = list.filter((p) => value[p.key] !== undefined).length
        const allOn = selectable.length > 0 && selectable.every((p) => value[p.key] !== undefined)
        const open = !collapsed.has(group)
        return (
          <section key={group} className="rounded-[var(--radius)] border bg-white">
            <header className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                className="flex flex-1 items-center gap-2 text-left text-sm font-semibold max-sm:min-h-11"
                onClick={() => toggleGroup(group)}
                aria-expanded={open}
              >
                {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                {group}
                <span className="text-xs font-normal text-muted-foreground">
                  {checked}/{list.length}
                </span>
              </button>
              {!readOnly && (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground max-sm:min-h-11">
                  <Checkbox
                    checked={allOn}
                    disabled={selectable.length === 0}
                    onCheckedChange={(on) => setGroup(list, on)}
                    aria-label={`Chọn cả nhóm ${group}`}
                  />
                  Chọn cả nhóm
                </label>
              )}
            </header>
            {open && (
              <ul className="divide-y border-t">
                {list.map((p) => (
                  <PermissionRow
                    key={p.key}
                    perm={p}
                    grant={value[p.key]}
                    scopes={catalog.scopes}
                    readOnly={readOnly}
                    disabled={!!disabledKeys?.has(p.key)}
                    onToggle={(on) => setPerm(p, on)}
                    onScope={(s) => setPerm(p, true, s)}
                  />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

interface RowProps {
  perm: CatalogPermission
  grant: Grants[keyof Grants]
  scopes: RbacCatalog['scopes']
  readOnly: boolean
  disabled: boolean
  onToggle: (on: boolean) => void
  onScope: (s: Scope) => void
}

function PermissionRow({ perm, grant, scopes, readOnly, disabled, onToggle, onScope }: RowProps) {
  const on = grant !== undefined
  const scope = typeof grant === 'string' ? grant : DEFAULT_SCOPE
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm max-sm:min-h-11">
        <Checkbox
          checked={on}
          disabled={readOnly || disabled}
          onCheckedChange={onToggle}
          aria-label={perm.label}
        />
        <span className="truncate max-sm:whitespace-normal">{perm.label}</span>
        {perm.sensitive && (
          <Badge variant="secondary" className="bg-amber-50 text-amber-800">
            Nhạy cảm
          </Badge>
        )}
        {disabled && !readOnly && <span className="text-xs text-muted-foreground">(bạn không có quyền này)</span>}
      </label>
      {perm.scoped && on && (
        <Select value={scope} onValueChange={(v) => onScope(v as Scope)} disabled={readOnly || disabled}>
          <SelectTrigger className="h-9 w-[200px] max-sm:h-11 max-sm:w-full" aria-label={`Phạm vi: ${perm.label}`}>
            <SelectValue placeholder="Chọn phạm vi">
              {(v) => scopes.find((s) => s.value === v)?.label ?? <span className="text-muted-foreground">Chọn phạm vi</span>}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {scopes.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </li>
  )
}
