"use client"

import { PermissionGate } from "@/lib/rbac"
import { useState, useEffect, useRef } from "react"
import { useForm } from "react-hook-form"
import type { Resolver } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import {
  UserPlus,
  Plus,
  BarChart2,
  Pencil,
  Trash2,
  Search,
  ChevronLeft,
  ChevronRight,
  UserSearch,
  Briefcase,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  MoreHorizontal,
} from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ShellTabs, ShellTabsList, ShellTabsTrigger } from "@/components/app-shell/tabs"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { ShellTableEmptyRow } from "@/components/app-shell/table-empty-row"

import { usePermissions } from "@/lib/rbac"
import { formatDate, formatCurrency, autoMaskVnDate, parseVnDate, isoToVnDate, firstDayOfMonthVn, lastDayOfMonthVn } from "@/lib/format"

import {
  DonutChart,
  type DonutSlice,
} from "@/app/(dashboard)/reports/_components/charts/donut-chart"

import {
  useCandidates,
  useCreateCandidate,
  useUpdateCandidate,
  useDeleteCandidate,
  useRecruitmentStats,
  useRecruiters,
  RECRUITMENT_PAGE_SIZE,
  type Candidate,
  type CandidateFilters,
  type CandidateStage,
  type CandidateDecision,
  type CandidateGender,
  type RecruitmentType,
  type CreateCandidateDto,
} from "@/hooks/use-recruitment"
import { PositionsTab } from "./_components/positions-tab"

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
import {
  categoryColor,
  CHART_NEUTRAL,
  CHART_STATUS,
} from "@/components/app-shell/charts/chart-colors"
import { ShellRateCard, ShellShareCard } from "@/components/app-shell/charts/screen-charts"
import { formatChartNumber } from "@/components/app-shell/charts/chart-data"
import { Skeleton } from "@/components/ui/skeleton"

// ── Constants ──────────────────────────────────────────────────────────────

const STAGE_LABELS: Record<CandidateStage, string> = {
  applied: "Đã ứng tuyển",
  sent_manager: "Gửi quản lý",
  interview: "Phỏng vấn",
  test: "Kiểm tra",
  offer: "Đề nghị việc",
  hired: "Đã tuyển",
}

const STAGE_BADGE_COLOR: Record<CandidateStage, string> = {
  applied: "bg-gray-100 text-gray-700",
  sent_manager: "bg-amber-100 text-amber-700",
  interview: "bg-blue-100 text-blue-700",
  test: "bg-purple-100 text-purple-700",
  offer: "bg-green-100 text-green-700",
  hired: "bg-emerald-100 text-emerald-700",
}

/**
 * 6 giai đoạn tuyển dụng — DANH MỤC, dùng đúng 6 màu danh mục.
 *
 * Không dùng màu TRẠNG THÁI (`CHART_STATUS`) làm màu series — hai lát kề nhau
 * trong cùng một vành khuyên phải đủ tương phản (xem `chart-colors.ts`).
 */
const STAGE_DONUT_COLOR: Record<CandidateStage, string> = {
  applied: categoryColor(0),
  sent_manager: categoryColor(1),
  interview: categoryColor(2),
  test: categoryColor(3),
  offer: categoryColor(4),
  hired: categoryColor(5),
}

const DECISION_LABELS: Record<CandidateDecision, string> = {
  pending: "Đang xét",
  hired: "Tuyển dụng",
  rejected: "Từ chối",
}

const DECISION_BADGE_COLOR: Record<CandidateDecision, string> = {
  pending: "bg-amber-100 text-amber-700",
  hired: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
}

const DECISION_DONUT_COLOR: Record<CandidateDecision, string> = {
  pending: categoryColor(1),
  hired: CHART_STATUS.good,
  rejected: CHART_STATUS.bad,
}

// Màu nền ô (td) cho cột Giai đoạn / Quyết định — nhạt hơn pill badge (bg-X-50)
// để badge vẫn nổi trên nền ô.
const STAGE_CELL_BG: Record<CandidateStage, string> = {
  applied: "bg-gray-50",
  sent_manager: "bg-amber-50",
  interview: "bg-blue-50",
  test: "bg-purple-50",
  offer: "bg-green-50",
  hired: "bg-emerald-50",
}

const DECISION_CELL_BG: Record<CandidateDecision, string> = {
  pending: "bg-amber-50",
  hired: "bg-green-50",
  rejected: "bg-red-50",
}

const TYPE_LABELS: Record<RecruitmentType, string> = {
  internal: "Nội bộ",
  external: "Bên ngoài",
}

const GENDER_LABELS: Record<CandidateGender, string> = {
  M: "Nam",
  F: "Nữ",
}

const TYPE_BADGE_COLOR: Record<RecruitmentType, string> = {
  internal: "bg-indigo-100 text-indigo-700",
  external: "bg-cyan-100 text-cyan-700",
}

const SOURCE_OPTIONS = ["Zalo", "Facebook", "Giới thiệu", "Tuyển dụng nội bộ", "Khác"]

/**
 * Màu theo NGUỒN ứng viên — danh mục thuần.
 *
 * Không dùng màu trạng thái (đỏ/xanh) cho nguồn, và không lặp màu giữa 2 nguồn.
 * Bảng dài đúng bằng `SOURCE_OPTIONS` và KẸP ở màu cuối — nguồn ngoài danh sách
 * đi màu xám "Khác".
 */
const SOURCE_COLORS = SOURCE_OPTIONS.map((_, i) => categoryColor(i))

// Màu chấm cho nguồn theo vị trí trong SOURCE_OPTIONS (nguồn lạ → xám).
function sourceColor(src: string): string {
  const i = SOURCE_OPTIONS.indexOf(src)
  return i >= 0 ? SOURCE_COLORS[Math.min(i, SOURCE_COLORS.length - 1)] : CHART_NEUTRAL
}

// Bảng màu pastel cho avatar chữ cái — chọn ổn định theo tên.
const AVATAR_PALETTE = [
  "bg-rose-100 text-rose-700",
  "bg-amber-100 text-amber-700",
  "bg-emerald-100 text-emerald-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-pink-100 text-pink-700",
  "bg-teal-100 text-teal-700",
  "bg-orange-100 text-orange-700",
]
function avatarClass(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

// ── Zod schema ─────────────────────────────────────────────────────────────

const candidateSchema = z.object({
  full_name: z.string().min(1, "Họ tên không được để trống"),
  phone: z
    .string()
    .min(1, "Số điện thoại không được để trống")
    .regex(/^(0|\+84)\d{9}$/, "Số điện thoại không hợp lệ"),
  email: z.string().email("Email không hợp lệ").optional().or(z.literal("")),
  position: z.string().optional().or(z.literal("")),
  department: z.string().optional().or(z.literal("")),
  source: z.string().optional().or(z.literal("")),
  stage: z.enum(["applied", "sent_manager", "interview", "test", "offer", "hired"]),
  decision: z.enum(["pending", "hired", "rejected"]),
  recruitment_type: z.enum(["internal", "external"]),
  applied_date: z
    .string()
    .min(1, "Ngày ứng tuyển không được để trống")
    .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Định dạng ngày DD/MM/YYYY"),
  cost: z.string().optional(),
  note: z.string().optional().or(z.literal("")),
  gender: z.enum(["M", "F"]).optional().or(z.literal("")),
  interview_date: z
    .string()
    .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Định dạng ngày DD/MM/YYYY")
    .optional()
    .or(z.literal("")),
  interview_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Định dạng giờ HH:mm")
    .optional()
    .or(z.literal("")),
  recruiter_id: z.string().optional(),
})

type CandidateFormValues = z.infer<typeof candidateSchema>

// ── Helpers ────────────────────────────────────────────────────────────────

function toISODate(vnDate: string): string {
  const iso = parseVnDate(vnDate)
  if (!iso) return vnDate
  // Cột @db.Date (applied_date / interview_date) — dùng UTC-midnight để tránh lệch
  // ngày: "+07:00" làm timestamp lùi về 17:00 hôm trước → DATE truncate UTC mất 1 ngày.
  // formatDate (UTC-midnight + 7h = vẫn cùng ngày VN) đọc lại ra đúng ngày.
  return new Date(iso + "T00:00:00.000Z").toISOString()
}

function toDtoDate(values: CandidateFormValues): CreateCandidateDto {
  return {
    full_name: values.full_name,
    phone: values.phone,
    email: values.email || null,
    position: values.position || null,
    department: values.department || null,
    source: values.source || null,
    stage: values.stage,
    decision: values.decision,
    recruitment_type: values.recruitment_type,
    applied_date: toISODate(values.applied_date),
    cost: values.cost === "" || values.cost === undefined ? null : Number(values.cost),
    note: values.note || null,
    gender: values.gender || null,
    interview_date: values.interview_date ? toISODate(values.interview_date) : null,
    interview_time: values.interview_time || null,
    recruiter_id: values.recruiter_id ? Number(values.recruiter_id) : null,
  }
}

function toDefaultValues(candidate: Candidate | null): CandidateFormValues {
  if (!candidate) {
    return {
      full_name: "",
      phone: "",
      email: "",
      position: "",
      department: "",
      source: "",
      stage: "applied",
      decision: "pending",
      recruitment_type: "external",
      applied_date: "",
      cost: "",
      note: "",
      gender: "",
      interview_date: "",
      interview_time: "",
      recruiter_id: "",
    }
  }
  return {
    full_name: candidate.full_name,
    phone: candidate.phone,
    email: candidate.email ?? "",
    position: candidate.position ?? "",
    department: candidate.department ?? "",
    source: candidate.source ?? "",
    stage: candidate.stage,
    decision: candidate.decision,
    recruitment_type: candidate.recruitment_type,
    applied_date: formatDate(candidate.applied_date),
    cost: candidate.cost != null ? String(candidate.cost) : "",
    note: candidate.note ?? "",
    gender: candidate.gender ?? "",
    interview_date: candidate.interview_date ? formatDate(candidate.interview_date) : "",
    interview_time: candidate.interview_time ?? "",
    recruiter_id: candidate.recruiter_id != null ? String(candidate.recruiter_id) : "",
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StageBadge({ stage }: { stage: CandidateStage }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_BADGE_COLOR[stage]}`}
    >
      {STAGE_LABELS[stage]}
    </span>
  )
}

function DecisionBadge({ decision }: { decision: CandidateDecision }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${DECISION_BADGE_COLOR[decision]}`}
    >
      {DECISION_LABELS[decision]}
    </span>
  )
}

function TypeBadge({ type }: { type: RecruitmentType }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_BADGE_COLOR[type]}`}
    >
      {TYPE_LABELS[type]}
    </span>
  )
}

function SourceTag({ source }: { source: string | null }) {
  if (!source) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: sourceColor(source) }}
        aria-hidden
      />
      {source}
    </span>
  )
}

function NameAvatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?"
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${avatarClass(name)}`}
      aria-hidden
    >
      {initial}
    </span>
  )
}

// ── Candidate form dialog ──────────────────────────────────────────────────

interface CandidateDialogProps {
  open: boolean
  onClose: () => void
  target: Candidate | null
}

function CandidateDialog({ open, onClose, target }: CandidateDialogProps) {
  const isEdit = target !== null
  const createMutation = useCreateCandidate()
  const updateMutation = useUpdateCandidate(target?.id ?? 0)
  const { data: recruiters } = useRecruiters()

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CandidateFormValues>({
    resolver: zodResolver(candidateSchema) as Resolver<CandidateFormValues>,
    defaultValues: toDefaultValues(target),
  })

  const stageValue = watch("stage")
  const decisionValue = watch("decision")
  const typeValue = watch("recruitment_type")
  const genderValue = watch("gender")
  const recruiterValue = watch("recruiter_id")

  function handleOpenChange(next: boolean) {
    if (!next) {
      reset(toDefaultValues(null))
      onClose()
    }
  }

  // Reset form khi MỞ dialog hoặc đổi ứng viên. PHẢI nằm trong useEffect — KHÔNG gọi trong
  // thân render (reset() = setState lúc render → React "Too many re-renders").
  // deps [open, target?.id] ổn định cho cả Thêm + Sửa.
  useEffect(() => {
    if (open) reset(toDefaultValues(target))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.id])

  async function onSubmit(values: CandidateFormValues) {
    const dto = toDtoDate(values)
    try {
      if (isEdit) {
        await updateMutation.mutateAsync(dto)
        toast.success("Cập nhật ứng viên thành công")
      } else {
        await createMutation.mutateAsync(dto)
        toast.success("Thêm ứng viên thành công")
      }
      reset(toDefaultValues(null))
      onClose()
    } catch {
      toast.error(isEdit ? "Cập nhật thất bại" : "Thêm ứng viên thất bại")
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex flex-col max-h-[90vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa ứng viên" : "Thêm ứng viên"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto space-y-4 px-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Họ tên */}
            <div className="space-y-1">
              <Label htmlFor="full_name">
                Họ tên <span className="text-red-500">*</span>
              </Label>
              <Input id="full_name" {...register("full_name")} placeholder="Nguyễn Văn A" />
              {errors.full_name && (
                <p className="text-xs text-red-500">{errors.full_name.message}</p>
              )}
            </div>

            {/* Số điện thoại */}
            <div className="space-y-1">
              <Label htmlFor="phone">
                Số điện thoại <span className="text-red-500">*</span>
              </Label>
              <Input id="phone" {...register("phone")} placeholder="0900000002" />
              {errors.phone && (
                <p className="text-xs text-red-500">{errors.phone.message}</p>
              )}
            </div>

            {/* Email */}
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input id="email" {...register("email")} placeholder="email@example.com" />
              {errors.email && (
                <p className="text-xs text-red-500">{errors.email.message}</p>
              )}
            </div>

            {/* Vị trí */}
            <div className="space-y-1">
              <Label htmlFor="position">Vị trí</Label>
              <Input id="position" {...register("position")} placeholder="Nhân viên kinh doanh" />
            </div>

            {/* Phòng ban */}
            <div className="space-y-1">
              <Label htmlFor="department">Phòng ban</Label>
              <Input id="department" {...register("department")} placeholder="Kinh doanh" />
            </div>

            {/* Nguồn */}
            <div className="space-y-1">
              <Label>Nguồn</Label>
              <Select
                value={watch("source") || ""}
                onValueChange={(v) => setValue("source", v ?? undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn nguồn">
                    {(v) => {
                      if (!v || typeof v !== "string") return null
                      return v
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">-- Không chọn --</SelectItem>
                  {SOURCE_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Giai đoạn */}
            <div className="space-y-1">
              <Label>
                Giai đoạn <span className="text-red-500">*</span>
              </Label>
              <Select
                value={stageValue}
                onValueChange={(v) => { if (v) setValue("stage", v as CandidateStage) }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn giai đoạn">
                    {(v) => {
                      if (!v || typeof v !== "string") return null
                      return STAGE_LABELS[v as CandidateStage] ?? null
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(STAGE_LABELS) as CandidateStage[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.stage && (
                <p className="text-xs text-red-500">{errors.stage.message}</p>
              )}
            </div>

            {/* Quyết định */}
            <div className="space-y-1">
              <Label>
                Quyết định <span className="text-red-500">*</span>
              </Label>
              <Select
                value={decisionValue}
                onValueChange={(v) => { if (v) setValue("decision", v as CandidateDecision) }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn quyết định">
                    {(v) => {
                      if (!v || typeof v !== "string") return null
                      return DECISION_LABELS[v as CandidateDecision] ?? null
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(DECISION_LABELS) as CandidateDecision[]).map((d) => (
                    <SelectItem key={d} value={d}>
                      {DECISION_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Loại hình */}
            <div className="space-y-1">
              <Label>
                Loại hình <span className="text-red-500">*</span>
              </Label>
              <Select
                value={typeValue}
                onValueChange={(v) => { if (v) setValue("recruitment_type", v as RecruitmentType) }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn loại hình">
                    {(v) => {
                      if (!v || typeof v !== "string") return null
                      return TYPE_LABELS[v as RecruitmentType] ?? null
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_LABELS) as RecruitmentType[]).map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Ngày ứng tuyển */}
            <div className="space-y-1">
              <Label htmlFor="applied_date">
                Ngày ứng tuyển <span className="text-red-500">*</span>
              </Label>
              <Input
                id="applied_date"
                placeholder="DD/MM/YYYY"
                maxLength={10}
                {...register("applied_date")}
                onChange={(e) => {
                  const masked = autoMaskVnDate(e.target.value)
                  setValue("applied_date", masked)
                }}
              />
              {errors.applied_date && (
                <p className="text-xs text-red-500">{errors.applied_date.message}</p>
              )}
            </div>

            {/* Chi phí */}
            <div className="space-y-1">
              <Label htmlFor="cost">Chi phí tuyển dụng (VNĐ)</Label>
              <Input
                id="cost"
                type="number"
                min={0}
                {...register("cost")}
                placeholder="0"
              />
              {errors.cost && (
                <p className="text-xs text-red-500">{errors.cost.message}</p>
              )}
            </div>

            {/* Giới tính */}
            <div className="space-y-1">
              <Label>Giới tính</Label>
              <Select
                value={genderValue || ""}
                onValueChange={(v) => setValue("gender", (v ?? "") as CandidateGender | "")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn giới tính">
                    {(v) => {
                      if (typeof v !== "string" || !v) return null
                      return GENDER_LABELS[v as CandidateGender] ?? null
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">-- Không chọn --</SelectItem>
                  {(Object.keys(GENDER_LABELS) as CandidateGender[]).map((g) => (
                    <SelectItem key={g} value={g}>
                      {GENDER_LABELS[g]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Người tuyển dụng phụ trách */}
            <div className="space-y-1">
              <Label>Người tuyển dụng phụ trách</Label>
              <Select
                value={recruiterValue || ""}
                onValueChange={(v) => setValue("recruiter_id", v ?? "")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn người phụ trách">
                    {(v) => {
                      if (typeof v !== "string" || !v) return null
                      return recruiters?.find((r) => String(r.id) === v)?.full_name ?? null
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">-- Không chọn --</SelectItem>
                  {(recruiters ?? []).map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Ngày phỏng vấn */}
            <div className="space-y-1">
              <Label htmlFor="interview_date">Ngày phỏng vấn</Label>
              <Input
                id="interview_date"
                placeholder="DD/MM/YYYY"
                maxLength={10}
                {...register("interview_date")}
                onChange={(e) => setValue("interview_date", autoMaskVnDate(e.target.value))}
              />
              {errors.interview_date && (
                <p className="text-xs text-red-500">{errors.interview_date.message}</p>
              )}
            </div>

            {/* Giờ phỏng vấn */}
            <div className="space-y-1">
              <Label htmlFor="interview_time">Giờ phỏng vấn</Label>
              <Input
                id="interview_time"
                placeholder="HH:mm (vd 09:30)"
                maxLength={5}
                {...register("interview_time")}
              />
              {errors.interview_time && (
                <p className="text-xs text-red-500">{errors.interview_time.message}</p>
              )}
            </div>
          </div>

          {/* Ghi chú */}
          <div className="space-y-1">
            <Label htmlFor="note">Ghi chú</Label>
            <textarea
              id="note"
              {...register("note")}
              placeholder="Ghi chú thêm..."
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
          </div>

          <DialogFooter className="shrink-0 pt-4 border-t pb-[env(safe-area-inset-bottom)]">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Huỷ
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Đang lưu..." : isEdit ? "Lưu thay đổi" : "Thêm ứng viên"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Stats dialog ───────────────────────────────────────────────────────────

interface StatsDialogProps {
  open: boolean
  onClose: () => void
}

function StatsDialog({ open, onClose }: StatsDialogProps) {
  // Mặc định: đầu tháng → cuối tháng hiện tại.
  const monthStart = firstDayOfMonthVn()
  const monthEnd = lastDayOfMonthVn()
  const [dateFrom, setDateFrom] = useState(() => isoToVnDate(monthStart))
  const [dateTo, setDateTo] = useState(() => isoToVnDate(monthEnd))
  const [queryFrom, setQueryFrom] = useState(() => new Date(monthStart + "T00:00:00+07:00").toISOString())
  const [queryTo, setQueryTo] = useState(() => new Date(monthEnd + "T23:59:59.999+07:00").toISOString())

  const { data: stats, isLoading } = useRecruitmentStats(
    queryFrom || undefined,
    queryTo || undefined,
  )

  function handleApplyFilter() {
    const from = parseVnDate(dateFrom)
    const to = parseVnDate(dateTo)
    setQueryFrom(from ? new Date(from + "T00:00:00+07:00").toISOString() : "")
    // Bao trọn ngày cuối (end-of-day) để không sót hồ sơ nộp trong ngày.
    setQueryTo(to ? new Date(to + "T23:59:59.999+07:00").toISOString() : "")
  }

  function handleResetFilter() {
    setDateFrom(isoToVnDate(monthStart))
    setDateTo(isoToVnDate(monthEnd))
    setQueryFrom(new Date(monthStart + "T00:00:00+07:00").toISOString())
    setQueryTo(new Date(monthEnd + "T23:59:59.999+07:00").toISOString())
  }

  const stageSlices: DonutSlice[] = (Object.keys(STAGE_LABELS) as CandidateStage[]).map((s) => ({
    key: s,
    label: STAGE_LABELS[s],
    color: STAGE_DONUT_COLOR[s],
    value: stats?.by_stage?.[s] ?? 0,
  }))

  const decisionSlices: DonutSlice[] = (
    Object.keys(DECISION_LABELS) as CandidateDecision[]
  ).map((d) => ({
    key: d,
    label: DECISION_LABELS[d],
    color: DECISION_DONUT_COLOR[d],
    value: stats?.by_decision?.[d] ?? 0,
  }))

  const sourceSlices: DonutSlice[] = Object.entries(stats?.by_source ?? {}).map(
    ([src, count]) => ({
      key: src,
      label: src,
      color: sourceColor(src), // cùng bảng màu với cột Nguồn trong bảng (nguồn lạ = xám)
      value: count,
    }),
  )

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-[95vw] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Thống kê tuyển dụng</DialogTitle>
        </DialogHeader>

        {/* Filter ngày */}
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="stats-from">Từ ngày</Label>
            <Input
              id="stats-from"
              placeholder="DD/MM/YYYY"
              maxLength={10}
              value={dateFrom}
              onChange={(e) => setDateFrom(autoMaskVnDate(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="stats-to">Đến ngày</Label>
            <Input
              id="stats-to"
              placeholder="DD/MM/YYYY"
              maxLength={10}
              value={dateTo}
              onChange={(e) => setDateTo(autoMaskVnDate(e.target.value))}
            />
          </div>
          <Button type="button" onClick={handleResetFilter} variant="ghost" size="sm">
            Đặt lại
          </Button>
          <Button type="button" onClick={handleApplyFilter} variant="outline" size="sm">
            Lọc
          </Button>
        </div>

        {/* Thống kê trong hộp thoại dùng cùng thẻ trình bày với trang chính, không dùng ô số trần. */}
        {stats && (
          <ShellShareCard
            title="Ứng viên theo quyết định"
            subtitle={`tổng ${formatChartNumber(stats.total)} ứng viên · chi phí ${formatCurrency(stats.total_cost)}`}
            total={stats.total}
            parts={[
              { label: "Đã tuyển", value: stats.by_decision?.hired ?? 0 },
              { label: "Đang xét", value: stats.by_decision?.pending ?? 0 },
              { label: "Từ chối", value: stats.by_decision?.rejected ?? 0 },
            ]}
            unit="ứng viên"
            emptyText="Chưa có ứng viên nào trong khoảng đang lọc"
          />
        )}

        {isLoading && (
          <p className="text-center text-sm text-muted-foreground">Đang tải...</p>
        )}

        {/* Charts */}
        {stats && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <p className="mb-2 text-center text-sm font-medium">Theo giai đoạn</p>
              <DonutChart slices={stageSlices} size={160} innerLabel="Giai đoạn" />
            </div>
            <div>
              <p className="mb-2 text-center text-sm font-medium">Theo quyết định</p>
              <DonutChart slices={decisionSlices} size={160} innerLabel="Quyết định" />
            </div>
            <div>
              <p className="mb-2 text-center text-sm font-medium">Theo nguồn</p>
              <DonutChart slices={sourceSlices} size={160} innerLabel="Nguồn" />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" onClick={onClose} variant="outline">
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────

// Bộ lọc dạng "nháp" — giữ giá trị người dùng đang chọn TRƯỚC khi bấm "Lọc"
interface DraftFilters {
  search: string
  stage: string
  decision: string
  recruitment_type: string
  source: string
}

const EMPTY_DRAFT: DraftFilters = {
  search: "",
  stage: "",
  decision: "",
  recruitment_type: "",
  source: "",
}

// Sắp xếp trên điện thoại (thẻ không có header cột) — cùng field với SortHeader.
const SORT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["full_name", "Họ tên"],
  ["source", "Nguồn"],
  ["stage", "Giai đoạn"],
  ["decision", "Quyết định"],
  ["applied_date", "Ngày ứng tuyển"],
]

function sortOptionLabel(value: string): string | null {
  const [field, dir] = value.split(":")
  const label = SORT_FIELDS.find(([f]) => f === field)?.[1]
  return label ? `${label} (${dir === "asc" ? "tăng dần" : "giảm dần"})` : null
}

// Header cột có thể bấm để sắp xếp (server-side). Icon: trung tính / lên / xuống.
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
        className="relative after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] pointer-coarse:sm:after:-inset-y-3 inline-flex items-center gap-1 select-none hover:text-foreground"
      >
        {label}
        <Icon className={`size-3.5 ${active ? "text-foreground" : "opacity-40"}`} />
      </button>
    </th>
  )
}

function CandidatesTab({
  addOpen,
  onAddOpenChange,
  statsOpen,
  onStatsOpenChange,
}: {
  addOpen: boolean
  onAddOpenChange: (open: boolean) => void
  statsOpen: boolean
  onStatsOpenChange: (open: boolean) => void
}) {
  const canWrite = usePermissions().can("recruitment.manage")

  // Bộ lọc "nháp" (draft) chỉ áp dụng khi bấm "Lọc"
  const [draft, setDraft] = useState<DraftFilters>(EMPTY_DRAFT)
  const [applied, setApplied] = useState<CandidateFilters>({ page: 1 })
  const [editTarget, setEditTarget] = useState<Candidate | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Candidate | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    },
    [],
  )

  const { data, isLoading } = useCandidates(applied)
  // Thống kê tổng (toàn thời gian) cho dải thẻ KPI đầu trang.
  const {
    data: pageStats,
    isLoading: pageStatsLoading,
    isError: pageStatsError,
  } = useRecruitmentStats()
  const deleteCandidate = useDeleteCandidate(deleteTarget?.id ?? 0)

  // Áp dụng 1 bộ lọc cụ thể → luôn về trang đầu.
  function applyFrom(f: DraftFilters) {
    // Giữ cột đang sắp xếp khi đổi bộ lọc/tìm kiếm (chỉ "Đặt lại" mới xoá).
    setApplied((prev) => ({
      page: 1,
      sort_by: prev.sort_by,
      sort_dir: prev.sort_dir,
      search: f.search.trim() || undefined,
      stage: f.stage || undefined,
      decision: f.decision || undefined,
      recruitment_type: f.recruitment_type || undefined,
      source: f.source || undefined,
    }))
  }

  // Sắp xếp theo cột (server-side) → về trang đầu. Click cùng cột để đảo chiều.
  function handleSort(field: string) {
    setApplied((prev) => ({
      ...prev,
      sort_by: field,
      sort_dir: prev.sort_by === field && prev.sort_dir === "asc" ? "desc" : "asc",
      page: 1,
    }))
  }
  // Enter trên ô tìm kiếm → áp dụng ngay (không chờ debounce).
  function applyFilters() {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    applyFrom(draft)
  }
  // Ô tìm kiếm tự áp dụng (debounce 400ms — tránh gọi BE mỗi ký tự).
  function onSearchChange(value: string) {
    const next = { ...draft, search: value }
    setDraft(next)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => applyFrom(next), 400)
  }

  // Dropdown áp dụng NGAY khi chọn.
  function patchAndApply(patch: Partial<DraftFilters>) {
    const next = { ...draft, ...patch }
    setDraft(next)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    applyFrom(next)
  }

  // Xoá toàn bộ điều kiện lọc + về trang đầu
  function resetFilters() {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    setDraft(EMPTY_DRAFT)
    setApplied({ page: 1 })
  }

  const hasFilters =
    draft.search.trim() !== "" ||
    draft.stage !== "" ||
    draft.decision !== "" ||
    draft.recruitment_type !== "" ||
    draft.source !== ""

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteCandidate.mutateAsync()
      toast.success("Đã xoá ứng viên")
    } catch {
      toast.error("Xoá thất bại")
    } finally {
      setDeleteTarget(null)
    }
  }

  const total = data?.pagination.total ?? 0
  const totalPages = data?.pagination.total_pages ?? 1
  const currentPage = Math.min(applied.page ?? 1, totalPages)
  const startRow = total === 0 ? 0 : (currentPage - 1) * RECRUITMENT_PAGE_SIZE + 1
  const endRow = Math.min(currentPage * RECRUITMENT_PAGE_SIZE, total)

  return (
    <div className="flex flex-col gap-4">
      {/* KPI tổng quan */}
      {pageStatsLoading ? (
        <Skeleton className="h-64 rounded-2xl max-sm:order-last" />
      ) : pageStatsError || !pageStats ? (
        <p className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 max-sm:order-last text-center text-sm text-destructive">
          Không tải được thống kê tuyển dụng. Danh sách ứng viên bên dưới vẫn
          đọc được — thử tải lại trang.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 max-sm:order-last">
          {/* 3 quyết định (đã tuyển / đang xét / từ chối) cộng lại ĐÚNG bằng
              tổng ứng viên ⇒ vành khuyên hợp lệ. "Chi phí tuyển dụng" KHÔNG vào
              đó — khác đơn vị (tiền, không phải người); nó ở bảng của thẻ. */}
          <ShellShareCard
            title="Ứng viên theo quyết định"
            subtitle={`tổng ${formatChartNumber(pageStats.total)} ứng viên · chi phí ${formatCurrency(pageStats.total_cost)}`}
            total={pageStats.total}
            parts={[
              { label: "Đã tuyển", value: pageStats.by_decision?.hired ?? 0 },
              { label: "Đang xét", value: pageStats.by_decision?.pending ?? 0 },
              { label: "Từ chối", value: pageStats.by_decision?.rejected ?? 0 },
            ]}
            unit="ứng viên"
            emptyText="Chưa có ứng viên nào"
          />
          <ShellRateCard
            title="Tỉ lệ tuyển thành công"
            subtitle="số đã tuyển trên tổng ứng viên"
            label="Đã tuyển"
            numerator={pageStats.by_decision?.hired ?? 0}
            denominator={pageStats.total}
            unitText="ứng viên"
            extraRows={[
              ["Chi phí tuyển dụng", formatCurrency(pageStats.total_cost)],
              [
                // ⚠️ TỬ là chi phí của MỌI ứng viên (kể cả người bị từ chối),
                // không riêng người được tuyển — đây là "tốn bao nhiêu để
                // tuyển được 1 người", KHÔNG phải "chi cho 1 người".
                "Chi phí mỗi người tuyển được",
                (pageStats.by_decision?.hired ?? 0) > 0
                  ? formatCurrency(
                      pageStats.total_cost / (pageStats.by_decision?.hired ?? 1),
                    )
                  : "—",
              ],
            ]}
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-muted/30 p-3">
        <div className="space-y-1 max-sm:min-w-0 max-sm:flex-1">
          <Label className="text-xs font-medium text-muted-foreground">Tìm kiếm</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8 w-52 max-sm:w-full"
              placeholder="Tìm tên, SĐT..."
              value={draft.search}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyFilters()
              }}
            />
          </div>
        </div>

        <MobileFilterSheet
          activeCount={
            [draft.stage, draft.decision, draft.recruitment_type, draft.source].filter((v) => v !== "").length
          }
          onReset={resetFilters}
        >
        {/* Filter giai đoạn */}
        <div className="space-y-1">
        <Label className="text-xs font-medium text-muted-foreground">Giai đoạn</Label>
        <Select
          value={draft.stage}
          onValueChange={(v) => patchAndApply({ stage: v ?? "" })}
        >
          <SelectTrigger className="w-40 max-sm:w-full">
            <SelectValue placeholder="Giai đoạn">
              {(v) => {
                if (typeof v !== "string" || !v) return "Tất cả giai đoạn"
                return STAGE_LABELS[v as CandidateStage] ?? null
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả giai đoạn</SelectItem>
            {(Object.keys(STAGE_LABELS) as CandidateStage[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STAGE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        </div>

        {/* Filter quyết định */}
        <div className="space-y-1">
        <Label className="text-xs font-medium text-muted-foreground">Quyết định</Label>
        <Select
          value={draft.decision}
          onValueChange={(v) => patchAndApply({ decision: v ?? "" })}
        >
          <SelectTrigger className="w-36 max-sm:w-full">
            <SelectValue placeholder="Quyết định">
              {(v) => {
                if (typeof v !== "string" || !v) return "Tất cả quyết định"
                return DECISION_LABELS[v as CandidateDecision] ?? null
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả quyết định</SelectItem>
            {(Object.keys(DECISION_LABELS) as CandidateDecision[]).map((d) => (
              <SelectItem key={d} value={d}>
                {DECISION_LABELS[d]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        </div>

        {/* Filter loại hình */}
        <div className="space-y-1">
        <Label className="text-xs font-medium text-muted-foreground">Loại hình</Label>
        <Select
          value={draft.recruitment_type}
          onValueChange={(v) => patchAndApply({ recruitment_type: v ?? "" })}
        >
          <SelectTrigger className="w-32 max-sm:w-full">
            <SelectValue placeholder="Loại hình">
              {(v) => {
                if (typeof v !== "string" || !v) return "Tất cả loại"
                return TYPE_LABELS[v as RecruitmentType] ?? null
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả loại</SelectItem>
            {(Object.keys(TYPE_LABELS) as RecruitmentType[]).map((t) => (
              <SelectItem key={t} value={t}>
                {TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        </div>

        {/* Filter nguồn */}
        <div className="space-y-1">
        <Label className="text-xs font-medium text-muted-foreground">Nguồn</Label>
        <Select
          value={draft.source}
          onValueChange={(v) => patchAndApply({ source: v ?? "" })}
        >
          <SelectTrigger className="w-36 max-sm:w-full">
            <SelectValue placeholder="Nguồn">
              {(v) => {
                if (typeof v !== "string" || !v) return "Tất cả nguồn"
                return v
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả nguồn</SelectItem>
            {SOURCE_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        </div>

        {/* Sắp xếp — chỉ điện thoại (thẻ không có header cột để bấm) */}
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
                  return sortOptionLabel(v)
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Mặc định</SelectItem>
              {SORT_FIELDS.flatMap(([f]) => [`${f}:asc`, `${f}:desc`]).map((o) => (
                <SelectItem key={o} value={o}>
                  {sortOptionLabel(o)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Bộ lọc tự áp dụng khi thay đổi — chỉ còn nút Đặt lại */}
        <div className="flex items-center gap-2 max-sm:hidden">
          <Button
            type="button"
            variant="outline"
            onClick={resetFilters}
            disabled={!hasFilters}
          >
            Đặt lại
          </Button>
        </div>
        </MobileFilterSheet>
      </div>

      {(() => {
        const desktopTable = (
      <div className="overflow-x-auto rounded-2xl border shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <table className="w-full min-w-[1060px] text-sm [&_td]:whitespace-nowrap">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">#</th>
              <SortHeader label="Họ tên" field="full_name" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} />
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Giới tính</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Số điện thoại</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Vị trí / Phòng ban</th>
              <SortHeader label="Nguồn" field="source" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} />
              <SortHeader label="Giai đoạn" field="stage" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} />
              <SortHeader label="Quyết định" field="decision" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} />
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Loại hình</th>
              <SortHeader label="Ngày ứng tuyển" field="applied_date" sortBy={applied.sort_by} sortDir={applied.sort_dir} onSort={handleSort} />
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Ngày phỏng vấn</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Giờ phỏng vấn</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Người tuyển dụng</th>
              {canWrite && (
                <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">Thao tác</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <ShellTableEmptyRow colSpan={canWrite ? 14 : 13}>
                Đang tải...
              </ShellTableEmptyRow>
            )}
            {!isLoading && data?.data.length === 0 && (
              <ShellTableEmptyRow colSpan={canWrite ? 14 : 13} className="px-0 py-0">
                <EmptyState
                  icon={UserSearch}
                  message="Chưa có ứng viên nào phù hợp."
                />
              </ShellTableEmptyRow>
            )}
            {data?.data.map((candidate, idx) => (
              <tr key={candidate.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-3 py-2 text-muted-foreground">
                  {startRow + idx}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <NameAvatar name={candidate.full_name} />
                    <span className="font-medium">{candidate.full_name}</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  {candidate.gender ? GENDER_LABELS[candidate.gender] : "—"}
                </td>
                <td className="px-3 py-2 tabular-nums">{candidate.phone}</td>
                <td className="px-3 py-2">
                  <div>{candidate.position ?? "—"}</div>
                  {candidate.department && (
                    <div className="text-xs text-muted-foreground">{candidate.department}</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <SourceTag source={candidate.source} />
                </td>
                <td className={`px-3 py-2 ${STAGE_CELL_BG[candidate.stage]}`}>
                  <StageBadge stage={candidate.stage} />
                </td>
                <td className={`px-3 py-2 ${DECISION_CELL_BG[candidate.decision]}`}>
                  <DecisionBadge decision={candidate.decision} />
                </td>
                <td className="px-3 py-2">
                  <TypeBadge type={candidate.recruitment_type} />
                </td>
                <td className="px-3 py-2">{formatDate(candidate.applied_date)}</td>
                <td className="px-3 py-2">
                  {candidate.interview_date ? formatDate(candidate.interview_date) : "—"}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {candidate.interview_time || "—"}
                </td>
                <td className="px-3 py-2">{candidate.recruiter_name || "—"}</td>
                {canWrite && (
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setEditTarget(candidate)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(candidate)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
        )

        const mobileCards = isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Đang tải...</p>
        ) : data?.data.length === 0 ? (
          <EmptyState icon={UserSearch} message="Chưa có ứng viên nào phù hợp." />
        ) : (
          <div className="space-y-3">
            {data?.data.map((candidate) => (
              <ShellListCard key={candidate.id}>
                <div className="flex items-center gap-2">
                  <NameAvatar name={candidate.full_name} />
                  <span className="min-w-0 flex-1 truncate font-medium">{candidate.full_name}</span>
                  <StageBadge stage={candidate.stage} />
                </div>
                <ShellListCardRow label="SĐT" value={candidate.phone} />
                <ShellListCardRow
                  label="Vị trí / Phòng ban"
                  value={`${candidate.position ?? "—"}${candidate.department ? ` · ${candidate.department}` : ""}`}
                />
                <ShellListCardRow label="Giới tính" value={candidate.gender ? GENDER_LABELS[candidate.gender] : "—"} />
                <ShellListCardRow label="Nguồn" value={<SourceTag source={candidate.source} />} />
                <ShellListCardRow label="Quyết định" value={<DecisionBadge decision={candidate.decision} />} />
                <ShellListCardRow label="Loại hình" value={<TypeBadge type={candidate.recruitment_type} />} />
                <ShellListCardRow label="Ngày ứng tuyển" value={formatDate(candidate.applied_date)} />
                <ShellListCardRow
                  label="Phỏng vấn"
                  value={
                    candidate.interview_date
                      ? `${formatDate(candidate.interview_date)}${candidate.interview_time ? ` ${candidate.interview_time}` : ""}`
                      : "—"
                  }
                />
                <ShellListCardRow label="Người tuyển dụng" value={candidate.recruiter_name || "—"} />
                {canWrite && (
                  <div className="flex items-center justify-end gap-1 pt-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon" aria-label="Thao tác khác" />}
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditTarget(candidate)}>
                          <Pencil /> Sửa
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(candidate)}>
                          <Trash2 /> Xoá
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </ShellListCard>
            ))}
          </div>
        )

        return (
          <>
            <ShellResponsiveList table={desktopTable} cards={mobileCards} />

            {/* Pagination */}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {total === 0
                  ? "Không có kết quả"
                  : `Hiển thị ${startRow}–${endRow} trong tổng ${total} ứng viên`}
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
          </>
        )
      })()}

      {/* Dialogs */}
      <CandidateDialog
        open={addOpen}
        onClose={() => onAddOpenChange(false)}
        target={null}
      />
      <CandidateDialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        target={editTarget}
      />

      {/* Confirm xoá */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="Xác nhận xoá"
        description={
          <>
            Bạn có chắc muốn xoá ứng viên{" "}
            <strong className="text-foreground">{deleteTarget?.full_name}</strong>?
            Hành động này không thể khôi phục.
          </>
        }
        confirmLabel="Xoá ứng viên"
        pending={deleteCandidate.isPending}
        onConfirm={handleDelete}
      />

      <StatsDialog open={statsOpen} onClose={() => onStatsOpenChange(false)} />
    </div>
  )
}

// ── Tab bar + page shell ─────────────────────────────────────────────────────

export default function RecruitmentPage() {
  return (
    <PermissionGate permission="recruitment.view">
      <RecruitmentScreen />
    </PermissionGate>
  )
}

function RecruitmentScreen() {
  const canWrite = usePermissions().can("recruitment.manage")
  const [tab, setTab] = useState<"candidates" | "positions">("candidates")
  const [addCandidateOpen, setAddCandidateOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [addPositionOpen, setAddPositionOpen] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <ShellPageHeader
        title="Tuyển dụng"
        icon={Briefcase}
        description={<span className="max-sm:hidden">Quản lý ứng viên và vị trí tuyển dụng</span>}
        actions={
          tab === "candidates" ? (
            <>
              <Button variant="outline" onClick={() => setStatsOpen(true)}>
                <BarChart2 className="mr-1.5 h-4 w-4" />
                Thống kê
              </Button>
              {canWrite && (
                <Button className={MOBILE_FAB_CLASS} onClick={() => setAddCandidateOpen(true)}>
                  <UserPlus className="mr-1.5 h-4 w-4" />
                  Thêm ứng viên
                </Button>
              )}
            </>
          ) : (
            canWrite && (
              <Button className={MOBILE_FAB_CLASS} onClick={() => setAddPositionOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                Thêm vị trí tuyển dụng
              </Button>
            )
          )
        }
      />

      <ShellTabs
        value={tab}
        onValueChange={(v) => setTab(v === "positions" ? "positions" : "candidates")}
      >
        <ShellTabsList>
          <ShellTabsTrigger value="candidates">Danh sách ứng viên</ShellTabsTrigger>
          <ShellTabsTrigger value="positions">Vị trí tuyển dụng</ShellTabsTrigger>
        </ShellTabsList>
      </ShellTabs>

      {tab === "candidates" ? (
        <CandidatesTab
          addOpen={addCandidateOpen}
          onAddOpenChange={setAddCandidateOpen}
          statsOpen={statsOpen}
          onStatsOpenChange={setStatsOpen}
        />
      ) : (
        <PositionsTab
          canWrite={canWrite}
          addOpen={addPositionOpen}
          onAddOpenChange={setAddPositionOpen}
        />
      )}
    </div>
  )
}
