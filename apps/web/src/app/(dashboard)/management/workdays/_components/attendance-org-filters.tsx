"use client"

/**
 * Bộ lọc Team / Phòng ban / Chức danh dùng chung cho các tab Quản lý chấm công.
 *
 * Cascade logic: chọn Phòng ban → danh sách Team thu hẹp theo department; đổi Phòng ban → reset Team.
 * Chức danh độc lập với cascade.
 */

import { useEffect, useRef } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useTeamsForFilter } from "@/hooks/use-teams"
import { useJobTitles } from "@/hooks/use-job-titles"
import { useDepartments } from "@/hooks/use-departments"

export interface OrgFilterValues {
  department: string   // "" = tất cả
  teamId: number | undefined
  jobTitleId: number | undefined
}

export const EMPTY_ORG_FILTERS: OrgFilterValues = {
  department: "",
  teamId: undefined,
  jobTitleId: undefined,
}

interface AttendanceOrgFiltersProps {
  value: OrgFilterValues
  onChange: (patch: Partial<OrgFilterValues>) => void
}

export function AttendanceOrgFilters({ value, onChange }: AttendanceOrgFiltersProps) {
  // dùng `useTeamsForFilter` (mở cho MỌI role đã đăng nhập, kể cả
  // accountant/chief_accountant) thay vì `useTeams` (`GET /management/teams` —
  // CHỈ super_admin/hr → 403 cho 2 role kia dù họ vào được /management/workdays,
  // khiến dropdown Phòng ban/Team trống rỗng im lặng). `includeUnled: true` để không
  // bỏ sót team chưa gán trưởng nhóm nhưng có NV gán trực tiếp.
  const { data: teams = [] } = useTeamsForFilter({ includeUnled: true })
  const { data: jobTitles = [] } = useJobTitles({ is_active: true })
  // dropdown "Phòng ban" PHẢI khớp danh sách cấu hình tại Cài đặt
  // → Phòng ban (`useDepartments` đọc `/settings/departments`), không suy từ
  // `teams.department`.
  const departments = useDepartments()

  // callback prop vào useEffect deps → render storm. Dùng ref pattern.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Cascade: lọc team theo phòng ban đang chọn
  const filteredTeams = value.department
    ? teams.filter((t) => t.department === value.department)
    : teams

  // dùng useEffect để reset team khi department thay đổi + team không còn trong danh sách lọc.
  // Snapshot filteredTeams trước khi dùng trong closure để luôn đọc giá trị mới nhất.
  const filteredTeamsRef = useRef(filteredTeams)
  filteredTeamsRef.current = filteredTeams

  useEffect(() => {
    const currentTeamId = value.teamId
    if (
      currentTeamId !== undefined &&
      value.department !== "" &&
      !filteredTeamsRef.current.some((t) => t.id === currentTeamId)
    ) {
      onChangeRef.current({ teamId: undefined })
    }
    // deps: chỉ value.department + value.teamId — refs luôn fresh, không cần trong deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.department, value.teamId])

  return (
    <>
      {/* Phòng ban */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-600">Phòng ban</label>
        <Select
          value={value.department || "__all__"}
          onValueChange={(v) => {
            const dept = !v || v === "__all__" ? "" : v
            onChange({ department: dept })
          }}
        >
          <SelectTrigger className="h-8 w-[160px] bg-white text-sm max-sm:h-11 max-sm:w-full">
            <SelectValue placeholder="Tất cả phòng ban">
              {(v) => {
                if (typeof v !== "string") return null
                return v === "__all__" || v === "" ? "Tất cả phòng ban" : (v ?? null)
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Tất cả phòng ban</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Team */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-600">Team</label>
        <Select
          value={value.teamId !== undefined ? String(value.teamId) : "__all__"}
          onValueChange={(v) => {
            onChange({ teamId: v === "__all__" ? undefined : Number(v) })
          }}
        >
          <SelectTrigger className="h-8 w-[160px] bg-white text-sm max-sm:h-11 max-sm:w-full">
            <SelectValue placeholder="Tất cả team">
              {(v) => {
                if (typeof v !== "string") return null
                if (v === "__all__" || v === "") return "Tất cả team"
                const id = Number(v)
                return teams.find((t) => t.id === id)?.name ?? null
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Tất cả team</SelectItem>
            {filteredTeams.map((t) => (
              <SelectItem key={t.id} value={String(t.id)}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Chức danh */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-600">Chức danh</label>
        <Select
          value={value.jobTitleId !== undefined ? String(value.jobTitleId) : "__all__"}
          onValueChange={(v) => {
            onChange({ jobTitleId: v === "__all__" ? undefined : Number(v) })
          }}
        >
          <SelectTrigger className="h-8 w-[160px] bg-white text-sm max-sm:h-11 max-sm:w-full">
            <SelectValue placeholder="Tất cả chức danh">
              {(v) => {
                if (typeof v !== "string") return null
                if (v === "__all__" || v === "") return "Tất cả chức danh"
                const id = Number(v)
                return jobTitles.find((j) => j.id === id)?.name ?? null
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Tất cả chức danh</SelectItem>
            {jobTitles.map((j) => (
              <SelectItem key={j.id} value={String(j.id)}>
                {j.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  )
}
