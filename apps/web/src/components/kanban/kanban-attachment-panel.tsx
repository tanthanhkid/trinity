"use client"

/**
 * Đính kèm DẠNG LINK — không cần kho lưu file:
 * KHÔNG upload file, chỉ nhận URL sẵn có — vd link Google
 * Drive/ảnh đã có ở đâu đó).
 */
import { useState } from "react"
import { Link2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatDateTimeVn } from "@/lib/format"
import { getApiErrorMessage } from "@/lib/api-client"
import {
  useCreateKanbanAttachment,
  useDeleteKanbanAttachment,
  useKanbanAttachments,
} from "@/hooks/kanban/use-kanban-attachments"

export function KanbanAttachmentPanel({ cardId }: { cardId: number }) {
  const { data: attachments = [], isLoading } = useKanbanAttachments(cardId)
  const createAttachment = useCreateKanbanAttachment(cardId)
  const deleteAttachment = useDeleteKanbanAttachment(cardId)
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState("")
  const [title, setTitle] = useState("")

  const submit = () => {
    if (createAttachment.isPending) return
    const trimmedUrl = url.trim()
    if (!trimmedUrl) return
    createAttachment.mutate(
      { url: trimmedUrl, title: title.trim() || undefined },
      {
        onSuccess: () => {
          setUrl("")
          setTitle("")
          setAdding(false)
        },
        onError: (err) => toast.error(getApiErrorMessage(err, "Không thêm được đính kèm — kiểm tra lại URL")),
      },
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">Đính kèm (link)</p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Đang tải…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {attachments.map((a) => (
            <div key={a.id} className="group flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5">
              <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
              <a
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate text-sm text-primary hover:underline"
              >
                {a.title?.trim() || a.url}
              </a>
              <span className="shrink-0 text-sm text-muted-foreground">{formatDateTimeVn(a.created_at)}</span>
              <button
                type="button"
                onClick={() =>
                  deleteAttachment.mutate(a.id, {
                    onError: (err) => toast.error(getApiErrorMessage(err, "Không xoá được đính kèm")),
                  })
                }
                className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                aria-label="Xoá đính kèm"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="flex flex-col gap-1.5">
          <Input
            autoFocus
            value={url}
            placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
          />
          <Input
            value={title}
            placeholder="Tên hiển thị (tuỳ chọn)"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit()
              if (e.key === "Escape") setAdding(false)
            }}
          />
          <div className="flex gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={submit} disabled={createAttachment.isPending || !url.trim()}>
              Thêm
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Huỷ
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit justify-start text-xs text-muted-foreground"
          onClick={() => setAdding(true)}
        >
          <Plus className="mr-1 size-3.5" /> Đính kèm link
        </Button>
      )}
    </div>
  )
}
