"use client"

import { memo } from "react"
import Link from "next/link"
import type { Contact } from "@/hooks/use-contacts"
import { formatDate, formatPhone } from "@/lib/format"
import { EmployeeCell } from "@/components/employee-cell"
import { ShellCheckbox as Checkbox } from "@/components/app-shell/checkbox"
import { ShellAvatar } from "@/components/app-shell/avatar"
import { LEAD_LABEL_TEXT } from "@/components/lead-score-badge"
import { resolveV2StageBadgeStyle } from "@/lib/contact-stage-badge"
import { cn } from "@/lib/utils"
import type { ContactSignal, ContactSignalTone } from "./contact-signals"

/* =============================================================================
 * Một dòng bảng Khách hàng theo bản demo giao diện mới:
 *   ô chọn · avatar chữ cái + tên + dòng phụ · mức quan tâm (thanh chấm = điểm lead)
 *   · người phụ trách · điện thoại · giai đoạn (chấm màu) · tín hiệu (chip)
 * Dữ liệu y nguyên `GET /contacts` — SĐT hiển thị ĐÚNG chuỗi BE trả (BE che theo
 * `contacts.phone_full`), FE không tự che/mở.
 * ========================================================================== */

/** Dòng phụ dưới tên: trạng thái chi tiết · ngày tạo · người tạo (khi khác người phụ trách). */
export function contactSubline(c: Pick<Contact, "contact_status" | "created_at" | "creator" | "assignee_name">): string {
  const parts: string[] = []
  if (c.contact_status?.label) parts.push(c.contact_status.label)
  if (c.created_at) parts.push(`Tạo ${formatDate(c.created_at)}`)
  const by = c.creator?.full_name?.trim()
  if (by && by !== c.assignee_name?.trim()) parts.push(`bởi ${by}`)
  return parts.join(" · ")
}

const LEAD_COLOR: Record<"hot" | "warm" | "cold", string> = {
  hot: "var(--color-app-green)",
  warm: "var(--color-app-blue)",
  cold: "var(--color-app-amber)",
}

/** "Mức quan tâm": 10 vạch, số vạch đậm = điểm lead / 10. Chưa chấm ⇒ "—". */
export function LeadDots({ score, label }: { score?: number | null; label?: "hot" | "warm" | "cold" | null }) {
  if (score === null || score === undefined || !label) {
    return <span className="text-sm text-muted-foreground" title="Chưa chấm điểm">—</span>
  }
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)))
  return (
    <span className="inline-flex items-center gap-2" title={`Điểm ${score}/100 — ${LEAD_LABEL_TEXT[label]}`}>
      <span aria-hidden className="inline-flex items-center gap-px">
        {Array.from({ length: 10 }, (_, i) => (
          <i
            key={i}
            className="block h-3 w-[3px] rounded-[1px]"
            style={{ background: i < filled ? LEAD_COLOR[label] : "var(--border)" }}
          />
        ))}
      </span>
      <span className="text-sm tabular-nums text-[var(--color-app-ink-2)]">{score}</span>
      <span className="sr-only">{LEAD_LABEL_TEXT[label]}</span>
    </span>
  )
}

/** Giai đoạn: nhãn có chấm màu, màu theo mã bền của giai đoạn (`resolveV2StageBadgeStyle`). */
export function StagePill({ c }: { c: Pick<Contact, "stage" | "stage_source" | "stage_option"> }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-sm font-medium"
      style={resolveV2StageBadgeStyle(c.stage_source, c.stage_option?.value)}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{c.stage || "—"}</span>
    </span>
  )
}

const TONE_CLASS: Record<ContactSignalTone, string> = {
  ai: "border-transparent bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]",
  "deal-open": "border-[var(--border)] bg-[var(--card)] text-[var(--color-app-ink-2)]",
  "deal-won": "border-transparent bg-[var(--color-app-tag-green-bg)] text-[var(--color-app-tag-green-ink)]",
  "deal-lost": "border-transparent bg-[var(--color-app-tag-red-bg)] text-[var(--color-app-tag-red-ink)]",
  plain: "border-[var(--border)] bg-[var(--card)] text-[var(--color-app-ink-2)]",
}

/** Chip tín hiệu — chip AI có ✦ và mở đúng mục ở màn Hoạt động AI. */
export function SignalChips({ signals, className }: { signals: readonly ContactSignal[]; className?: string }) {
  if (signals.length === 0) return <span className="text-sm text-muted-foreground">—</span>
  return (
    <span className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {signals.map((s) => {
        const cls = cn(
          "inline-flex max-w-[15rem] items-center gap-1 rounded-md border px-1.5 py-0.5 text-sm leading-5",
          TONE_CLASS[s.tone],
        )
        const body = (
          <>
            {s.tone === "ai" && <span aria-hidden>✦</span>}
            <span className="truncate">{s.text}</span>
          </>
        )
        return s.href ? (
          <Link
            key={s.key}
            href={s.href}
            title={s.title}
            onClick={(e) => e.stopPropagation()}
            className={cn(cls, "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]")}
          >
            {body}
          </Link>
        ) : (
          <span key={s.key} title={s.title} className={cls}>{body}</span>
        )
      })}
    </span>
  )
}

function AssigneeCell({ c }: { c: Pick<Contact, "assignee_name" | "assignee_email"> }) {
  if (!c.assignee_name && !c.assignee_email) return <span className="text-sm text-muted-foreground">—</span>
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ShellAvatar name={c.assignee_name || c.assignee_email} size="sm" className="!rounded-full text-sm" />
      <EmployeeCell fullName={c.assignee_name} email={c.assignee_email} className="min-w-0 text-sm" />
    </span>
  )
}

interface ContactRowProps {
  contact: Contact
  onNavigate: (id: string) => void
  onHover: (id: string) => void
  showSelection: boolean
  selected: boolean
  onToggleSelected: (id: string, checked: boolean) => void
  /** Cột "Mức quan tâm" theo cờ `lead_scoring` của tổ chức. */
  showScore?: boolean
  signals: readonly ContactSignal[]
}

/** Một `<tr>` của bảng Khách hàng (≥640px). Bấm cả dòng mở chi tiết; ô chọn/chip không lan ra dòng. */
export const ContactRow = memo(function ContactRow({
  contact: c,
  onNavigate,
  onHover,
  showSelection,
  selected,
  onToggleSelected,
  showScore = true,
  signals,
}: ContactRowProps) {
  const sub = contactSubline(c)
  return (
    <tr
      data-selected={selected || undefined}
      className="cursor-pointer border-b border-[var(--border)] text-sm transition-colors last:border-b-0 hover:bg-[var(--muted)] data-[selected]:bg-[var(--color-app-primary-soft)]"
      onClick={() => onNavigate(c.id)}
      onMouseEnter={() => onHover(c.id)}
    >
      {showSelection ? (
        <td className="w-11 py-2.5 pl-4 pr-1 align-middle" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onToggleSelected(c.id, v === true)}
            aria-label={`Chọn khách hàng ${c.full_name ?? c.phone}`}
          />
        </td>
      ) : null}
      <td className={cn("py-2.5 pr-3 align-middle", showSelection ? "pl-2" : "pl-4")}>
        <div className="flex min-w-0 max-w-[300px] items-center gap-2.5">
          <ShellAvatar name={c.full_name} size="md" className="text-sm" />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground" title={c.full_name || undefined}>{c.full_name || "—"}</div>
            {sub && <div className="truncate text-sm text-muted-foreground" title={sub}>{sub}</div>}
          </div>
        </div>
      </td>
      {showScore && (
        <td className="hidden whitespace-nowrap px-3 py-2.5 align-middle md:table-cell">
          <LeadDots score={c.lead_score} label={c.lead_label} />
        </td>
      )}
      <td className="hidden max-w-[180px] px-3 py-2.5 align-middle lg:table-cell">
        <AssigneeCell c={c} />
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 align-middle tabular-nums text-[var(--color-app-ink-2)]">
        {formatPhone(c.phone) || "—"}
      </td>
      <td className="max-w-[170px] px-3 py-2.5 align-middle">
        <StagePill c={c} />
      </td>
      <td className="hidden max-w-[380px] py-2 pl-3 pr-4 align-middle xl:table-cell">
        <SignalChips signals={signals} />
      </td>
    </tr>
  )
})

interface ContactCardProps {
  contact: Contact
  onNavigate: (id: string) => void
  showSelection: boolean
  selected: boolean
  onToggleSelected: (id: string, checked: boolean) => void
  /** Theo cờ lead_scoring của org; tắt thì không hiện điểm. */
  showScore?: boolean
  signals?: readonly ContactSignal[]
}

/**
 * Thẻ Khách hàng trên điện thoại (<640px) — cùng dữ liệu + cùng hành vi (chọn hàng loạt) với `ContactRow`,
 * chỉ khác cách trình bày.
 */
export const ContactCard = memo(function ContactCard({
  contact: c,
  onNavigate,
  showSelection,
  selected,
  onToggleSelected,
  showScore = true,
  signals = [],
}: ContactCardProps) {
  const sub = contactSubline(c)
  return (
    <div
      onClick={() => onNavigate(c.id)}
      data-selected={selected || undefined}
      className="cursor-pointer space-y-2 border-b border-[var(--border)] px-4 py-3 text-sm last:border-b-0 active:bg-[var(--muted)] data-[selected]:bg-[var(--color-app-primary-soft)]"
    >
      <div className="flex items-center gap-2.5">
        {showSelection && (
          <label
            className="-my-2 -ml-3 flex min-h-11 min-w-11 cursor-pointer items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={(v) => onToggleSelected(c.id, v === true)}
              aria-label={`Chọn khách hàng ${c.full_name ?? c.phone}`}
            />
          </label>
        )}
        <ShellAvatar name={c.full_name} size="md" className="text-sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{c.full_name || "—"}</div>
          {sub && <div className="truncate text-sm text-muted-foreground">{sub}</div>}
        </div>
        <span className="shrink-0"><StagePill c={c} /></span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[var(--color-app-ink-2)]">
        <span className="tabular-nums">{formatPhone(c.phone)}</span>
        {showScore && c.lead_score != null && <LeadDots score={c.lead_score} label={c.lead_label} />}
        {c.assignee_name && <span className="truncate">Phụ trách: {c.assignee_name}</span>}
      </div>
      {signals.length > 0 && <SignalChips signals={signals} />}
    </div>
  )
})
