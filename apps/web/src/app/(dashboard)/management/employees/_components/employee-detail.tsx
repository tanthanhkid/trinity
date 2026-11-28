"use client"

/**
 * Giao diện «Ánh xanh» cho màn Nhân viên (docs/design/anh-xanh.md; thiết kế nhansu-*.dc.html):
 * danh sách (hàng 64px + chip trạng thái) và hồ sơ (HeroCard + các nhóm thông tin + khối «Hệ thống»).
 * Chỉ trình bày — mọi thao tác (sửa/khoá/xoá/đặt lại thiết bị) do trang gọi qua callback.
 */
import * as React from "react"
import { ChevronLeft, Lock, LockOpen, Mail, MessageSquare, Pencil, Phone, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { PersonAvatar } from "@/components/ui/avatar"
import { StageChip, type StageTone } from "@/components/ui/stage-chip"
import { HeroCard, HeroCardLabel } from "@/components/ui/hero-card"
import { formatDate } from "@/lib/format"
import { resolveEmployeeDisplayStatus, type Employee } from "@/hooks/use-employees"
import { cn } from "@/lib/utils"

export const STATUS_LABELS: Record<string, string> = {
  // "unclassified" = nhân viên đồng bộ tự động từ tài khoản người dùng, HR chưa phân loại.
  unclassified: "Chưa phân loại",
  active: "Đang làm việc",
  probation: "Thử việc",
  waiting: "Chờ vào làm",
  on_leave: "Tạm nghỉ",
  resigned: "Nghỉ việc",
}

const STATUS_TONE: Record<string, StageTone> = {
  active: "won",
  probation: "consult",
  waiting: "care",
  on_leave: "quote",
  resigned: "neutral",
  unclassified: "neutral",
}

const GENDER_LABELS: Record<string, string> = { M: "Nam", F: "Nữ" }

const EDUCATION_LABELS: Record<string, string> = {
  dai_hoc_tro_len: "Đại học trở lên",
  cao_dang: "Cao đẳng",
  trung_cap: "Trung cấp",
  thpt_12: "THPT (12/12)",
  thcs: "THCS",
  khac: "Khác",
}

const RECRUITMENT_LABELS: Record<string, string> = { hr: "HR tuyển", internal: "Nội bộ giới thiệu" }

export function employeeStatus(emp: Employee): string | null {
  return resolveEmployeeDisplayStatus(emp.status, emp.user_status)
}

/** Chip trạng thái nhân viên: chấm + nền nhạt theo tông giai đoạn. */
export function EmployeeStatusChip({ status, size = "sm" }: { status: string | null; size?: "sm" | "md" }) {
  return (
    <StageChip tone={STATUS_TONE[status ?? ""] ?? "neutral"} size={size}>
      {STATUS_LABELS[status ?? ""] ?? status ?? "Không rõ"}
    </StageChip>
  )
}

/** Thời gian gắn bó từ ngày vào làm, vd «1 năm 9 tháng». */
export function tenureText(joinedAt: string | null): string | null {
  if (!joinedAt) return null
  const d = new Date(joinedAt)
  if (Number.isNaN(d.getTime())) return null
  const now = new Date()
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth())
  if (now.getDate() < d.getDate()) months -= 1
  if (months < 0) return "Chưa vào làm"
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y === 0 && m === 0) return "Mới vào làm"
  return [y > 0 ? `${y} năm` : "", m > 0 ? `${m} tháng` : ""].filter(Boolean).join(" ")
}

/** Hàng danh sách nhân viên: avatar tròn + tên/mã/chức danh + chip trạng thái; cao ≥ 64px. */
export function EmployeeListItem({
  emp,
  current,
  onSelect,
  highlightClass,
}: {
  emp: Employee
  current: boolean
  onSelect: () => void
  highlightClass?: string
}) {
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex min-h-16 w-full cursor-pointer items-center gap-3 border-t border-ax-divider px-4 py-3 text-left text-ax-ink transition-colors first:border-t-0 hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none",
        current && "bg-ax-primary-soft hover:bg-ax-primary-soft",
        highlightClass,
      )}
    >
      <PersonAvatar kind="staff" size="lg" name={emp.full_name} src={emp.avatar_url} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold">{emp.full_name ?? "Chưa cập nhật"}</span>
        <span className="mt-px block truncate text-[13px] text-ax-ink-2">
          {[emp.employee_code, emp.position ?? emp.job_title_name, emp.team_name].filter(Boolean).join(" · ")}
        </span>
      </span>
      <EmployeeStatusChip status={employeeStatus(emp)} />
    </button>
  )
}

interface Row {
  label: string
  value: string | null | undefined
}

function groups(emp: Employee): { title: string; rows: Row[] }[] {
  return [
    {
      title: "Công việc",
      rows: [
        { label: "Chức vụ", value: emp.position ?? emp.job_title_name },
        { label: "Phòng ban", value: emp.department },
        { label: "Team", value: emp.team_name },
        { label: "Cấp quản lý", value: emp.manager_name },
        { label: "Nơi làm việc", value: emp.office_name },
        { label: "Ngày vào làm", value: emp.joined_at ? formatDate(emp.joined_at) : null },
        {
          label: "Nguồn tuyển dụng",
          value: emp.recruitment_source ? (RECRUITMENT_LABELS[emp.recruitment_source] ?? emp.recruitment_source) : null,
        },
      ],
    },
    {
      title: "Cá nhân",
      rows: [
        { label: "Số điện thoại", value: emp.phone },
        { label: "Giới tính", value: emp.gender ? (GENDER_LABELS[emp.gender] ?? emp.gender) : null },
        { label: "Ngày sinh", value: emp.birth_date ? formatDate(emp.birth_date) : null },
        {
          label: "Học vấn",
          value: emp.education_level ? (EDUCATION_LABELS[emp.education_level] ?? emp.education_level) : null,
        },
        { label: "Số CCCD", value: emp.id_card_number },
        { label: "Ngày cấp CCCD", value: emp.id_card_issued_date ? formatDate(emp.id_card_issued_date) : null },
        { label: "Nơi cấp CCCD", value: emp.id_card_issued_place },
        { label: "Hộ khẩu thường trú", value: emp.permanent_address },
        { label: "Chỗ ở hiện tại", value: emp.current_address },
      ],
    },
    {
      title: "Tài khoản ngân hàng",
      rows: [
        { label: "Ngân hàng", value: emp.bank_name },
        { label: "Số tài khoản", value: emp.bank_account_number },
        { label: "Chủ tài khoản", value: emp.bank_account_holder },
      ],
    },
  ]
}

const CARD = "rounded-ax-card border border-ax-line bg-ax-surface shadow-ax-card"

/** Một nhóm thông tin. Desktop: lưới hai cột trong thẻ + nút Sửa; điện thoại: hàng nhãn/giá trị trong thẻ bo 12. */
function InfoGroup({
  title,
  rows,
  canEdit,
  onEdit,
  onAddEmpty,
}: {
  title: string
  rows: Row[]
  canEdit: boolean
  onEdit: () => void
  onAddEmpty: () => void
}) {
  return (
    <section aria-label={title} className="max-lg:contents">
      {/* Desktop */}
      <div className={cn(CARD, "max-lg:hidden overflow-hidden")}>
        <div className="flex items-center justify-between px-6 pt-3.5">
          <h3 className="text-base font-bold tracking-[-0.011em] text-ax-ink">{title}</h3>
          {canEdit && (
            <Button variant="ax-secondary" size="ax" onClick={onEdit}>
              <Pencil className="size-4" aria-hidden="true" />
              Sửa
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 px-6 pt-2 pb-4 xl:grid-cols-3">
          {rows.map((r) => (
            <div key={r.label} className="min-w-0 border-b border-ax-divider py-2.5">
              <dt className="text-xs text-ax-ink-3">{r.label}</dt>
              {r.value ? (
                <dd className="mt-0.5 text-[15px] font-medium break-words text-ax-ink">{r.value}</dd>
              ) : canEdit ? (
                <dd>
                  <button
                    type="button"
                    onClick={onAddEmpty}
                    className="mt-0.5 min-h-8 cursor-pointer text-left text-[15px] text-ax-primary-hover hover:underline focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none"
                  >
                    Thêm {r.label.toLowerCase()}
                  </button>
                </dd>
              ) : (
                <dd className="mt-0.5 text-[15px] text-ax-ink-3">Chưa cập nhật</dd>
              )}
            </div>
          ))}
        </dl>
      </div>
      {/* Điện thoại */}
      <div className="mt-3 lg:hidden">
        <div className="mx-8 mb-1.5 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold tracking-[0.06em] text-ax-ink-3 uppercase">{title}</h2>
          {canEdit && (
            <button
              type="button"
              aria-label={`Sửa ${title}`}
              onClick={onEdit}
              className="-mr-4 h-11 min-w-14 cursor-pointer text-base font-semibold text-ax-primary-hover focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none"
            >
              Sửa
            </button>
          )}
        </div>
        <div className="mx-4 overflow-hidden rounded-ax-card bg-ax-surface shadow-ax-card">
          {rows.map((r, i) => (
            <div
              key={r.label}
              className={cn("flex min-h-[52px] items-center gap-3 px-4 py-2", i > 0 && "border-t border-ax-divider")}
            >
              <span className="w-28 shrink-0 text-[15px] text-ax-ink-2">{r.label}</span>
              <span
                className={cn(
                  "min-w-0 flex-1 text-right text-[15px] break-words",
                  r.value ? "text-ax-ink" : "text-ax-ink-3",
                )}
              >
                {r.value || "Chưa cập nhật"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export interface EmployeeDetailProps {
  emp: Employee
  /** Điện thoại: hiện nút «‹ Nhân viên» quay lại danh sách. */
  onBack?: () => void
  canEdit: boolean
  canLock: boolean
  canDelete: boolean
  isAdmin: boolean
  canResetDevice: boolean
  onEdit: () => void
  onLock: () => void
  onDelete: () => void
  onResetDevice: () => void
}

export function EmployeeDetail({
  emp,
  onBack,
  canEdit,
  canLock,
  canDelete,
  isAdmin,
  canResetDevice,
  onEdit,
  onLock,
  onDelete,
  onResetDevice,
}: EmployeeDetailProps) {
  const status = employeeStatus(emp)
  const tenure = tenureText(emp.joined_at)
  const locked = emp.user_status === "locked"
  const phoneDigits = emp.phone?.replace(/[^\d+]/g, "")
  const quick = [
    phoneDigits ? { href: `tel:${phoneDigits}`, label: "Gọi", icon: Phone } : null,
    phoneDigits ? { href: `sms:${phoneDigits}`, label: "Nhắn", icon: MessageSquare } : null,
    emp.email ? { href: `mailto:${emp.email}`, label: "Email", icon: Mail } : null,
  ].filter((x): x is { href: string; label: string; icon: typeof Phone } => x !== null)

  const systemCard = (
    <section aria-label="Hệ thống" className={cn(CARD, "px-6 py-5 max-lg:px-0 max-lg:py-0 max-lg:border-0")}>
      <h3 className="mb-2 text-base font-bold tracking-[-0.011em] text-ax-ink max-lg:hidden">Hệ thống</h3>
      <div className="max-lg:overflow-hidden max-lg:rounded-ax-card max-lg:bg-ax-surface max-lg:shadow-ax-card">
        <SysRow label="Email đăng nhập" value={emp.email} />
        <SysRow label="Tạo lúc" value={emp.created_at ? formatDate(emp.created_at) : "—"} />
        <div className="border-t border-ax-divider py-2.5 text-sm max-lg:min-h-[52px] max-lg:px-4 max-lg:py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-ax-ink-2 max-lg:text-[15px]">Thiết bị chấm công</span>
            <span className="text-ax-ink max-lg:text-[15px]">
              {emp.registered_device_id ? "Đã đăng ký" : "Chưa đăng ký"}
            </span>
          </div>
          {canResetDevice && emp.registered_device_id && (
            <Button variant="ax-secondary" size="ax" className="mt-2 max-lg:w-full" onClick={onResetDevice}>
              Đặt lại thiết bị
            </Button>
          )}
        </div>
      </div>
    </section>
  )

  return (
    <div className="flex flex-col gap-4 max-lg:gap-0 max-lg:pb-10">
      {onBack && (
        <div className="flex items-center px-2 pt-1 lg:hidden">
          <button
            type="button"
            aria-label="Quay lại danh sách nhân viên"
            onClick={onBack}
            className="flex h-11 cursor-pointer items-center gap-0.5 px-2.5 text-base text-ax-primary-press focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none"
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
            Nhân viên
          </button>
        </div>
      )}

      <HeroCard className="max-lg:mx-4 max-lg:my-2">
        <div className="flex flex-wrap items-center gap-4 max-lg:flex-col max-lg:items-start max-lg:gap-2">
          <PersonAvatar kind="staff" size="2xl" name={emp.full_name} src={emp.avatar_url} />
          <div className="min-w-[220px] flex-1">
            <h2 className="text-[26px] leading-tight font-bold tracking-[-0.02em] text-white max-lg:text-[25px]">
              {emp.full_name ?? "Chưa cập nhật"}
            </h2>
            <HeroCardLabel className="mt-0.5 text-sm">
              {[emp.employee_code, emp.position ?? emp.job_title_name].filter(Boolean).join(" · ")}
            </HeroCardLabel>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <EmployeeStatusChip status={status} size="md" />
              {tenure && <span className="text-[13px] text-[var(--ax-on-hero-ink-2)]">{tenure}</span>}
            </div>
          </div>
          {(canLock || canDelete) && (
            <div className="flex flex-wrap gap-2 max-lg:hidden">
              {canLock && (
                <Button
                  variant="ax-on-hero-secondary"
                  size="ax"
                  disabled={locked && !isAdmin}
                  onClick={onLock}
                >
                  {locked ? <LockOpen className="size-4" aria-hidden="true" /> : <Lock className="size-4" aria-hidden="true" />}
                  {locked ? (isAdmin ? "Mở khoá" : "Đang bị khoá") : "Khoá tài khoản"}
                </Button>
              )}
            </div>
          )}
        </div>
      </HeroCard>

      {quick.length > 0 && (
        <div className="grid grid-cols-3 gap-2 px-4 pb-4 lg:hidden">
          {quick.map((q) => (
            <a
              key={q.label}
              href={q.href}
              className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-ax-card bg-ax-surface text-sm font-semibold text-ax-primary-press shadow-ax-card focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none"
            >
              <q.icon className="size-5" aria-hidden="true" />
              {q.label}
            </a>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-start gap-4 max-lg:block">
        <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-4 max-lg:block">
          {groups(emp).map((g) => (
            <InfoGroup
              key={g.title}
              title={g.title}
              rows={g.rows}
              canEdit={canEdit}
              onEdit={onEdit}
              onAddEmpty={onEdit}
            />
          ))}
        </div>
        <aside aria-label="Hệ thống và quyền" className="flex min-w-[260px] flex-[1_1_280px] flex-col gap-4 max-lg:mt-3 max-lg:block max-lg:min-w-0 max-lg:px-4">
          <div className="max-lg:hidden">{systemCard}</div>
          <div className="lg:hidden">{systemCard}</div>
          {(canLock || canDelete) && (
            <div className="flex flex-col gap-2 max-lg:mt-3 lg:hidden">
              {canLock && (
                <Button variant="ax-secondary" size="ax-lg" disabled={locked && !isAdmin} onClick={onLock}>
                  {locked ? (isAdmin ? "Mở khoá tài khoản" : "Đang bị khoá") : "Khoá tài khoản"}
                </Button>
              )}
              {canDelete && (
                <Button variant="ax-danger" size="ax-lg" onClick={onDelete}>
                  Xoá nhân viên
                </Button>
              )}
            </div>
          )}
          {canDelete && (
            <Button variant="ax-danger" size="ax" className="max-lg:hidden" onClick={onDelete}>
              <Trash2 className="size-4" aria-hidden="true" />
              Xoá nhân viên
            </Button>
          )}
        </aside>
      </div>
    </div>
  )
}

function SysRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-ax-divider py-2.5 text-sm first:border-t-0 max-lg:min-h-[52px] max-lg:px-4 max-lg:py-2">
      <span className="text-ax-ink-2 max-lg:text-[15px]">{label}</span>
      <span className="text-right break-words text-ax-ink max-lg:text-[15px]">{value}</span>
    </div>
  )
}
