"use client"

/**
 * Checklist card kiểu Trello — thanh tiến độ x/y + thêm/tích/xoá
 * mục. Sắp xếp lại (`POST .../reorder`) đã có ở BE nhưng CHƯA wire kéo-thả ở
 * UI (danh sách checklist thường ngắn).
 */
import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { getApiErrorMessage } from "@/lib/api-client"
import {
  useCreateKanbanChecklistItem,
  useDeleteKanbanChecklistItem,
  useKanbanChecklist,
  useUpdateKanbanChecklistItem,
} from "@/hooks/kanban/use-kanban-checklist"

export function KanbanChecklistPanel({ cardId }: { cardId: number }) {
  const { data: items = [], isLoading } = useKanbanChecklist(cardId)
  const createItem = useCreateKanbanChecklistItem(cardId)
  const updateItem = useUpdateKanbanChecklistItem(cardId)
  const deleteItem = useDeleteKanbanChecklistItem(cardId)
  const [draft, setDraft] = useState("")
  const [adding, setAdding] = useState(false)

  const total = items.length
  const done = items.filter((i) => i.is_done).length
  const percent = total > 0 ? Math.round((done / total) * 100) : 0

  const submit = () => {
    if (createItem.isPending) return
    const text = draft.trim()
    if (!text) {
      setAdding(false)
      return
    }
    createItem.mutate(
      { text },
      {
        onSuccess: () => setDraft(""),
        onError: (err) => toast.error(getApiErrorMessage(err, "Không thêm được mục checklist")),
      },
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">Việc cần làm</p>
      {total > 0 && (
        <div className="flex items-center gap-2">
          <span className="w-9 shrink-0 text-xs text-muted-foreground">{percent}%</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {done}/{total}
          </span>
        </div>
      )}

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Đang tải…</p>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((item) => (
            <div key={item.id} className="group flex items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/50">
              <Checkbox
                checked={item.is_done}
                onCheckedChange={(checked) =>
                  updateItem.mutate(
                    { id: item.id, payload: { is_done: checked === true } },
                    { onError: (err) => toast.error(getApiErrorMessage(err, "Không cập nhật được")) },
                  )
                }
                className="mt-0.5"
              />
              <span className={`flex-1 text-sm ${item.is_done ? "text-muted-foreground line-through" : ""}`}>
                {item.text}
              </span>
              <button
                type="button"
                onClick={() =>
                  deleteItem.mutate(item.id, {
                    onError: (err) => toast.error(getApiErrorMessage(err, "Không xoá được mục")),
                  })
                }
                className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                aria-label="Xoá mục"
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
            value={draft}
            placeholder="Thêm mục…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit()
              if (e.key === "Escape") {
                setAdding(false)
                setDraft("")
              }
            }}
          />
          <div className="flex gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={submit} disabled={createItem.isPending}>
              Thêm
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false)
                setDraft("")
              }}
            >
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
          <Plus className="mr-1 size-3.5" /> Thêm mục
        </Button>
      )}
    </div>
  )
}
