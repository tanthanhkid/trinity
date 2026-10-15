"use client"

import { useState, useEffect, type ReactNode } from "react"
import { useForm } from "react-hook-form"
import type { Resolver } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import {
  Pencil,
  Eye,
  Search,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  MoreHorizontal,
} from "lucide-react"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { EmptyState } from "@/components/ui/empty-state"
import { formatDate, autoMaskVnDate, parseVnDate, formatCurrency } from "@/lib/format"
import { useRecruiters } from "@/hooks/use-recruitment"
import { useDepartments } from "@/hooks/use-departments"
import {
  usePositions,
  useCreatePosition,
  useUpdatePosition,
  POSITION_PAGE_SIZE,
  type RecruitmentPosition,
  type PositionFilters,
  type CreatePositionDto,
  type PositionStatus,
} from "@/hooks/use-recruitment-positions"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

// ── Constants ──────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<PositionStatus, string> = {
  open: "Đang mở",
  closed: "Đã đóng",
}

const STATUS_BADGE: Record<PositionStatus, string> = {
  open: "bg-emerald-100 text-emerald-700",
  closed: "bg-gray-100 text-gray-600",
}

// ── Zod schema ─────────────────────────────────────────────────────────────

const positionSchema = z.object({
  job_code: z.string().min(1, "Mã công việc không được để trống"),
  department: z.string().min(1, "Vui lòng chọn phòng ban"),
  team: z.string().optional().or(z.literal("")),
  position_title: z.string().min(1, "Vị trí công việc không được để trống"),
  headcount: z
    .string()
    .min(1, "Nhập số lượng tuyển")
    .regex(/^\d+$/, "Số lượng phải là số nguyên")
    .refine((v) => Number(v) >= 1, "Tối thiểu 1"),
  recruiter_id: z.string().min(1, "Vui lòng chọn người tuyển dụng"),
  opened_date: z
    .string()
    .min(1, "Nhập ngày mở đơn")
    .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Định dạng ngày DD/MM/YYYY"),
  expected_start_date: z
    .string()
    .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Định dạng ngày DD/MM/YYYY")
    .optional()
    .or(z.literal("")),
  description: z.string().optional().or(z.literal("")),
  requirements: z.string().optional().or(z.literal("")),
  recruitment_cost: z
    .string()
    .regex(/^\d*$/, "Chi phí phải là số nguyên dương")
    .optional()
    .or(z.literal("")),
  status: z.enum(["open", "closed"]),
})

type PositionFormValues = z.infer<typeof positionSchema>

function toISODate(vnDate: string): string {
  const iso = parseVnDate(vnDate)
  if (!iso) return vnDate
  // Cột @db.Date (opened_date / expected_start_date) — UTC-midnight tránh lệch 1 ngày
  // ("+07:00" → DATE truncate UTC lùi 1 ngày). formatDate đọc lại ra đúng ngày VN.
  return new Date(iso + "T00:00:00.000Z").toISOString()
}

function toDto(values: PositionFormValues): CreatePositionDto {
  return {
    job_code: values.job_code.trim(),
    department: values.department,
    team: values.team?.trim() || null,
    position_title: values.position_title.trim(),
    headcount: Number(values.headcount),
    recruiter_id: Number(values.recruiter_id),
    opened_date: toISODate(values.opened_date),
    expected_start_date: values.expected_start_date
      ? toISODate(values.expected_start_date)
      : null,
    description: values.description?.trim() || null,
    requirements: values.requirements?.trim() || null,
    recruitment_cost:
      values.recruitment_cost && values.recruitment_cost.trim() !== ""
        ? Number(values.recruitment_cost)
        : null,
    status: values.status,
  }
}

function toDefaultValues(p: RecruitmentPosition | null): PositionFormValues {
  if (!p) {
    return {
      job_code: "",
      department: "",
      team: "",
      position_title: "",
      headcount: "1",
      recruiter_id: "",
      opened_date: "",
      expected_start_date: "",
      description: "",
      requirements: "",
      recruitment_cost: "",
      status: "open",
    }
  }
  return {
    job_code: p.job_code,
    department: p.department,
    team: p.team ?? "",
    position_title: p.position_title,
    headcount: String(p.headcount),
    recruiter_id: p.recruiter_id != null ? String(p.recruiter_id) : "",
    opened_date: p.opened_date ? formatDate(p.opened_date) : "",
    expected_start_date: p.expected_start_date
      ? formatDate(p.expected_start_date)
      : "",
    description: p.description ?? "",
    requirements: p.requirements ?? "",
    recruitment_cost: p.recruitment_cost != null ? String(p.recruitment_cost) : "",
    status: p.status,
  }
}

// ── Status badge ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: PositionStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

// ── Create / Edit dialog ────────────────────────────────────────────────────

function PositionDialog({
  open,
  onClose,
  target,
}: {
  open: boolean
  onClose: () => void
  target: RecruitmentPosition | null
}) {
  const isEdit = target !== null
  const createMutation = useCreatePosition()
  const updateMutation = useUpdatePosition(target?.id ?? 0)
  const { data: recruiters } = useRecruiters()

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PositionFormValues>({
    resolver: zodResolver(positionSchema) as Resolver<PositionFormValues>,
    defaultValues: toDefaultValues(target),
  })

  const departmentValue = watch("department")
  const departments = useDepartments()
  const recruiterValue = watch("recruiter_id")
  const statusValue = watch("status")

  useEffect(() => {
    if (open) reset(toDefaultValues(target))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.id])

  function handleOpenChange(next: boolean) {
    if (!next) {
      reset(toDefaultValues(null))
      onClose()
    }
  }

  async function onSubmit(values: PositionFormValues) {
    const dto = toDto(values)
    try {
      if (isEdit) {
        await updateMutation.mutateAsync(dto)
        toast.success("Cập nhật vị trí tuyển dụng thành công")
      } else {
        await createMutation.mutateAsync(dto)
        toast.success("Thêm vị trí tuyển dụng thành công")
      }
      reset(toDefaultValues(null))
      onClose()
    } catch {
      toast.error(isEdit ? "Cập nhật thất bại" : "Thêm vị trí thất bại")
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex flex-col max-h-[90vh] max-w-[95vw] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Sửa vị trí tuyển dụng" : "Thêm vị trí tuyển dụng"}
          </DialogTitle>
        </DialogHeader>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col flex-1 min-h-0"
        >
          <div className="flex-1 min-h-0 overflow-y-auto space-y-4 px-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Mã công việc */}
              <div className="space-y-1">
                <Label htmlFor="job_code">
                  Mã công việc <span className="text-red-500">*</span>
                </Label>
                <Input id="job_code" {...register("job_code")} placeholder="KD-2026-01" />
                {errors.job_code && (
                  <p className="text-xs text-red-500">{errors.job_code.message}</p>
                )}
              </div>

              {/* Phòng ban */}
              <div className="space-y-1">
                <Label>
                  Phòng ban <span className="text-red-500">*</span>
                </Label>
                <Select
                  value={departmentValue}
                  onValueChange={(v) => { if (v) setValue("department", v) }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn phòng ban">
                      {(v) => (typeof v === "string" && v ? v : null)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {departments.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.department && (
                  <p className="text-xs text-red-500">{errors.department.message}</p>
                )}
              </div>

              {/* Team */}
              <div className="space-y-1">
                <Label htmlFor="team">Team (nếu có)</Label>
                <Input id="team" {...register("team")} placeholder="Team kinh doanh A" />
              </div>

              {/* Vị trí công việc */}
              <div className="space-y-1">
                <Label htmlFor="position_title">
                  Vị trí công việc <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="position_title"
                  {...register("position_title")}
                  placeholder="Nhân viên kinh doanh"
                />
                {errors.position_title && (
                  <p className="text-xs text-red-500">{errors.position_title.message}</p>
                )}
              </div>

              {/* Số lượng tuyển */}
              <div className="space-y-1">
                <Label htmlFor="headcount">
                  Số lượng tuyển <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="headcount"
                  type="number"
                  min={1}
                  {...register("headcount")}
                  placeholder="1"
                />
                {errors.headcount && (
                  <p className="text-xs text-red-500">{errors.headcount.message}</p>
                )}
              </div>

              {/* Người tuyển dụng phụ trách */}
              <div className="space-y-1">
                <Label>
                  Người tuyển dụng phụ trách <span className="text-red-500">*</span>
                </Label>
                <Select
                  value={recruiterValue}
                  onValueChange={(v) => { if (v) setValue("recruiter_id", v) }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn người phụ trách">
                      {(v) => {
                        if (typeof v !== "string" || !v) return null
                        return (
                          recruiters?.find((r) => String(r.id) === v)?.full_name ??
                          null
                        )
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(recruiters ?? []).map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.recruiter_id && (
                  <p className="text-xs text-red-500">{errors.recruiter_id.message}</p>
                )}
              </div>

              {/* Ngày mở đơn */}
              <div className="space-y-1">
                <Label htmlFor="opened_date">
                  Ngày mở đơn <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="opened_date"
                  placeholder="DD/MM/YYYY"
                  maxLength={10}
                  {...register("opened_date")}
                  onChange={(e) => setValue("opened_date", autoMaskVnDate(e.target.value))}
                />
                {errors.opened_date && (
                  <p className="text-xs text-red-500">{errors.opened_date.message}</p>
                )}
              </div>

              {/* Ngày dự kiến bắt đầu */}
              <div className="space-y-1">
                <Label htmlFor="expected_start_date">Ngày dự kiến bắt đầu làm việc</Label>
                <Input
                  id="expected_start_date"
                  placeholder="DD/MM/YYYY"
                  maxLength={10}
                  {...register("expected_start_date")}
                  onChange={(e) =>
                    setValue("expected_start_date", autoMaskVnDate(e.target.value))
                  }
                />
                {errors.expected_start_date && (
                  <p className="text-xs text-red-500">
                    {errors.expected_start_date.message}
                  </p>
                )}
              </div>

              {/* Trạng thái */}
              <div className="space-y-1">
                <Label>
                  Trạng thái <span className="text-red-500">*</span>
                </Label>
                <Select
                  value={statusValue}
                  onValueChange={(v) => { if (v) setValue("status", v as PositionStatus) }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn trạng thái">
                      {(v) => {
                        if (typeof v !== "string" || !v) return null
                        return STATUS_LABELS[v as PositionStatus] ?? null
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(STATUS_LABELS) as PositionStatus[]).map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Chi phí tuyển dụng */}
              <div className="space-y-1">
                <Label htmlFor="recruitment_cost">Chi phí tuyển dụng (VNĐ)</Label>
                <Input
                  id="recruitment_cost"
                  type="number"
                  min={0}
                  {...register("recruitment_cost")}
                  placeholder="0"
                />
                {errors.recruitment_cost && (
                  <p className="text-xs text-red-500">
                    {errors.recruitment_cost.message}
                  </p>
                )}
              </div>
            </div>

            {/* Mô tả công việc */}
            <div className="space-y-1">
              <Label htmlFor="description">Mô tả công việc</Label>
              <textarea
                id="description"
                {...register("description")}
                placeholder="Mô tả công việc..."
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>

            {/* Yêu cầu công việc */}
            <div className="space-y-1">
              <Label htmlFor="requirements">Yêu cầu công việc</Label>
              <textarea
                id="requirements"
                {...register("requirements")}
                placeholder="Yêu cầu công việc..."
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>
          </div>

          <DialogFooter className="shrink-0 pt-4 border-t pb-[env(safe-area-inset-bottom)]">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Huỷ
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Đang lưu..." : isEdit ? "Lưu thay đổi" : "Thêm vị trí"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Detail (view) dialog ────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="col-span-2 font-medium break-words">{value}</span>
    </div>
  )
}

function PositionDetailDialog({
  position,
  onClose,
}: {
  position: RecruitmentPosition | null
  onClose: () => void
}) {
  return (
    <Dialog open={position !== null} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="flex flex-col max-h-[90vh] max-w-[95vw] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Chi tiết vị trí tuyển dụng</DialogTitle>
        </DialogHeader>
        {position && (
          <div className="flex-1 min-h-0 overflow-y-auto divide-y px-1">
            <DetailRow label="Mã công việc" value={position.job_code} />
            <DetailRow label="Phòng ban" value={position.department} />
            <DetailRow label="Team" value={position.team || "—"} />
            <DetailRow label="Vị trí công việc" value={position.position_title} />
            <DetailRow label="Số lượng tuyển" value={position.headcount} />
            <DetailRow
              label="Người tuyển dụng"
              value={position.recruiter_name || "—"}
            />
            <DetailRow
              label="Ngày mở đơn"
              value={position.opened_date ? formatDate(position.opened_date) : "—"}
            />
            <DetailRow
              label="Ngày bắt đầu NV mới"
              value={
                position.expected_start_date
                  ? formatDate(position.expected_start_date)
                  : "—"
              }
            />
            <DetailRow
              label="Trạng thái"
              value={<StatusBadge status={position.status} />}
            />
            <DetailRow
              label="Chi phí tuyển dụng"
              value={
                position.recruitment_cost != null
                  ? `${formatCurrency(position.recruitment_cost)} ₫`
                  : "—"
              }
            />
            <DetailRow
              label="Mô tả công việc"
              value={
                position.description ? (
                  <span className="whitespace-pre-wrap">{position.description}</span>
                ) : (
                  "—"
                )
              }
            />
            <DetailRow
              label="Yêu cầu công việc"
              value={
                position.requirements ? (
                  <span className="whitespace-pre-wrap">{position.requirements}</span>
                ) : (
                  "—"
                )
              }
            />
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Sortable header ─────────────────────────────────────────────────────────

function SortHeader({
  label,
  field,
  sortBy,
  sortDir,
  onSort,
  className,
}: {
  label: string
  field: string
  sortBy?: string
  sortDir?: "asc" | "desc"
  onSort: (f: string) => void
  className?: string
}) {
  const active = sortBy === field
  const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th className={`whitespace-nowrap px-3 py-2 font-medium text-muted-foreground ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className="inline-flex items-center gap-1 select-none hover:text-foreground"
      >
        {label}
        <Icon className={`size-3.5 ${active ? "text-foreground" : "opacity-40"}`} />
      </button>
    </th>
  )
}

// ── Positions tab ────────────────────────────────────────────────────────────

const POSITION_SORT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["job_code", "Mã CV"],
  ["department", "Phòng ban"],
  ["position_title", "Vị trí công việc"],
  ["headcount", "Số lượng"],
  ["opened_date", "Ngày mở đơn"],
  ["status", "Trạng thái"],
  ["recruitment_cost", "Chi phí tuyển dụng"],
]

function positionSortLabel(value: string): string | null {
  const [field, dir] = value.split(":")
  const label = POSITION_SORT_FIELDS.find(([f]) => f === field)?.[1]
  return label ? `${label} (${dir === "asc" ? "tăng dần" : "giảm dần"})` : null
}

export function PositionsTab({
  canWrite,
  addOpen,
  onAddOpenChange,
}: {
  canWrite: boolean
  addOpen: boolean
  onAddOpenChange: (open: boolean) => void
}) {
  const [search, setSearch] = useState("")
  const [applied, setApplied] = useState<PositionFilters>({ page: 1 })
  const [editTarget, setEditTarget] = useState<RecruitmentPosition | null>(null)
  const [viewTarget, setViewTarget] = useState<RecruitmentPosition | null>(null)

  const { data, isLoading } = usePositions(applied)
  const departments = useDepartments()

  function applySearch() {
    setApplied((prev) => ({ ...prev, search: search.trim() || undefined, page: 1 }))
  }

  function patchFilter(patch: Partial<PositionFilters>) {
    setApplied((prev) => ({ ...prev, ...patch, page: 1 }))
  }

  function handleSort(field: string) {
    setApplied((prev) => ({
      ...prev,
      sort_by: field,
      sort_dir: prev.sort_by === field && prev.sort_dir === "asc" ? "desc" : "asc",
      page: 1,
    }))
  }

  function resetFilters() {
    setSearch("")
    setApplied({ page: 1 })
  }

  const hasFilters =
    search.trim() !== "" || !!applied.status || !!applied.department

  const total = data?.pagination.total ?? 0
  const totalPages = data?.pagination.total_pages ?? 1
  const currentPage = Math.min(applied.page ?? 1, totalPages)
  const startRow = total === 0 ? 0 : (currentPage - 1) * POSITION_PAGE_SIZE + 1
  const endRow = Math.min(currentPage * POSITION_PAGE_SIZE, total)
  const colCount = canWrite ? 11 : 10

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-muted/30 p-3">
        <div className="space-y-1 max-sm:min-w-0 max-sm:flex-1">
          <Label className="text-xs font-medium text-muted-foreground">Tìm kiếm</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8 w-56 max-sm:w-full"
              placeholder="Mã CV, vị trí, team..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applySearch()
              }}
            />
          </div>
        </div>

        <MobileFilterSheet
          activeCount={[applied.status, applied.department].filter(Boolean).length}
          onReset={resetFilters}
        >
        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground">Trạng thái</Label>
          <Select
            value={applied.status ?? ""}
            onValueChange={(v) => patchFilter({ status: v || undefined })}
          >
            <SelectTrigger className="w-36 max-sm:w-full">
              <SelectValue placeholder="Trạng thái">
                {(v) => {
                  if (typeof v !== "string" || !v) return "Tất cả"
                  return STATUS_LABELS[v as PositionStatus] ?? null
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Tất cả</SelectItem>
              {(Object.keys(STATUS_LABELS) as PositionStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground">Phòng ban</Label>
          <Select
            value={applied.department ?? ""}
            onValueChange={(v) => patchFilter({ department: v || undefined })}
          >
            <SelectTrigger className="w-44 max-sm:w-full">
              <SelectValue placeholder="Phòng ban">
                {(v) => (typeof v === "string" && v ? v : "Tất cả phòng ban")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Tất cả phòng ban</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:hidden">
          <Label className="text-xs font-medium text-muted-foreground">Sắp xếp</Label>
          <Select
            value={applied.sort_by ? `${applied.sort_by}:${applied.sort_dir ?? "asc"}` : ""}
            onValueChange={(v) => {
              const [field, dir] = (v ?? "").split(":")
              setApplied((prev) => ({
                ...prev,
                sort_by: field || undefined,
                sort_dir: field ? (dir === "desc" ? "desc" : "asc") : undefined,
                page: 1,
              }))
            }}
          >
            <SelectTrigger className="max-sm:w-full">
              <SelectValue placeholder="Sắp xếp">
                {(v) => {
                  if (typeof v !== "string" || !v) return "Mặc định"
                  return positionSortLabel(v)
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Mặc định</SelectItem>
              {POSITION_SORT_FIELDS.flatMap(([f]) => [`${f}:asc`, `${f}:desc`]).map((o) => (
                <SelectItem key={o} value={o}>
                  {positionSortLabel(o)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button type="button" variant="outline" onClick={resetFilters} disabled={!hasFilters} className="max-sm:hidden">
          Đặt lại
        </Button>
        </MobileFilterSheet>
      </div>

      {/* Table */}
      <ShellResponsiveList
        table={
      <div className="overflow-x-auto rounded-2xl border shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <table className="w-full min-w-[1000px] text-sm [&_td]:whitespace-nowrap">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">#</th>
              <SortHeader label="Mã CV" field="job_code" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} />
              <SortHeader label="Phòng ban" field="department" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} />
              <SortHeader label="Vị trí công việc" field="position_title" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} />
              <SortHeader label="Số lượng" field="headcount" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} className="text-right [&>button]:flex-row-reverse" />
              <SortHeader label="Ngày mở đơn" field="opened_date" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} />
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Người tuyển dụng</th>
              <SortHeader label="Trạng thái" field="status" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} />
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Ngày bắt đầu NV mới</th>
              <SortHeader label="Chi phí tuyển dụng" field="recruitment_cost" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} className="text-right [&>button]:flex-row-reverse" />
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td colSpan={colCount} className="py-8 text-center text-muted-foreground">
                  Đang tải...
                </td>
              </tr>
            )}
            {!isLoading && data?.data.length === 0 && (
              <tr>
                <td colSpan={colCount} className="py-4">
                  <EmptyState
                    icon={ClipboardList}
                    message="Chưa có vị trí tuyển dụng nào."
                  />
                </td>
              </tr>
            )}
            {data?.data.map((p, idx) => (
              <tr key={p.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-3 py-2 text-muted-foreground">{startRow + idx}</td>
                <td className="px-3 py-2 font-medium">{p.job_code}</td>
                <td className="px-3 py-2">{p.department}</td>
                <td className="px-3 py-2">{p.position_title}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.headcount}</td>
                <td className="px-3 py-2">
                  {p.opened_date ? formatDate(p.opened_date) : "—"}
                </td>
                <td className="px-3 py-2">{p.recruiter_name || "—"}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={p.status} />
                </td>
                <td className="px-3 py-2">
                  {p.expected_start_date ? formatDate(p.expected_start_date) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {p.recruitment_cost != null
                    ? `${formatCurrency(p.recruitment_cost)} ₫`
                    : "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Xem chi tiết"
                      onClick={() => setViewTarget(p)}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Chỉnh sửa"
                        onClick={() => setEditTarget(p)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
        }
        cards={
          isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Đang tải...</p>
          ) : data?.data.length === 0 ? (
            <EmptyState icon={ClipboardList} message="Chưa có vị trí tuyển dụng nào." />
          ) : (
            <div className="space-y-3">
              {data?.data.map((p) => (
                <ShellListCard key={p.id} onClick={() => setViewTarget(p)}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{p.position_title}</p>
                      <p className="text-xs text-muted-foreground">{p.job_code}</p>
                    </div>
                    <StatusBadge status={p.status} />
                    {canWrite && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Thao tác khác"
                              onClick={(e) => e.stopPropagation()}
                            />
                          }
                        >
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setViewTarget(p)}>
                            <Eye /> Xem chi tiết
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setEditTarget(p)}>
                            <Pencil /> Chỉnh sửa
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  <ShellListCardRow label="Phòng ban" value={p.department} />
                  <ShellListCardRow label="Số lượng" value={p.headcount} />
                  <ShellListCardRow label="Người tuyển dụng" value={p.recruiter_name || "—"} />
                  <ShellListCardRow label="Ngày mở đơn" value={p.opened_date ? formatDate(p.opened_date) : "—"} />
                  <ShellListCardRow
                    label="Ngày bắt đầu NV mới"
                    value={p.expected_start_date ? formatDate(p.expected_start_date) : "—"}
                  />
                  <ShellListCardRow
                    label="Chi phí tuyển dụng"
                    value={p.recruitment_cost != null ? `${formatCurrency(p.recruitment_cost)} ₫` : "—"}
                  />
                </ShellListCard>
              ))}
            </div>
          )
        }
      />

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total === 0
            ? "Không có kết quả"
            : `Hiển thị ${startRow}–${endRow} trong tổng ${total} vị trí`}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 max-sm:min-h-11 max-sm:min-w-11"
            disabled={currentPage <= 1}
            onClick={() => setApplied((prev) => ({ ...prev, page: currentPage - 1 }))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-2">
            {currentPage} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 max-sm:min-h-11 max-sm:min-w-11"
            disabled={currentPage >= totalPages}
            onClick={() => setApplied((prev) => ({ ...prev, page: currentPage + 1 }))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Dialogs */}
      <PositionDialog open={addOpen} onClose={() => onAddOpenChange(false)} target={null} />
      <PositionDialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        target={editTarget}
      />
      <PositionDetailDialog position={viewTarget} onClose={() => setViewTarget(null)} />
    </div>
  )
}
