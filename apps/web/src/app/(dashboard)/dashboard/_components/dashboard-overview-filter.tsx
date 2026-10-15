'use client'

import { Building2, RotateCcw, UserRound, Users } from 'lucide-react'
import type { ElementType } from 'react'
import { Button } from '@/components/ui/button'
import { MobileFilterSheet } from '@/components/app-shell/mobile-filter-sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  applyFilterChange,
  describeFilter,
  isFilterActive,
  saleOptions,
  teamOptions,
  type DashboardFilterRoster,
  type DashboardFilterValue,
  type RosterItem,
} from './dashboard-filter-utils'

const ALL = 'all'

function FilterSelect({
  label,
  icon: Icon,
  value,
  options,
  onChange,
}: {
  label: string
  icon: ElementType
  value: number | null
  options: RosterItem[]
  onChange: (id: number | null) => void
}) {
  const selectedName = value === null ? null : options.find((o) => o.id === value)?.full_name
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-[14px] text-[var(--color-app-ink-2)]">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        {label}
      </span>
      <Select value={value === null ? ALL : String(value)} onValueChange={(v) => onChange(!v || v === ALL ? null : Number(v))}>
        <SelectTrigger aria-label={label} title={selectedName ?? undefined} className="h-9 w-full rounded-lg text-[14px] sm:w-36">
          <SelectValue placeholder="Tất cả">
            {(v) => {
              if (typeof v !== 'string' || v === ALL || !v) return 'Tất cả'
              const found = options.find((o) => String(o.id) === v)
              return found ? found.full_name : 'Tất cả'
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Tất cả</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={String(o.id)}>{o.full_name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * Bộ lọc Tổng quan — chỉ render cho role phạm vi rộng (gate ở caller).
 * Nguồn dropdown = cây `manager_id` (cùng nguồn BE lọc); Phòng → Team → NV lọc phụ thuộc.
 */
export function DashboardOverviewFilter({
  roster,
  value,
  onChange,
  selfId,
  showFilter = true,
}: {
  /** `false` = ẩn các ô chọn (Trang chủ chỉ dựng bộ lọc cho role có quyền lọc nên thường là `true`). Ngày + nút Trung tâm báo cáo đã lên hàng lời chào. */
  showFilter?: boolean
  roster: DashboardFilterRoster | undefined
  value: DashboardFilterValue
  onChange: (next: DashboardFilterValue) => void
  selfId: number | null
}) {
  const active = isFilterActive(value)
  const change = (patch: Partial<DashboardFilterValue>) => onChange(applyFilterChange(roster, value, patch))
  const isSelf = selfId !== null && value.userId === selfId && value.deptHeadId === null && value.teamLeadId === null
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-3 py-2 shadow-[var(--shadow-card)]" data-testid="dashboard-scope-filter">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
        {showFilter && (
        <MobileFilterSheet
          activeCount={[value.deptHeadId, value.teamLeadId, value.userId].filter((v) => v !== null).length}
          onReset={() => onChange({ deptHeadId: null, teamLeadId: null, userId: null })}
        >
        <FilterSelect icon={Building2} label="Phòng KD" value={value.deptHeadId} options={roster?.dept_heads ?? []} onChange={(id) => change({ deptHeadId: id })} />
        <FilterSelect icon={Users} label="Team" value={value.teamLeadId} options={teamOptions(roster, value)} onChange={(id) => change({ teamLeadId: id })} />
        <FilterSelect icon={UserRound} label="Nhân viên" value={isSelf ? null : value.userId} options={saleOptions(roster, value)} onChange={(id) => change({ userId: id })} />
        {selfId !== null && (
          <Button
            type="button"
            size="sm"
            variant={isSelf ? 'soft' : 'outline'}
            aria-pressed={isSelf}
            className="h-9 gap-1 rounded-lg text-[14px]"
            onClick={() => onChange(isSelf ? { ...value, userId: null } : { deptHeadId: null, teamLeadId: null, userId: selfId })}
          >
            <UserRound className="size-4" aria-hidden /> Chính tôi
          </Button>
        )}
        {active && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-9 gap-1 rounded-lg text-[14px] max-sm:hidden"
          onClick={() => onChange({ deptHeadId: null, teamLeadId: null, userId: null })}
        >
          <RotateCcw className="size-4" aria-hidden /> Đặt lại
        </Button>
        )}
        </MobileFilterSheet>
        )}
        {showFilter && (
          <p className="text-[14px] text-muted-foreground sm:ml-auto lg:whitespace-nowrap" aria-live="polite">
            {active ? `Đang lọc: ${describeFilter(roster, value, selfId)}` : 'Phạm vi: toàn bộ'}
          </p>
        )}
      </div>
    </div>
  )
}
