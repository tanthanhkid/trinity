"use client"

/**
 * Xoá cột — BẮT BUỘC chọn cột đích nếu còn card ("không xoá im
 * lặng"). BE trả 400 nếu thiếu `move_to_column_id` mà cột còn card — dialog
 * này LUÔN hỏi trước, không đợi lỗi mới hỏi.
 */
import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { getApiErrorMessage } from "@/lib/api-client"
import { useDeleteKanbanColumn } from "@/hooks/kanban/use-kanban-columns"
import type { KanbanColumn } from "@/types/kanban"
import { InlineSelect } from "@/components/ui/inline-select"

interface KanbanDeleteColumnDialogProps {
  boardId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  column: KanbanColumn | null
  otherColumns: KanbanColumn[]
}

export function KanbanDeleteColumnDialog({
  boardId,
  open,
  onOpenChange,
  column,
  otherColumns,
}: KanbanDeleteColumnDialogProps) {
  const del = useDeleteKanbanColumn(boardId)
  const [moveToId, setMoveToId] = useState<number | "">("")

  // Dialog luôn mounted: đổi cột / mở lại thì xoá lựa chọn cũ (tránh dồn card vào chính cột đang xoá).
  const columnId = column?.id
  useEffect(() => {
    setMoveToId("")
  }, [columnId, open])

  if (!column) return null

  const submit = () => {
    const target = otherColumns.some((c) => c.id === moveToId) ? moveToId : ""
    del
      .mutateAsync({
        id: column.id,
        moveToColumnId: target === "" ? undefined : target,
      })
      .then((result) => {
        toast.success(
          result.moved_cards > 0 ? `Đã xoá cột, dồn ${result.moved_cards} card` : "Đã xoá cột",
        )
        onOpenChange(false)
        setMoveToId("")
      })
      .catch((err) => toast.error(getApiErrorMessage(err, "Không xoá được cột — cột có thể còn card")))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Xoá cột "{column.name}"</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Nếu cột còn card, PHẢI chọn cột đích để dồn card sang trước khi xoá.
        </p>
        <InlineSelect<number>
          options={otherColumns.map((c) => ({ value: c.id, label: c.name }))}
          value={moveToId === "" ? null : moveToId}
          onChange={(v) => setMoveToId(v ?? "")}
          clearLabel="— Không cần (cột đang rỗng) —"
          placeholder="— Không cần (cột đang rỗng) —"
          ariaLabel="Cột đích"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button variant="destructive" onClick={submit} disabled={del.isPending}>
            Xoá cột
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
