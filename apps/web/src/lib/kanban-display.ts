import type { ShellBadgeTone } from "@/components/app-shell/badge"
import type { KanbanPriority } from "@/types/kanban"

/** Nhãn tiếng Việt + tông màu theo cấp độ ưu tiên của card Kanban. */
export const KANBAN_PRIORITY_LABELS: Record<KanbanPriority, string> = {
  low: "Thấp",
  normal: "Bình thường",
  high: "Cao",
  urgent: "Khẩn cấp",
}

export const KANBAN_PRIORITY_TONES: Record<KanbanPriority, ShellBadgeTone> = {
  low: "slate",
  normal: "blue",
  high: "amber",
  urgent: "red",
}

export function kanbanPriorityLabel(p: string | null | undefined): string | null {
  if (!p) return null
  return KANBAN_PRIORITY_LABELS[p as KanbanPriority] ?? null
}

export function kanbanPriorityTone(p: string | null | undefined): ShellBadgeTone {
  return KANBAN_PRIORITY_TONES[p as KanbanPriority] ?? "slate"
}
