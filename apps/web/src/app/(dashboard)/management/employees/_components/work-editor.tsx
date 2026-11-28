"use client"

/**
 * Khay «Sửa công việc» (thiết kế nhansu-mobile2; desktop: khay phải) — trạng thái 4 ô, chức danh, team, phòng ban,
 * văn phòng chấm công, ngày vào làm, quản lý trực tiếp.
 *
 * Chỉ gửi trường ĐÃ ĐỔI (`PATCH /management/employees/:id` là patch từng trường): không đụng BHXH, ảnh, ngân hàng…
 * - Đổi Team ⇒ máy chủ tự gán quản lý = trưởng nhóm và phòng ban theo team, nên khi đã đổi Team thì khoá hai ô đó
 *   (không gửi kèm, tránh lựa chọn bị ghi đè âm thầm).
 * - Trạng thái chỉ gửi khi bấm một ô: «Tạm nghỉ»/«Chưa phân loại» đang có vẫn giữ nguyên nếu không đổi.
 * - Quyền: máy chủ đòi `employees.manage` + `users.manage` phủ người này và không leo thang quyền; lỗi hiện nguyên lời máy chủ.
 */
import * as React from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { AxField } from "@/components/ui/field"
import { HeroCard, HeroCardLabel } from "@/components/ui/hero-card"
import { PersonAvatar } from "@/components/ui/avatar"
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { showUndoToast } from "@/components/ui/undo-toast"
import { useOffline } from "@/components/offline-banner"
import { useUpdateEmployee, type Employee, type UpdateEmployeeDto } from "@/hooks/use-employees"
import { useJobTitles } from "@/hooks/use-job-titles"
import { useDepartments } from "@/hooks/use-departments"
import { useOffices } from "@/hooks/use-attendance"
import { useTeamsForFilter } from "@/hooks/use-teams"
import { useActiveUsers } from "@/hooks/use-filter-users"
import { autoMaskVnDate, formatDate, parseVnDate } from "@/lib/format"
import { errorMessage } from "@/lib/error-messages"
import { cn } from "@/lib/utils"
import { STATUS_LABELS } from "./employee-detail"

/** 4 ô trạng thái của thiết kế. */
export const WORK_STATUSES = ["active", "probation", "waiting", "resigned"] as const

/** Patch gửi đi: các trường tuỳ chọn nhận `null` = xoá (máy chủ nhận `Option<Option<_>>`). */
export type WorkPatch = Omit<UpdateEmployeeDto, "job_title_id" | "joined_at" | "department" | "position"> & {
  job_title_id?: number | null
  joined_at?: string | null
  department?: string | null
  position?: string | null
}

export interface WorkDraft {
  status: string | null
  job_title_id: number | null
  position: string
  team_id: number | null
  department: string
  office_id: number | null
  /** dd/mm/yyyy */
  joined: string
  manager_id: number | null
}

function toVnDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const v = formatDate(iso)
  return v === "—" ? "" : v
}

export function workDraftOf(emp: Employee): WorkDraft {
  return {
    status: emp.status ?? null,
    job_title_id: emp.job_title_id ?? null,
    position: emp.position ?? "",
    team_id: emp.team_id ?? null,
    department: emp.department ?? "",
    office_id: emp.office_id ?? null,
    joined: toVnDate(emp.joined_at),
    manager_id: emp.manager_id ?? null,
  }
}

/**
 * Tính patch từ bản nháp: chỉ trường đổi; đổi Team thì bỏ quản lý/phòng ban (máy chủ tự suy).
 * Trả `{ error }` khi ngày sai dạng. `undo` = patch đưa các trường đã đổi về giá trị cũ (null khi đổi Team — không hoàn tác được chắc chắn).
 */
export function buildWorkPatch(
  emp: Employee,
  draft: WorkDraft,
  jobTitleName: (id: number) => string | undefined,
): { patch: WorkPatch; undo: WorkPatch | null } | { error: string } {
  const init = workDraftOf(emp)
  const patch: WorkPatch = {}
  const undo: WorkPatch = {}
  if (draft.status !== init.status && draft.status) {
    patch.status = draft.status
    if (init.status) undo.status = init.status
  }
  if (draft.job_title_id !== init.job_title_id) {
    patch.job_title_id = draft.job_title_id
    const name = draft.job_title_id !== null ? jobTitleName(draft.job_title_id) : undefined
    if (name) patch.position = name
    undo.job_title_id = init.job_title_id
    undo.position = emp.position ?? null
  } else if (draft.position.trim() !== init.position.trim()) {
    patch.position = draft.position.trim() || null
    undo.position = emp.position ?? null
  }
  const teamChanged = draft.team_id !== init.team_id && draft.team_id !== null
  if (teamChanged) patch.team_id = draft.team_id as number
  if (!teamChanged && draft.department !== init.department) {
    patch.department = draft.department || null
    undo.department = emp.department ?? null
  }
  if (draft.office_id !== init.office_id) {
    patch.office_id = draft.office_id
    undo.office_id = init.office_id
  }
  if (draft.joined.trim() !== init.joined) {
    const parsed = parseVnDate(draft.joined)
    if (parsed === undefined) return { error: "Nhập ngày vào làm dạng dd/mm/yyyy." }
    patch.joined_at = parsed ? new Date(`${parsed}T00:00:00+07:00`).toISOString() : null
    undo.joined_at = emp.joined_at ?? null
  }
  if (!teamChanged && draft.manager_id !== init.manager_id) {
    patch.manager_id = draft.manager_id
    undo.manager_id = init.manager_id
  }
  return { patch, undo: teamChanged ? null : undo }
}

const NONE = "__none__"

/** Ô chọn «Ánh xanh» 44px + nhãn/gợi ý — bọc Select sẵn có. */
function AxSelectField({
  id,
  label,
  hint,
  value,
  placeholder,
  options,
  onChange,
  disabled,
  allowNone,
}: {
  id: string
  label: string
  hint?: string
  value: string | null
  placeholder: string
  options: { value: string; label: string }[]
  onChange: (v: string | null) => void
  disabled?: boolean
  allowNone?: string
}) {
  const hintId = `${id}-hint`
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="ax-text-label">{label}</label>
      <Select
        value={value ?? NONE}
        disabled={disabled}
        onValueChange={(v) => onChange(!v || v === NONE ? null : String(v))}
      >
        <SelectTrigger
          id={id}
          aria-describedby={hint ? hintId : undefined}
          className="h-11 w-full rounded-[var(--ax-radius-field)] border-ax-field-border bg-ax-surface text-[15px] data-[size=default]:h-11"
        >
          <SelectValue placeholder={placeholder}>
            {(v) => {
              if (typeof v !== "string" || v === NONE) return allowNone ?? placeholder
              return options.find((o) => o.value === v)?.label ?? placeholder
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>{allowNone}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p id={hintId} className="text-[13px] leading-5 text-ax-ink-3">{hint}</p>}
    </div>
  )
}

/** Ô trạng thái dạng ô vuông 48px, lưới 2 cột (thiết kế nhansu-mobile2). */
function StatusTile({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "flex h-12 cursor-pointer items-center justify-center rounded-ax-card border px-2 text-[15px] font-semibold transition-colors duration-150",
        "focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none",
        on
          ? "border-ax-primary bg-ax-primary-soft text-ax-primary-press"
          : "border-ax-line bg-ax-surface text-ax-ink shadow-ax-card hover:bg-ax-hover",
      )}
    >
      {children}
    </button>
  )
}

export function EmployeeWorkEditor({
  emp,
  canChangeManager,
  onClose,
}: {
  emp: Employee
  /** `users.view` để tải danh sách người làm quản lý. */
  canChangeManager: boolean
  onClose: () => void
}) {
  const update = useUpdateEmployee(emp.id)
  const offline = useOffline()
  const { data: jobTitles = [] } = useJobTitles({ is_active: true })
  const configuredDepartments = useDepartments()
  const { data: offices = [] } = useOffices()
  const { data: teams = [] } = useTeamsForFilter({ includeUnled: true })
  const { data: users = [] } = useActiveUsers({ enabled: canChangeManager })
  const [draft, setDraft] = React.useState<WorkDraft>(() => workDraftOf(emp))
  const [dateErr, setDateErr] = React.useState<string | null>(null)
  const init = React.useMemo(() => workDraftOf(emp), [emp])
  const teamChanged = draft.team_id !== init.team_id && draft.team_id !== null
  const name = emp.full_name ?? "nhân viên"

  const set = <K extends keyof WorkDraft>(k: K, v: WorkDraft[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const statuses: string[] = [...WORK_STATUSES]
  if (init.status && !statuses.includes(init.status)) statuses.push(init.status)

  const departments = init.department && !configuredDepartments.includes(init.department)
    ? [...configuredDepartments, init.department]
    : configuredDepartments
  // Giữ lựa chọn hiện tại dù không còn trong danh sách (văn phòng đã xoá, người quản lý đã nghỉ…).
  const officeOpts = offices.map((o) => ({ value: String(o.id), label: o.name }))
  if (emp.office_id && emp.office_name && !offices.some((o) => o.id === emp.office_id)) {
    officeOpts.push({ value: String(emp.office_id), label: emp.office_name })
  }
  const managerOpts = users.filter((u) => u.id !== emp.user_id).map((u) => ({ value: String(u.id), label: u.full_name }))
  if (emp.manager_id && emp.manager_name && !managerOpts.some((o) => o.value === String(emp.manager_id))) {
    managerOpts.push({ value: String(emp.manager_id), label: emp.manager_name })
  }
  const teamOpts = teams.map((t) => ({ value: String(t.id), label: t.name }))
  if (emp.team_id && emp.team_name && !teams.some((t) => t.id === emp.team_id)) {
    teamOpts.push({ value: String(emp.team_id), label: emp.team_name })
  }

  async function save() {
    const r = buildWorkPatch(emp, draft, (id) => jobTitles.find((j) => j.id === id)?.name)
    if ("error" in r) {
      setDateErr(r.error)
      return
    }
    setDateErr(null)
    if (Object.keys(r.patch).length === 0) {
      onClose()
      return
    }
    try {
      await update.mutateAsync(r.patch as UpdateEmployeeDto)
      onClose()
      const undo = r.undo
      showUndoToast(`Đã lưu công việc của ${name}`, {
        onUndo:
          undo && Object.keys(undo).length > 0
            ? () =>
                update.mutate(undo as UpdateEmployeeDto, {
                  onError: (err) => toast.error(errorMessage(err, "Chưa hoàn tác được")),
                })
            : undefined,
      })
    } catch (err) {
      toast.error(errorMessage(err, "Chưa lưu được công việc"))
    }
  }

  const busy = update.isPending

  return (
    <Sheet open onOpenChange={(v) => { if (!v && !busy) onClose() }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 border-ax-line bg-ax-bg p-0 data-[side=right]:w-full data-[side=right]:max-w-none lg:data-[side=right]:w-[480px]"
      >
        <div className="flex h-12 shrink-0 items-center border-b border-ax-line ax-grad-bar px-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-11 min-w-14 cursor-pointer px-3 text-left text-base text-ax-primary-press focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none disabled:opacity-50"
          >
            Huỷ
          </button>
          <SheetTitle className="flex-1 text-center text-[17px] font-semibold text-ax-ink">Sửa công việc</SheetTitle>
          <span className="min-w-14" aria-hidden />
        </div>
        <SheetDescription className="sr-only">Trạng thái, chức danh, team, văn phòng chấm công và quản lý trực tiếp của {name}.</SheetDescription>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 pt-4 pb-4">
          <HeroCard className="max-sm:px-4 max-sm:py-3.5">
            <div className="flex items-center gap-3">
              <PersonAvatar kind="staff" size="xl" name={emp.full_name} src={emp.avatar_url} />
              <div className="min-w-0">
                <p className="truncate text-[17px] font-semibold text-white">{emp.full_name ?? "Chưa cập nhật"}</p>
                <HeroCardLabel className="truncate text-[13px]">
                  {[emp.employee_code, emp.position ?? emp.job_title_name].filter(Boolean).join(" · ")}
                </HeroCardLabel>
              </div>
            </div>
          </HeroCard>

          <div role="group" aria-labelledby="work-status-label" className="flex flex-col gap-1.5">
            <span id="work-status-label" className="ax-text-label">Trạng thái</span>
            <div className="grid grid-cols-2 gap-2">
              {statuses.map((s) => (
                <StatusTile key={s} on={draft.status === s} onClick={() => set("status", s)}>
                  {STATUS_LABELS[s] ?? s}
                </StatusTile>
              ))}
            </div>
          </div>

          {jobTitles.length > 0 ? (
            <AxSelectField
              id="work-job-title"
              label="Chức danh"
              value={draft.job_title_id !== null ? String(draft.job_title_id) : null}
              placeholder="Chọn chức danh"
              allowNone="Chưa có chức danh"
              options={jobTitles.map((j) => ({ value: String(j.id), label: j.name }))}
              onChange={(v) => set("job_title_id", v ? Number(v) : null)}
            />
          ) : (
            <AxField
              label="Chức danh"
              placeholder="Ví dụ: nhân viên bán hàng"
              value={draft.position}
              onChange={(e) => set("position", e.target.value)}
            />
          )}

          <AxSelectField
            id="work-team"
            label="Team / bộ phận"
            value={draft.team_id !== null ? String(draft.team_id) : null}
            placeholder="Chưa thuộc team"
            hint={teamChanged ? "Đổi team: quản lý trực tiếp và phòng ban theo trưởng nhóm của team mới." : undefined}
            options={teamOpts}
            onChange={(v) => set("team_id", v ? Number(v) : init.team_id)}
          />

          <AxSelectField
            id="work-department"
            label="Phòng ban"
            value={draft.department || null}
            placeholder="Chưa có phòng ban"
            allowNone="Chưa có phòng ban"
            disabled={teamChanged}
            options={departments.map((d) => ({ value: d, label: d }))}
            onChange={(v) => set("department", v ?? "")}
          />

          <AxSelectField
            id="work-office"
            label="Văn phòng chấm công"
            value={draft.office_id !== null ? String(draft.office_id) : null}
            placeholder="Chưa gán"
            allowNone="Chưa gán"
            hint="Nhân viên chỉ chấm công được ở mạng của văn phòng này."
            options={officeOpts}
            onChange={(v) => set("office_id", v ? Number(v) : null)}
          />

          <AxField
            label="Ngày vào làm"
            inputMode="numeric"
            placeholder="dd/mm/yyyy"
            value={draft.joined}
            error={dateErr ?? undefined}
            onChange={(e) => { set("joined", autoMaskVnDate(e.target.value)); setDateErr(null) }}
          />

          {canChangeManager ? (
            <AxSelectField
              id="work-manager"
              label="Quản lý trực tiếp"
              value={draft.manager_id !== null ? String(draft.manager_id) : null}
              placeholder="Chưa có quản lý"
              allowNone="Chưa có quản lý"
              disabled={teamChanged}
              hint="Người duyệt đơn chấm công của nhân viên."
              options={managerOpts}
              onChange={(v) => set("manager_id", v ? Number(v) : null)}
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="ax-text-label">Quản lý trực tiếp</span>
              <p className="text-[15px] text-ax-ink">{emp.manager_name ?? "Chưa có quản lý"}</p>
            </div>
          )}
        </div>

        <div className="flex shrink-0 gap-2 border-t border-ax-line ax-grad-bar px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] lg:justify-end">
          <Button variant="ax-secondary" size="ax" className="max-lg:hidden" disabled={busy} onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="ax-primary" size="ax-lg" className="max-lg:flex-1 lg:h-10" disabled={busy || offline} onClick={() => void save()}>
            {busy ? "Đang lưu…" : "Lưu thay đổi"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
