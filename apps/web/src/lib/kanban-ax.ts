/**
 * Hàm thuần cho giao diện «Ánh xanh» của màn Công việc/Cơ hội (kanban): hạn nhanh, chữ hạn trên thẻ,
 * tông giai đoạn theo vị trí cột. Mọi giờ theo múi giờ VN (+07:00) như `lib/vn-datetime`.
 */
import { isoToVnLocal, vnLocalToIso } from "@/lib/vn-datetime"
import type { StageTone } from "@/components/ui/stage-chip"
import type { KanbanCard, KanbanPriority } from "@/types/kanban"

export type DuePresetKey = "today" | "tomorrow" | "nextweek" | "none"

export const KANBAN_DUE_PRESETS: { key: DuePresetKey; label: string }[] = [
  { key: "today", label: "Hôm nay" },
  { key: "tomorrow", label: "Ngày mai" },
  { key: "nextweek", label: "Tuần sau" },
  { key: "none", label: "Bỏ hạn" },
]

const DUE_RULE: Record<Exclude<DuePresetKey, "none">, { addDays: number; time: string }> = {
  today: { addDays: 0, time: "17:00" },
  tomorrow: { addDays: 1, time: "09:00" },
  nextweek: { addDays: 7, time: "09:00" },
}

/** `YYYY-MM-DD` của ngày VN hôm nay cộng `addDays`. */
function vnDay(addDays: number, now: Date): string {
  return new Date(now.getTime() + 7 * 3600_000 + addDays * 86_400_000).toISOString().slice(0, 10)
}

/** Hạn nhanh → ISO UTC để gửi máy chủ (`null` = bỏ hạn). Hôm nay 17:00, ngày mai 09:00, tuần sau (+7 ngày) 09:00. */
export function dueIsoFromPreset(key: DuePresetKey, now: Date = new Date()): string | null {
  if (key === "none") return null
  const r = DUE_RULE[key]
  return vnLocalToIso(`${vnDay(r.addDays, now)}T${r.time}`)
}

/** Hạn của thẻ đang khớp mốc nhanh nào (không khớp ⇒ `null`; hạn tự chọn ở hộp đầy đủ). */
export function matchDuePreset(dueAt: string | null | undefined, now: Date = new Date()): DuePresetKey | null {
  if (!dueAt) return null
  const local = isoToVnLocal(dueAt)
  for (const key of ["today", "tomorrow", "nextweek"] as const) {
    const r = DUE_RULE[key]
    if (local === `${vnDay(r.addDays, now)}T${r.time}`) return key
  }
  return null
}

/** `dd/MM` theo giờ VN từ ISO; rỗng nếu sai. */
export function vnDayMonth(iso: string | null | undefined): string {
  const local = isoToVnLocal(iso)
  return local ? `${local.slice(8, 10)}/${local.slice(5, 7)}` : ""
}

/** `dd/MM/yyyy HH:mm` theo giờ VN từ ISO; rỗng nếu sai. */
export function vnFullDue(iso: string | null | undefined): string {
  const local = isoToVnLocal(iso)
  return local ? `${local.slice(8, 10)}/${local.slice(5, 7)}/${local.slice(0, 4)} ${local.slice(11, 16)}` : ""
}

export interface DueMeta {
  text: string
  tone: "none" | "normal" | "overdue" | "done"
}

/** Chữ hạn trên thẻ: «Quá hạn 26/11» · «Hạn 28/11» · «25/11 · xong» · «Chưa đặt hạn». */
export function dueMeta(card: Pick<KanbanCard, "due_at" | "due_completed_at" | "is_overdue">): DueMeta {
  if (!card.due_at) return { text: "Chưa đặt hạn", tone: "none" }
  const dm = vnDayMonth(card.due_at)
  if (card.due_completed_at != null) return { text: `${dm} · xong`, tone: "done" }
  if (card.is_overdue) return { text: `Quá hạn ${dm}`, tone: "overdue" }
  return { text: `Hạn ${dm}`, tone: "normal" }
}

export const DUE_TONE_CLASS: Record<DueMeta["tone"], string> = {
  none: "font-normal text-ax-ink-3",
  normal: "font-medium text-ax-ink-2",
  overdue: "font-semibold text-[var(--ax-danger)]",
  done: "font-medium text-[var(--ax-success)]",
}

/** Chấm ưu tiên (token «Ánh xanh»). */
export const KANBAN_PRIORITY_DOT: Record<KanbanPriority, string> = {
  low: "var(--ax-ink-3)",
  normal: "var(--ax-primary)",
  high: "var(--ax-warn)",
  urgent: "var(--ax-danger)",
}

const STAGE_TONE_CYCLE: StageTone[] = ["new", "consult", "quote", "won", "care"]

/** Tông giai đoạn theo vị trí cột (cột đánh dấu hoàn tất luôn là «won»). */
export function stageToneForColumn(index: number, isDone: boolean): StageTone {
  if (isDone) return "won"
  return STAGE_TONE_CYCLE[index % STAGE_TONE_CYCLE.length]
}
