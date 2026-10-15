"use client"

/**
 * Dialog "Thêm card" mở từ nút chính ở header `/kanban`: chọn cột
 * (mặc định cột đầu tiên chưa "Hoàn thành") + nhập tiêu đề. Tái dùng
 * `useCreateKanbanCard` như ô thêm nhanh trong từng cột.
 */
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InlineSelect } from "@/components/ui/inline-select"
import { Input } from "@/components/ui/input"
import { getApiErrorMessage } from "@/lib/api-client"
import { useKanbanBoardDetail } from "@/hooks/kanban/use-kanban-boards"
import { useCreateKanbanCard } from "@/hooks/kanban/use-kanban-cards"

interface KanbanAddCardDialogProps {
  boardId: number
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function KanbanAddCardDialog({ boardId, open, onOpenChange }: KanbanAddCardDialogProps) {
  const { data: board } = useKanbanBoardDetail(open ? boardId : null)
  const createCard = useCreateKanbanCard()
  const [title, setTitle] = useState("")
  const [columnId, setColumnId] = useState<number | null>(null)
  const columns = board?.columns ?? []

  useEffect(() => {
    if (!open) return
    setTitle("")
    setColumnId(null)
  }, [open, boardId])

  const effectiveColumnId = columnId ?? (columns.find((c) => !c.is_done) ?? columns[0])?.id ?? null

  const submit = () => {
    if (createCard.isPending) return
    const t = title.trim()
    if (!t) {
      toast.error("Tiêu đề card không được rỗng")
      return
    }
    if (effectiveColumnId == null) return
    createCard.mutate(
      { column_id: effectiveColumnId, title: t },
      {
        onSuccess: () => {
          toast.success("Đã thêm card")
          onOpenChange(false)
        },
        onError: (err) => toast.error(getApiErrorMessage(err, "Không thêm được card")),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Thêm card</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Tiêu đề</label>
            <Input
              autoFocus
              value={title}
              placeholder="Tiêu đề card…"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Cột</label>
            <InlineSelect<number>
              ariaLabel="Chọn cột"
              options={columns.map((c) => ({ value: c.id, label: c.name }))}
              value={effectiveColumnId}
              onChange={(v) => v != null && setColumnId(v)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button onClick={submit} disabled={createCard.isPending || effectiveColumnId == null}>
            Thêm card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
