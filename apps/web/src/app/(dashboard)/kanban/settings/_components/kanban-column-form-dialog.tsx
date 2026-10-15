"use client"

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
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { getApiErrorMessage } from "@/lib/api-client"
import { useCreateKanbanColumn, useUpdateKanbanColumn } from "@/hooks/kanban/use-kanban-columns"
import type { KanbanColumn } from "@/types/kanban"

interface KanbanColumnFormDialogProps {
  boardId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  column?: KanbanColumn | null
}

export function KanbanColumnFormDialog({
  boardId,
  open,
  onOpenChange,
  column,
}: KanbanColumnFormDialogProps) {
  const isEdit = column != null
  const create = useCreateKanbanColumn(boardId)
  const update = useUpdateKanbanColumn(boardId)
  const [name, setName] = useState("")
  const [color, setColor] = useState("")
  const [wipLimit, setWipLimit] = useState("")
  const [isDone, setIsDone] = useState(false)

  useEffect(() => {
    if (open) {
      setName(column?.name ?? "")
      setColor(column?.color ?? "")
      setWipLimit(column?.wip_limit != null ? String(column.wip_limit) : "")
      setIsDone(column?.is_done ?? false)
    }
  }, [open, column])

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error("Tên cột không được rỗng")
      return
    }
    const payload = {
      name: trimmed,
      color: color.trim() || null,
      wip_limit: wipLimit.trim() ? Number(wipLimit) : null,
      is_done: isDone,
    }
    const mutation = isEdit
      ? update.mutateAsync({ id: column!.id, payload })
      : create.mutateAsync(payload)
    mutation
      .then(() => {
        toast.success(isEdit ? "Đã lưu cột" : "Đã tạo cột")
        onOpenChange(false)
      })
      .catch((err) => toast.error(getApiErrorMessage(err, "Không lưu được cột")))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa cột" : "Thêm cột mới"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Tên cột</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Màu (hex, tuỳ chọn)</label>
            <Input value={color} onChange={(e) => setColor(e.target.value)} placeholder="#198754" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Giới hạn WIP (chỉ cảnh báo)
            </label>
            <Input
              type="number"
              value={wipLimit}
              onChange={(e) => setWipLimit(e.target.value)}
              min={1}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isDone} onCheckedChange={(c) => setIsDone(c === true)} />
            Đánh dấu là cột "Hoàn thành"
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button onClick={submit} disabled={create.isPending || update.isPending}>
            {isEdit ? "Lưu thay đổi" : "Thêm cột"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
