"use client"

import { useEffect, useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command"
import {
  Search, SlidersHorizontal, ChevronsUpDown, Calendar as CalendarIcon, X, RotateCcw, ArrowRight,
  Building2, User as UserIcon, Megaphone,
} from "lucide-react"
import type { ContactFilters } from "@/hooks/use-contacts"
import { useSettingsOptions } from "@/hooks/use-settings-options"
import { useActiveProjects } from "@/hooks/use-projects"
import { cn } from "@/lib/utils"
import { autoMaskVnDate, isoToVnDate, parseVnDate } from "@/lib/format"
import { useContactAssignableUsers } from "@/hooks/use-contact-assignable-users"

const ALL = "all"

interface AssigneeOption {
  id: number
  full_name: string
  email?: string | null
}

interface FilterUserLike {
  id: number
  full_name: string
}

/**
 * Nhãn cho dropdown nhân sự (Phụ trách) khi value đã có sẵn (bộ lọc khôi phục từ URL sau khi quay
 * lại từ trang chi tiết, roster có thể CHƯA tải xong ở lần render đầu).
 *
 * Base-UI `<SelectValue>` không tự render label khi value preload
 * VÀ bỏ qua `placeholder` khi children là hàm — trả `null` khi chưa tìm
 * thấy làm trigger hiện TRỐNG TRƠN. Phân biệt 2 lý do "chưa tìm thấy":
 * đang tải (danh sách rỗng vì query chưa xong) → "Đang tải..."; đã tải
 * xong mà vẫn không có (id nằm ngoài phạm vi/đã bị xoá khỏi danh sách) →
 * fallback "NV #<id>" (convention `formatEmployee`, `lib/format.ts`) —
 * KHÔNG BAO GIỜ trả `null`/rỗng cho 1 value đã có.
 */
function employeeSelectLabel(
  value: string,
  list: FilterUserLike[],
  isLoading: boolean,
): string {
  const found = list.find((u) => String(u.id) === value)
  if (found) return found.full_name
  if (isLoading) return "Đang tải..."
  return `NV #${value}`
}

const LEAD_FILTER_OPTIONS = [
  { value: "hot", label: "Nóng" },
  { value: "warm", label: "Ấm" },
  { value: "cold", label: "Lạnh" },
  { value: "unscored", label: "Chưa chấm" },
]
const LEAD_FILTER_LABEL: Record<string, string> = Object.fromEntries(LEAD_FILTER_OPTIONS.map((o) => [o.value, o.label]))

interface ContactsFiltersProps {
  /** Giá trị input đang gõ (chưa apply) — chỉ dùng cho UI control. */
  searchInput: string
  onSearch: (value: string) => void
  onFilterChange: (key: keyof ContactFilters) => (value: string) => void
  /** Click "Tìm kiếm" → page.tsx commit pending → applied + reset trang về 1. */
  onApply: () => void
  /** Click "Đặt lại" → clear toàn bộ filter pending. */
  onReset: () => void
  stageId?: string
  contactStatusId?: string
  sourceId?: string
  createdFrom?: string
  createdTo?: string
  assignedTo?: string
  /** Filter theo dự án (project_id). */
  projectId?: string
  /** Nhãn điểm lead. */
  leadLabel?: string
  /** Hiện bộ lọc Điểm lead (tính năng `lead_scoring` của tổ chức). Mặc định hiện. */
  showLeadFilter?: boolean
  /**
   * Hiện dropdown "Phụ trách" — caller truyền `scopeOf('contacts.view')` rộng hơn
   * "own" (BE `/contacts/assignable-users` đã cắt người theo phạm vi quyền).
 */
  showAssigneeFilter?: boolean
  /** Có thay đổi pending nhưng chưa apply → highlight nút Tìm kiếm. */
  isDirty?: boolean
  /**
   * Bộ lọc ĐANG ÁP (đã commit) — nguồn cho dải chip điều kiện.
   *
   * 🔴 CỐ Ý khác các prop giá trị ở trên: chúng là state PENDING (đang chọn,
   * chưa bấm Tìm kiếm). Chip phải mô tả thứ danh sách bên dưới ĐANG lọc theo,
   * nếu lấy pending thì người dùng chọn 1 giá trị rồi bỏ đi sẽ thấy chip của
   * điều kiện chưa hề áp — đọc sai hoàn toàn kết quả đang nhìn.
 */
  applied?: ContactFilters
  /** Gỡ 1 điều kiện ĐANG ÁP (commit ngay, không chờ bấm Tìm kiếm). */
  onRemoveApplied?: (key: keyof ContactFilters) => void
  /** Đặt TRƯỚC ô tìm trên cùng hàng công cụ (vd tab "Tất cả / Của tôi"). */
  leading?: React.ReactNode
  /** Đặt SAU nút "Lọc" (vd nút "Sắp xếp"). */
  trailing?: React.ReactNode
}

// thêm icon + màu cho từng nhóm filter để sale dễ phân biệt
// nhanh các nhóm filter trên dashboard. Color palette align với business
// semantics: Dự án=emerald, Nhân viên phụ trách=teal/user, Nguồn=pink.
type FilterIconTheme = "project" | "assignee" | "source" | undefined
const ICON_BY_THEME: Record<NonNullable<FilterIconTheme>, { Icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  project:   { Icon: Building2,   cls: "text-emerald-600" },
  assignee:  { Icon: UserIcon,    cls: "text-teal-600" },
  source:    { Icon: Megaphone,   cls: "text-pink-600" },
}

function FilterField({
  label, htmlFor, children, className, theme,
}: { label: string; htmlFor?: string; children: React.ReactNode; className?: string; theme?: FilterIconTheme }) {
  const themeCfg = theme ? ICON_BY_THEME[theme] : null
  return (
    <div className={`flex flex-col gap-1 ${className ?? ""}`}>
      <Label
        htmlFor={htmlFor}
        className="text-sm font-medium text-muted-foreground inline-flex items-center gap-1.5"
      >
        {themeCfg ? <themeCfg.Icon className={`size-3.5 ${themeCfg.cls}`} /> : null}
        {label}
      </Label>
      {children}
    </div>
  )
}

function AssigneeCombobox({
  value,
  onChange,
  assignees,
  isLoading = false,
}: {
  value: string | undefined
  onChange: (v: string) => void
  assignees: AssigneeOption[]
  /**
   * khi `value` khôi phục từ URL (quay lại từ trang chi tiết)
   * mà danh sách `assignees` chưa tải xong, "Tất cả" đọc nhầm thành "không
   * lọc gì" dù thực ra ĐANG lọc theo 1 người — phân biệt rõ "đang tải" với
   * "không chọn ai" (cùng áp cho combobox tự viết, không
   * phải Base-UI Select).
 */
  isLoading?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = useMemo(
    () => assignees.find((u) => String(u.id) === value),
    [assignees, value],
  )
  const triggerLabel = value ? employeeSelectLabel(value, assignees, Boolean(isLoading)) : "Tất cả"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="lg"
            className="w-full justify-between font-normal"
            id="flt-assignee"
          />
        }
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[260px] p-0"
      >
        <Command
          filter={(itemValue, searchTerm) => {
            const t = searchTerm.toLowerCase().trim()
            if (!t) return 1
            return itemValue.toLowerCase().includes(t) ? 1 : 0
          }}
        >
          <CommandInput placeholder="Tìm theo tên hoặc email..." />
          <CommandList>
            <CommandEmpty>Không tìm thấy nhân viên</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__ tất cả all"
                data-checked={!value}
                onSelect={() => {
                  onChange("")
                  setOpen(false)
                }}
              >
                Tất cả
              </CommandItem>
              {assignees.map((u) => {
                const haystack = `${u.full_name} ${u.email ?? ""}`
                return (
                  <CommandItem
                    key={u.id}
                    value={haystack}
                    data-checked={String(u.id) === value}
                    onSelect={() => {
                      onChange(String(u.id))
                      setOpen(false)
                    }}
                  >
                    <div className="flex flex-col">
                      <span className="text-sm">{u.full_name}</span>
                      {u.email ? (
                        <span className="text-sm text-muted-foreground">
                          {u.email}
                        </span>
                      ) : null}
                    </div>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Date filter input — DISPLAY `DD/MM/YYYY` (VN), EMIT ISO `YYYY-MM-DD`.
 *
 * đổi sang `<input type="date">` → browser quyết
 * format theo locale máy (en-US hiện `MM/DD/YYYY`). Sale gõ "10/05" tưởng
 * 10 tháng 5 nhưng browser hiểu 5 tháng 10. Fix: text input + parser thủ công.
 *
 * Sync prop → state: useEffect bail-out để tránh render storm.
 */
function DateInput({
  id,
  value,
  onChange,
  ariaLabel,
}: {
  id: string
  value: string | undefined
  onChange: (next: string) => void
  ariaLabel: string
}) {
  const [text, setText] = useState<string>(() => isoToVnDate(value))

  // Sync khi prop đổi từ ngoài (vd: reset filter). Bail-out tránh render storm.
  useEffect(() => {
    const next = isoToVnDate(value)
    setText((prev) => (prev === next ? prev : next))
  }, [value])

  const handleChange = (raw: string) => {
    const masked = autoMaskVnDate(raw)
    setText(masked)
    if (masked === "") {
      if (value) onChange("")
      return
    }
    const iso = parseVnDate(masked)
    if (iso === undefined) return // partial/invalid → chờ user gõ tiếp
    if (iso !== (value ?? "")) onChange(iso)
  }

  const invalid = text.length === 10 && parseVnDate(text) === undefined
  return (
    <div className="relative w-full">
      <CalendarIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        placeholder="DD/MM/YYYY"
        maxLength={10}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        className={cn("pl-9 pr-7 text-sm")}
      />
      {text ? (
        <button
          type="button"
          aria-label="Xoá ngày"
          onClick={() => {
            setText("")
            if (value) onChange("")
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground z-10 after:absolute after:-inset-1.5 after:content-[''] pointer-coarse:sm:after:-inset-[14px] max-sm:after:-inset-3"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * Danh bạ v3: apply-on-submit — toàn bộ filter chỉ effect khi user click "Tìm kiếm".
 * Tránh spam API → 429 trên bảng lớn.
 *  - Assignee: Combobox có search (name + email)
 *  - Khoảng ngày tạo: text DD/MM/YYYY (parser thủ công, gửi ISO lên API)
 *  - Search input + Enter cũng trigger Tìm kiếm
 */
export function ContactsFilters(props: ContactsFiltersProps) {
  const {
    searchInput, onSearch, onFilterChange, onApply, onReset,
    stageId, contactStatusId, sourceId, leadLabel, showLeadFilter = true,
    createdFrom, createdTo, assignedTo,
    projectId,
    showAssigneeFilter = false,
    isDirty = false,
    applied,
    onRemoveApplied,
    leading,
    trailing,
  } = props
  const [filterOpen, setFilterOpen] = useState(false)

  const handleEnterToApply = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      onApply()
      setFilterOpen(false)
    }
  }

  const { data: stages = [] } = useSettingsOptions(
    "contact_stage",
  )
  const { data: contactStatuses = [] } = useSettingsOptions(
    "contact_detail_status",
  )
  const { data: sourcesManual = [] } = useSettingsOptions("contact_source")
  const sources = useMemo(() => {
    return [...sourcesManual].sort((x, y) => x.label.localeCompare(y.label, "vi"))
  }, [sourcesManual])
  const { data: projects = [], isLoading: projectsLoading } = useActiveProjects()

  // Dropdown "Phụ trách": nhân sự trong phạm vi `contacts.view` của CHÍNH người
  // dùng (BE `GET /contacts/assignable-users`) — KHÔNG còn cascade Phòng → Team →
  // NV theo vai trò, KHÔNG nhánh riêng cho từng vai trò (RBAC quyền + phạm vi).
  const { data: assigneeUsers = [], isLoading: assigneesLoading } = useContactAssignableUsers({
    enabled: showAssigneeFilter,
  })
  const assignees = useMemo<AssigneeOption[]>(
    () => assigneeUsers.map((u) => ({ id: u.id, full_name: u.full_name ?? u.email, email: u.email })),
    [assigneeUsers],
  )

  /* ---- Dải chip điều kiện ĐANG ÁP ----
   * Nhãn lấy từ CHÍNH các mảng option đang dùng cho dropdown ở trên — không
   * fetch thêm nguồn nào. Roster chưa tải xong (hoặc người đó rời danh sách)
   * thì `employeeSelectLabel` trả "Đang tải…"/"NV #id" thay vì để trống, cùng
   * quy ước với dropdown.
   *
   * Chỉ hiện điều kiện THỰC SỰ có giá trị — thiết kế vẽ cả chip "Tất cả ×",
   * nhưng chip cho một điều kiện không lọc gì là nhiễu và bấm × không đổi kết
   * quả, người dùng sẽ tưởng nút hỏng.
 */
  const appliedChips = useMemo(() => {
    if (!applied) return []
    const out: { key: keyof ContactFilters; label: string }[] = []
    const push = (key: keyof ContactFilters, label: string | null | undefined) => {
      if (label) out.push({ key, label })
    }
    const optionLabel = (
      list: readonly { id: number | string; label: string }[],
      value: string | undefined,
    ) => (value ? (list.find((o) => String(o.id) === value)?.label ?? `#${value}`) : undefined)

    push("stageId", applied.stageId && `Giai đoạn: ${optionLabel(stages, applied.stageId)}`)
    push("contactStatusId", applied.contactStatusId && `Trạng thái chi tiết: ${optionLabel(contactStatuses, applied.contactStatusId)}`)
    push("sourceId", applied.sourceId && `Nguồn: ${optionLabel(sources, applied.sourceId)}`)
    push("leadLabel", applied.leadLabel && `Điểm lead: ${LEAD_FILTER_LABEL[applied.leadLabel] ?? applied.leadLabel}`)
    // `ProjectOption` dùng `name` (không phải `label`) — quy đổi tại chỗ thay
    // vì nới kiểu của `optionLabel`, để lỡ nhãn đổi tên field thì TypeScript
    // còn bắt được.
    push(
      "projectId",
      applied.projectId &&
        `Dự án: ${optionLabel(projects.map((p) => ({ id: p.id, label: p.name })), applied.projectId)}`,
    )
    push(
      "assignedTo",
      applied.assignedTo &&
        `Phụ trách: ${employeeSelectLabel(applied.assignedTo, assignees, assigneesLoading)}`,
    )
    // `team_id` lọc được qua URL (`use-contacts-filters.ts`) nhưng màn này
    // KHÔNG có dropdown nào cho nó — không có chip thì mở link cũ `?team_id=`
    // sẽ thấy danh sách bị thu hẹp mà không một điều kiện nào hiện ra.
    push("teamId", applied.teamId && `Team #${applied.teamId}`)
    push("createdFrom", applied.createdFrom && `Từ ngày: ${isoToVnDate(applied.createdFrom)}`)
    push("createdTo", applied.createdTo && `Đến ngày: ${isoToVnDate(applied.createdTo)}`)
    push("search", applied.search && `Tìm: "${applied.search}"`)
    return out
  }, [
    applied, stages, contactStatuses, sources, projects,
    assignees, assigneesLoading,
  ])
  // "Lọc (n)": số điều kiện ĐANG ÁP (khớp dải chip), không tính từ khoá tìm — từ khoá đã nằm sẵn trong ô tìm.
  const appliedCount = appliedChips.filter((c) => c.key !== "search").length

  const chipsRow =
    appliedChips.length > 0 && onRemoveApplied ? (
      <div className="flex flex-wrap items-center gap-1.5 pt-2.5">
        {appliedChips.map((chip) => (
          <span
            key={chip.key}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--color-app-surface-2)] py-0.5 pl-2.5 pr-1 text-sm text-[var(--color-app-ink-2)]"
          >
            <span className="truncate">{chip.label}</span>
            <button
              type="button"
              onClick={() => onRemoveApplied(chip.key)}
              aria-label={`Bỏ điều kiện ${chip.label}`}
              className="flex size-5 shrink-0 items-center justify-center rounded-full max-sm:size-9 text-[var(--color-app-ink-2)] transition hover:bg-[var(--color-app-surface-3)] hover:text-[var(--color-app-navy)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={onReset}
          className="ml-1 rounded px-1.5 py-1 text-sm font-semibold max-sm:min-h-11 text-[var(--color-app-primary-ink)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          Xoá hết điều kiện
        </button>
      </div>
    ) : null

  const stageField = (
    <FilterField
      label="Giai đoạn"
      htmlFor="flt-stage"
      className="w-full"
    >
      <Select
        value={stageId ?? ALL}
        onValueChange={(v) =>
          typeof v === "string" && onFilterChange("stageId")(v)
        }
        items={[
          { value: ALL, label: "Tất cả" },
          ...stages.map((o) => ({ value: String(o.id), label: o.label })),
        ]}
      >
        <SelectTrigger id="flt-stage">
          <SelectValue placeholder="Tất cả">
            {(v) => {
              if (typeof v !== "string" || !v || v === ALL) return "Tất cả"
              return stages.find((o) => String(o.id) === v)?.label ?? null
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Tất cả</SelectItem>
          {stages.map((o) => (
            <SelectItem key={o.id} value={String(o.id)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterField>
  )

  const statusField = (
    <FilterField
      label="Trạng thái chi tiết"
      htmlFor="flt-status"
      className="w-full"
    >
      <Select
        value={contactStatusId ?? ALL}
        onValueChange={(v) =>
          typeof v === "string" && onFilterChange("contactStatusId")(v)
        }
        items={[
          { value: ALL, label: "Tất cả" },
          ...contactStatuses.map((o) => ({ value: String(o.id), label: o.label })),
        ]}
      >
        <SelectTrigger id="flt-status">
          <SelectValue placeholder="Tất cả">
            {(v) => {
              if (typeof v !== "string" || !v || v === ALL) return "Tất cả"
              return contactStatuses.find((o) => String(o.id) === v)?.label ?? null
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Tất cả</SelectItem>
          {contactStatuses.map((o) => (
            <SelectItem key={o.id} value={String(o.id)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterField>
  )

  const sourceField = (
    <FilterField
      label="Nguồn"
      htmlFor="flt-source"
      className="w-full"
      theme="source"
    >
      <Select
        value={sourceId ?? ALL}
        onValueChange={(v) =>
          typeof v === "string" && onFilterChange("sourceId")(v)
        }
        items={[
          { value: ALL, label: "Tất cả" },
          ...sources.map((o) => ({ value: String(o.id), label: o.label })),
        ]}
      >
        <SelectTrigger id="flt-source">
          <SelectValue placeholder="Tất cả">
            {(v) => {
              if (typeof v !== "string" || !v || v === ALL) return "Tất cả"
              return sources.find((o) => String(o.id) === v)?.label ?? null
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Tất cả</SelectItem>
          {sources.map((o) => (
            <SelectItem key={o.id} value={String(o.id)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterField>
  )

  const leadField = (
    <FilterField label="Điểm lead" htmlFor="flt-lead" className="w-full">
      <Select
        value={leadLabel ?? ALL}
        onValueChange={(v) => typeof v === "string" && onFilterChange("leadLabel")(v)}
        items={[{ value: ALL, label: "Tất cả" }, ...LEAD_FILTER_OPTIONS]}
      >
        <SelectTrigger id="flt-lead">
          <SelectValue placeholder="Tất cả">
            {(v) => {
              if (typeof v !== "string" || !v || v === ALL) return "Tất cả"
              return LEAD_FILTER_LABEL[v] ?? null
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Tất cả</SelectItem>
          {LEAD_FILTER_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterField>
  )

  const projectField = (
    <FilterField label="Dự án" htmlFor="flt-project" className="w-full" theme="project">
      <Select
        value={projectId ?? ALL}
        onValueChange={(v) =>
          typeof v === "string" && onFilterChange("projectId")(v)
        }
        items={[
          { value: ALL, label: "Tất cả dự án" },
          ...projects.map((p) => ({ value: String(p.id), label: p.name })),
        ]}
      >
        <SelectTrigger id="flt-project">
          <SelectValue placeholder={projectsLoading ? "Đang tải..." : "Tất cả dự án"}>
            {(v) => {
              if (typeof v !== "string" || !v || v === ALL) return "Tất cả dự án"
              return projects.find((p) => String(p.id) === v)?.name ?? (projectsLoading ? "Đang tải..." : null)
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Tất cả dự án</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterField>
  )

  const assigneeField = showAssigneeFilter ? (
    <FilterField
      label="Phụ trách"
      htmlFor="flt-assignee"
      className="w-full"
      theme="assignee"
    >
      <AssigneeCombobox
        value={assignedTo}
        onChange={onFilterChange("assignedTo")}
        assignees={assignees}
        isLoading={assigneesLoading}
      />
    </FilterField>
  ) : null

  const dateRangeField = (
    <FilterField label="Khoảng ngày tạo" className="w-full">
      <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center">
        <div className="flex-1 min-w-[140px]">
          <DateInput
            id="flt-date-from"
            ariaLabel="Từ ngày"
            value={createdFrom}
            onChange={onFilterChange("createdFrom")}
          />
        </div>
        <span className="hidden sm:inline text-muted-foreground text-sm shrink-0">→</span>
        <div className="flex-1 min-w-[140px]">
          <DateInput
            id="flt-date-to"
            ariaLabel="Đến ngày"
            value={createdTo}
            onChange={onFilterChange("createdTo")}
          />
        </div>
      </div>
    </FilterField>
  )

  const fields = (
    <>
      {stageField}
      {statusField}
      {sourceField}
      {showLeadFilter && leadField}
      {projectField}
      {assigneeField}
      <div className="sm:col-span-2">{dateRangeField}</div>
    </>
  )

  const searchBox = (
    <div className="relative min-w-0 basis-full sm:max-w-72 sm:flex-none sm:basis-64">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id="flt-search"
        data-show-placeholder
        aria-label="Tìm khách hàng"
        placeholder="SĐT, họ tên hoặc email..."
        className="h-9 pl-9 pr-10 max-sm:h-11"
        value={searchInput}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={handleEnterToApply}
      />
      <button
        type="button"
        onClick={() => onApply()}
        aria-label="Tìm kiếm"
        className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] max-sm:size-10"
      >
        <ArrowRight className="h-4 w-4" />
        {isDirty ? <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" /> : null}
      </button>
    </div>
  )

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {leading}
        {searchBox}
        <Popover open={filterOpen} onOpenChange={setFilterOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                className="h-9 shrink-0 gap-1.5 text-sm max-sm:h-11 max-sm:flex-1"
                aria-label={appliedCount > 0 ? `Lọc — ${appliedCount} điều kiện đang bật` : "Lọc"}
              />
            }
          >
            <SlidersHorizontal className="h-4 w-4" />
            Lọc
            {appliedCount > 0 ? (
              <span
                data-testid="filter-count"
                className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--color-app-primary-soft)] px-1.5 text-sm font-semibold leading-5 text-[var(--color-app-primary-ink)]"
              >
                {appliedCount}
              </span>
            ) : null}
          </PopoverTrigger>
          <PopoverContent
            keepMounted
            align="start"
            className="max-h-[min(72vh,640px)] w-[min(600px,calc(100vw-32px))] gap-3 overflow-y-auto p-4"
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[15px] font-semibold text-foreground">Lọc khách hàng</p>
              <span className="text-sm text-muted-foreground">
                {appliedCount > 0 ? `${appliedCount} điều kiện đang bật` : "Chưa lọc"}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">{fields}</div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
              <Button
                type="button"
                variant="ghost"
                className="h-9 gap-1 max-sm:h-11"
                onClick={() => {
                  onReset()
                  setFilterOpen(false)
                }}
                aria-label="Đặt lại bộ lọc"
              >
                <RotateCcw className="h-4 w-4" />
                Đặt lại
              </Button>
              <Button
                type="button"
                className="h-9 gap-1 max-sm:h-11"
                onClick={() => {
                  onApply()
                  setFilterOpen(false)
                }}
                aria-label="Áp dụng bộ lọc"
              >
                Áp dụng
                {isDirty ? <span aria-hidden className="ml-1 h-1.5 w-1.5 rounded-full bg-current" title="Có thay đổi chưa áp dụng" /> : null}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        {trailing}
      </div>

      {chipsRow}
    </div>
  )
}
