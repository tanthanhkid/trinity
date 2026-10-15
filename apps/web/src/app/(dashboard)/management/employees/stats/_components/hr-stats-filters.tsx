"use client"

import { useState } from "react"
import { Filter, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectItem,
  SelectContent,
} from "@/components/ui/select"
import { useOffices } from "@/hooks/use-attendance"
import { useJobTitles } from "@/hooks/use-job-titles"
import { useTeamLeadsForFilter } from "@/hooks/use-teams"
import type { HrStatsFilters } from "@/hooks/use-employees"
import { useDepartments } from "@/hooks/use-departments"

const ALL = "__all__"
const NO_TEAM = "none"

/**
 * Bộ lọc phạm vi cho Team + Sinh nhật. Bấm "Lọc" mới áp (staged draft → applied);
 * "Đặt lại" xoá hết. Áp cho mọi phần dưới — KHÔNG ảnh hưởng Tổng quan (5 donut).
 */
export function HrStatsFilters({
  applied,
  onApply,
}: {
  applied: HrStatsFilters
  onApply: (f: HrStatsFilters) => void
}) {
  const [draft, setDraft] = useState<HrStatsFilters>(applied)
  const DEPARTMENTS = useDepartments()
  const { data: offices = [] } = useOffices()
  const { data: jobTitles = [] } = useJobTitles({ is_active: true })
  const { data: teamLeadOptions = [] } = useTeamLeadsForFilter()
  const teamLeads = teamLeadOptions.map((t) => ({ id: t.team_lead_id, full_name: t.name }))

  const set = (patch: Partial<HrStatsFilters>) =>
    setDraft((d) => ({ ...d, ...patch }))

  return (
    <section className="rounded-[var(--radius)] border bg-card p-4 shadow-sm max-sm:border-0 max-sm:bg-transparent max-sm:p-0 max-sm:shadow-none">
      <MobileFilterSheet
        activeCount={Object.values(applied).filter((v) => v != null && v !== "").length}
        onReset={() => {
          setDraft({})
          onApply({})
        }}
      >
      <div className="flex flex-wrap items-end gap-3 max-sm:flex-col max-sm:items-stretch">
        {/* Văn phòng */}
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">
            Văn phòng
          </span>
          <Select
            value={draft.office_id != null ? String(draft.office_id) : ALL}
            onValueChange={(v) =>
              set({ office_id: v && v !== ALL ? Number(v) : undefined })
            }
          >
            <SelectTrigger className="h-9 w-[170px] max-sm:h-11 max-sm:w-full">
              <SelectValue>
                {(v) => {
                  if (typeof v !== "string" || v === ALL)
                    return "Tất cả văn phòng"
                  return offices.find((o) => String(o.id) === v)?.name ?? null
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tất cả văn phòng</SelectItem>
              {offices.map((o) => (
                <SelectItem key={o.id} value={String(o.id)}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Phòng ban */}
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">
            Phòng ban
          </span>
          <Select
            value={draft.department ?? ALL}
            onValueChange={(v) =>
              set({ department: v && v !== ALL ? v : undefined })
            }
          >
            <SelectTrigger className="h-9 w-[160px] max-sm:h-11 max-sm:w-full">
              <SelectValue>
                {(v) =>
                  typeof v === "string" && v && v !== ALL ? v : "Tất cả phòng ban"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tất cả phòng ban</SelectItem>
              {DEPARTMENTS.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Team */}
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">
            Team
          </span>
          <Select
            value={draft.team ?? ALL}
            onValueChange={(v) => set({ team: v && v !== ALL ? v : undefined })}
          >
            <SelectTrigger className="h-9 w-[180px] max-sm:h-11 max-sm:w-full">
              <SelectValue>
                {(v) => {
                  if (typeof v !== "string" || v === ALL) return "Tất cả Team"
                  if (v === NO_TEAM) return "Chưa có team"
                  return (
                    teamLeads.find((u) => String(u.id) === v)?.full_name ?? null
                  )
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tất cả Team</SelectItem>
              {teamLeads.map((u) => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {u.full_name}
                </SelectItem>
              ))}
              <SelectItem value={NO_TEAM}>Chưa có team</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Chức vụ */}
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">
            Chức vụ
          </span>
          <Select
            value={draft.job_title_id != null ? String(draft.job_title_id) : ALL}
            onValueChange={(v) =>
              set({ job_title_id: v && v !== ALL ? Number(v) : undefined })
            }
          >
            <SelectTrigger className="h-9 w-[180px] max-sm:h-11 max-sm:w-full">
              <SelectValue>
                {(v) => {
                  if (typeof v !== "string" || v === ALL) return "Tất cả chức vụ"
                  return jobTitles.find((j) => String(j.id) === v)?.name ?? null
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tất cả chức vụ</SelectItem>
              {jobTitles.map((j) => (
                <SelectItem key={j.id} value={String(j.id)}>
                  {j.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-2 max-sm:flex-col">
          <Button variant="outline" onClick={() => onApply(draft)}>
            <Filter className="mr-2 h-4 w-4" />
            Lọc
          </Button>
          <Button
            className="max-sm:hidden"
            onClick={() => {
              setDraft({})
              onApply({})
            }}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Đặt lại
          </Button>
        </div>
      </div>
      </MobileFilterSheet>
    </section>
  )
}
