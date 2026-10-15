"use client"

/**
 * Lịch sử + bình luận của 1 card Kanban (timeline). Đọc `GET
 * /kanban/cards/:id/activities` (mirror gate card cha ở BE) + gửi bình
 * luận qua `POST /kanban/cards/:id/comments`. KHÔNG tự cuộn — modal cha giữ
 * đúng 1 thanh cuộn.
 */
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { MentionEditor } from "@/components/refs/mention-editor"
import { MentionText } from "@/components/refs/mention-text"
import { formatDateTimeVn } from "@/lib/format"
import { getApiErrorMessage } from "@/lib/api-client"
import {
  useAddKanbanComment,
  useKanbanCardActivities,
} from "@/hooks/kanban/use-kanban-card-activities"
import type { KanbanCardActivity, KanbanColumn } from "@/types/kanban"
import {
  ACTIVITY_TONE,
  activityLabel,
  describeActivity,
  type ActivityTone,
} from "./kanban-activity-describe"

const TONE_CLASS: Record<ActivityTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-primary/10 text-primary",
  success: "bg-emerald-100 text-emerald-800",
  danger: "bg-destructive/10 text-destructive",
}

/** Khớp KANBAN_COMMENT_MAX_LENGTH ở BE (create-comment.dto). */
const KANBAN_COMMENT_MAX = 5000

interface Props {
  cardId: number
  columns?: KanbanColumn[]
}

function ActivityItem({ a, columnName }: { a: KanbanCardActivity; columnName: (id: unknown) => string }) {
  const isComment = a.action === "comment"
  const tone = ACTIVITY_TONE[a.action] ?? "neutral"
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0 last:[&>span:first-child]:hidden">
      <span className="absolute left-[15px] top-8 bottom-0 w-px bg-border" aria-hidden />
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${TONE_CLASS[tone]}`}
        aria-hidden
      >
        {(a.actor_name ?? "HT").trim().charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="text-sm font-medium text-foreground">{a.actor_name ?? "Hệ thống"}</span>
          <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${TONE_CLASS[tone]}`}>
            {activityLabel(a.action)}
          </span>
          <span className="ml-auto">{formatDateTimeVn(a.created_at)}</span>
        </div>
        <p
          className={`mt-1 whitespace-pre-wrap break-words text-sm ${
            isComment ? "rounded-md border border-border/60 bg-background px-3 py-2" : "text-muted-foreground"
          }`}
        >
          {isComment ? <MentionText text={describeActivity(a, columnName)} /> : describeActivity(a, columnName)}
        </p>
      </div>
    </li>
  )
}

export function KanbanCardActivityPanel({ cardId, columns = [] }: Props) {
  const { data: activities = [], isLoading } = useKanbanCardActivities(cardId)
  const addComment = useAddKanbanComment(cardId)
  const [draft, setDraft] = useState("")

  const columnName = (id: unknown) =>
    columns.find((c) => c.id === id)?.name ?? "đã xoá"

  const submit = () => {
    const content = draft.trim()
    if (!content) return
    addComment.mutate(content, {
      onSuccess: () => setDraft(""),
      onError: (err) => toast.error(getApiErrorMessage(err, "Không gửi được bình luận")),
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <MentionEditor
            value={draft}
            onChange={(v) => setDraft(v ?? "")}
            onSubmit={submit}
            placeholder="Viết bình luận… gõ @ để gắn thẻ (Ctrl/⌘ + Enter để gửi)"
            rows={2}
            maxLength={KANBAN_COMMENT_MAX}
          />
        </div>
        <Button type="button" onClick={submit} disabled={addComment.isPending || !draft.trim()}>
          Gửi
        </Button>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Đang tải lịch sử…</p>
      ) : activities.length === 0 ? (
        <p className="text-sm text-muted-foreground">Chưa có hoạt động nào.</p>
      ) : (
        <ul className="flex flex-col">
          {activities.map((a) => (
            <ActivityItem key={a.id} a={a} columnName={columnName} />
          ))}
        </ul>
      )}
    </div>
  )
}
