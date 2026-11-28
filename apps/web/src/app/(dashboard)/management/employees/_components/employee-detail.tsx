"use client"

/**
 * Giao diện «Ánh xanh» cho màn Nhân viên (docs/design/anh-xanh.md; thiết kế nhansu-*.dc.html):
 * danh sách (hàng 64px + chip trạng thái) và hồ sơ (HeroCard + nhóm Công việc / Liên hệ và cá nhân / Giấy tờ và ngân hàng;
 * cột phải «Vai trò» + «Hệ thống»).
 * Chỉ trình bày — mọi thao tác (sửa/khoá/xoá/đặt lại thiết bị/gán vai trò) do trang gọi qua callback hoặc `renderRoles`.
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
  /** Nhãn ngắn trên điện thoại (cột nhãn hẹp). */
  short?: string
  value: string | null | undefined
}

export type GroupEdit = "work" | "profile"

interface Group {
  title: string
  edit: GroupEdit
  rows: Row[]
  /** Nhóm có số nhạy cảm (CCCD, số tài khoản): che mặc định, có nút hiện. */
  sensitive?: boolean
}

/** Che số: CCCD giữ 3 số đầu/cuối, số tài khoản giữ 4 số cuối (thiết kế nhansu-desktop). */
export function maskIdCard(v: string): string {
  const t = v.replace(/\s/g, "")
  return t.length > 6 ? `${t.slice(0, 3)} ••• ••• ${t.slice(-3)}` : "•••"
}
export function maskAccount(v: string): string {
  const t = v.replace(/\s/g, "")
  return t.length > 4 ? `••••••${t.slice(-4)}` : "••••"
}

export function groups(emp: Employee, reveal = false): Group[] {
  const status = employeeStatus(emp)
  return [
    {
      title: "Công việc",
      edit: "work",
      rows: [
        { label: "Trạng thái", value: status ? (STATUS_LABELS[status] ?? status) : null },
        { label: "Chức danh", value: emp.position ?? emp.job_title_name },
        { label: "Team / bộ phận", short: "Team", value: emp.team_name },
        { label: "Phòng ban", value: emp.department },
        { label: "Văn phòng chấm công", short: "Văn phòng", value: emp.office_name },
        { label: "Ngày vào làm", short: "Vào làm", value: emp.joined_at ? formatDate(emp.joined_at) : null },
        { label: "Quản lý trực tiếp", short: "Quản lý", value: emp.manager_name },
      ],
    },
    {
      title: "Liên hệ và cá nhân",
      edit: "profile",
      rows: [
        { label: "Giới tính", value: emp.gender ? (GENDER_LABELS[emp.gender] ?? emp.gender) : null },
        { label: "Số điện thoại", short: "Điện thoại", value: emp.phone },
        { label: "Ngày sinh", value: emp.birth_date ? formatDate(emp.birth_date) : null },
        {
          label: "Trình độ học vấn",
          short: "Học vấn",
          value: emp.education_level ? (EDUCATION_LABELS[emp.education_level] ?? emp.education_level) : null,
        },
        {
          label: "Nguồn tuyển dụng",
          short: "Nguồn",
          value: emp.recruitment_source ? (RECRUITMENT_LABELS[emp.recruitment_source] ?? emp.recruitment_source) : null,
        },
      ],
    },
    {
      title: "Giấy tờ và ngân hàng",
      edit: "profile",
      sensitive: Boolean(emp.id_card_number || emp.bank_account_number),
      rows: [
        { label: "Số CCCD", value: emp.id_card_number && !reveal ? maskIdCard(emp.id_card_number) : emp.id_card_number },
        { label: "Ngày cấp", value: emp.id_card_issued_date ? formatDate(emp.id_card_issued_date) : null },
        { label: "Nơi cấp", value: emp.id_card_issued_place },
        { label: "Hộ khẩu thường trú", short: "Hộ khẩu", value: emp.permanent_address },
        { label: "Chỗ ở hiện tại", short: "Chỗ ở", value: emp.current_address },
        { label: "Ngân hàng", value: emp.bank_name },
        {
          label: "Số tài khoản",
          value: emp.bank_account_number && !reveal ? maskAccount(emp.bank_account_number) : emp.bank_account_number,
        },
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
  reveal,
  onReveal,
}: {
  title: string
  rows: Row[]
  canEdit: boolean
  onEdit: () => void
  /** Có ⇒ nhóm nhạy cảm, hiện nút «Hiện/Ẩn số…». */
  reveal?: boolean
  onReveal?: () => void
}) {
  const revealBtn = (cls: string) =>
    onReveal ? (
      <button
        type="button"
        aria-pressed={reveal}
        onClick={onReveal}
        className={cn(
          "min-h-10 cursor-pointer text-left text-sm font-semibold text-ax-primary-hover hover:underline focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none max-sm:min-h-11",
          cls,
        )}
      >
        {reveal ? "Ẩn số CCCD và tài khoản" : "Hiện số CCCD và tài khoản"}
      </button>
    ) : null
  return (
    <section aria-label={title} className="max-lg:contents">
      {/* Desktop */}
      <div className={cn(CARD, "max-lg:hidden overflow-hidden")}>
        <div className="flex min-h-14 items-center justify-between px-6 pt-3">
          <h3 className="text-base font-bold tracking-[-0.011em] text-ax-ink">{title}</h3>
          {canEdit && (
            <Button variant="ax-secondary" size="ax" aria-label={`Sửa ${title}`} onClick={onEdit}>
              <Pencil className="size-4" aria-hidden="true" />
              Sửa
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 px-6 pt-1 pb-4">
          {rows.map((r) => (
            <div key={r.label} className="min-w-0 border-b border-ax-divider py-2.5">
              <dt className="text-[13px] text-ax-ink-3">{r.label}</dt>
              {r.value ? (
                <dd className="mt-0.5 text-[15px] font-medium break-words text-ax-ink">{r.value}</dd>
              ) : canEdit ? (
                <dd>
                  <button
                    type="button"
                    onClick={onEdit}
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
        {revealBtn("mx-6 mb-3")}
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
              <span className="w-28 shrink-0 text-[15px] text-ax-ink-2">{r.short ?? r.label}</span>
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
          {onReveal && <div className="border-t border-ax-divider px-4">{revealBtn("w-full")}</div>}
        </div>
      </div>
    </section>
  )
}

/** SĐT gọi/nhắn được: bỏ khoảng trắng; SĐT bị che (`*`, `•`, `x`) ⇒ không dùng được. */
export function dialablePhone(phone: string | null | undefined): string | null {
  if (!phone || /[*•xX]/.test(phone)) return null
  const d = phone.replace(/[^\d+]/g, "")
  return d.length >= 8 ? d : null
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
  /** Nút Sửa nhóm «Liên hệ…», «Giấy tờ…» — hộp thoại sửa hồ sơ đầy đủ. */
  onEdit: () => void
  /** Nút Sửa nhóm «Công việc» — khay «Sửa công việc». Không truyền ⇒ dùng `onEdit`. */
  onEditWork?: () => void
  onLock: () => void
  onDelete: () => void
  onResetDevice: () => void
  /** Khối «Vai trò» (trang dựng — có gọi API theo quyền). Desktop ở cột phải, điện thoại ngay dưới hàng Gọi/Nhắn/Email. */
  renderRoles?: (variant: "desktop" | "mobile") => React.ReactNode
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
  onEditWork,
  onLock,
  onDelete,
  onResetDevice,
  renderRoles,
}: EmployeeDetailProps) {
  const [reveal, setReveal] = React.useState(false)
  // Đổi người xem ⇒ che lại số nhạy cảm.
  const [revealFor, setRevealFor] = React.useState(emp.id)
  if (revealFor !== emp.id) {
    setRevealFor(emp.id)
    setReveal(false)
  }
  const status = employeeStatus(emp)
  const tenure = tenureText(emp.joined_at)
  const locked = emp.user_status === "locked"
  const phoneDigits = dialablePhone(emp.phone)
  const quick: { href: string | null; label: string; icon: typeof Phone; missing: string }[] = [
    { href: phoneDigits ? `tel:${phoneDigits}` : null, label: "Gọi", icon: Phone, missing: "Chưa có số điện thoại" },
    { href: phoneDigits ? `sms:${phoneDigits}` : null, label: "Nhắn", icon: MessageSquare, missing: "Chưa có số điện thoại" },
    { href: emp.email ? `mailto:${emp.email}` : null, label: "Email", icon: Mail, missing: "Chưa có email" },
  ]

  const systemCard = (
    <section aria-label="Hệ thống" className={cn(CARD, "px-5 py-4 max-lg:mt-3 max-lg:border-0 max-lg:bg-transparent max-lg:p-0 max-lg:shadow-none")}>
      <h3 className="mb-2 text-base font-bold tracking-[-0.011em] text-ax-ink max-lg:mx-4 max-lg:mb-1.5 max-lg:text-[11px] max-lg:font-semibold max-lg:tracking-[0.06em] max-lg:text-ax-ink-3 max-lg:uppercase">
        Hệ thống
      </h3>
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
            <Button variant="ax-secondary" size="ax" className="mt-2 max-lg:mb-1 max-lg:w-full" onClick={onResetDevice}>
              Đặt lại thiết bị
            </Button>
          )}
        </div>
      </div>
    </section>
  )

  return (
    <div className="flex flex-wrap items-start gap-4 max-lg:block max-lg:pb-10">
      {/* Cột chính: khối nhấn + các nhóm thông tin */}
      <div className="flex min-w-0 flex-[1000_1_420px] flex-col gap-4 max-lg:block">
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
          <div className="flex flex-wrap items-center gap-4 max-lg:flex-col max-lg:gap-2 max-lg:text-center">
            <PersonAvatar kind="staff" size="2xl" name={emp.full_name} src={emp.avatar_url} />
            <div className="min-w-[200px] flex-1 max-lg:flex max-lg:flex-col max-lg:items-center">
              <h2 className="text-[26px] leading-tight font-bold tracking-[-0.02em] text-white max-lg:text-[25px]">
                {emp.full_name ?? "Chưa cập nhật"}
              </h2>
              <HeroCardLabel className="mt-0.5 text-sm">
                {[emp.employee_code, emp.position ?? emp.job_title_name].filter(Boolean).join(" · ")}
              </HeroCardLabel>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 max-lg:justify-center">
                <EmployeeStatusChip status={status} size="md" />
                {tenure && <span className="text-[13px] text-[var(--ax-on-hero-ink-2)]">{tenure}</span>}
              </div>
            </div>
            {canLock && (
              <div className="flex flex-wrap gap-2 max-lg:hidden">
                <Button variant="ax-on-hero-secondary" size="ax" disabled={locked && !isAdmin} onClick={onLock}>
                  {locked ? <LockOpen className="size-4" aria-hidden="true" /> : <Lock className="size-4" aria-hidden="true" />}
                  {locked ? (isAdmin ? "Mở khoá" : "Đang bị khoá") : "Khoá tài khoản"}
                </Button>
              </div>
            )}
          </div>
        </HeroCard>

        {/* Điện thoại: Gọi / Nhắn / Email luôn đủ ba ô; thiếu số/email thì ô mờ, không bấm được. */}
        <div className="grid grid-cols-3 gap-2 px-4 pb-1 lg:hidden">
          {quick.map((q) =>
            q.href ? (
              <a
                key={q.label}
                href={q.href}
                className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-ax-card bg-ax-surface text-sm font-semibold text-ax-primary-press shadow-ax-card focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none"
              >
                <q.icon className="size-5" aria-hidden="true" />
                {q.label}
              </a>
            ) : (
              <span
                key={q.label}
                role="link"
                aria-disabled="true"
                title={q.missing}
                aria-label={`${q.label} — ${q.missing.toLowerCase()}`}
                className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-ax-card bg-ax-surface text-sm font-semibold text-ax-ink-3 shadow-ax-card"
              >
                <q.icon className="size-5" aria-hidden="true" />
                {q.label}
              </span>
            ),
          )}
        </div>

        {renderRoles && <div className="lg:hidden">{renderRoles("mobile")}</div>}

        {groups(emp, reveal).map((g) => (
          <InfoGroup
            key={g.title}
            title={g.title}
            rows={g.rows}
            canEdit={canEdit}
            onEdit={g.edit === "work" ? (onEditWork ?? onEdit) : onEdit}
            reveal={g.sensitive ? reveal : undefined}
            onReveal={g.sensitive ? () => setReveal((v) => !v) : undefined}
          />
        ))}
      </div>

      {/* Cột phải desktop: Vai trò + Hệ thống; điện thoại: nối tiếp bên dưới */}
      <aside
        aria-label="Vai trò và hệ thống"
        className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 max-lg:block max-lg:w-auto max-lg:min-w-0 max-lg:px-4"
      >
        {renderRoles && <div className="max-lg:hidden">{renderRoles("desktop")}</div>}
        {systemCard}
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
  )
}

function SysRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-t border-ax-divider py-2.5 text-sm first:border-t-0 max-lg:min-h-[52px] max-lg:px-4 max-lg:py-2">
      <span className="shrink-0 text-ax-ink-2 max-lg:text-[15px]">{label}</span>
      {/* Giá trị dài (email) không vừa cạnh nhãn thì xuống dòng riêng, không bẻ giữa chữ. */}
      <span className="ml-auto min-w-0 text-right [overflow-wrap:anywhere] text-ax-ink max-lg:text-[15px]">{value}</span>
    </div>
  )
}
