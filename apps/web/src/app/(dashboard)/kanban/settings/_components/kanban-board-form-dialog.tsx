"use client"

/**
 * Tạo/Sửa board (RBAC quyền+phạm vi — `kanban.boards`). `visibility_role_ids`
 * rỗng = mọi người có `kanban.view` đều thấy — danh sách vai trò để tick lấy
 * ĐỘNG từ `GET /roles` (tên vai trò do admin tự đặt, không còn 11 mã cố định).
 */
import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
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
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import apiClient, { getApiErrorMessage } from "@/lib/api-client"
import { useCreateKanbanBoard, useUpdateKanbanBoard } from "@/hooks/kanban/use-kanban-boards"
import type { KanbanBoard } from "@/types/kanban"

interface RoleOption {
  id: number
  name: string
  is_system: boolean
  member_count: number
}

function useRoleOptions() {
  return useQuery<RoleOption[]>({
    queryKey: ["roles", "list"],
    queryFn: () => apiClient.get("/roles").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  })
}

interface KanbanBoardFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  board?: KanbanBoard | null
}

export function KanbanBoardFormDialog({ open, onOpenChange, board }: KanbanBoardFormDialogProps) {
  const isEdit = board != null
  const create = useCreateKanbanBoard()
  const update = useUpdateKanbanBoard()
  const { data: roleOptions = [] } = useRoleOptions()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [cardPrefix, setCardPrefix] = useState("")
  const [visibilityRoleIds, setVisibilityRoleIds] = useState<number[]>([])

  useEffect(() => {
    if (open) {
      setName(board?.name ?? "")
      setDescription(board?.description ?? "")
      setCardPrefix(board?.card_prefix ?? "")
      setVisibilityRoleIds(board?.visibility_role_ids ?? [])
    }
  }, [open, board])

  const toggleRole = (roleId: number) => {
    setVisibilityRoleIds((prev) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId],
    )
  }

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error("Tên board không được rỗng")
      return
    }
    const payload = {
      name: trimmed,
      description: description.trim() || null,
      card_prefix: cardPrefix.trim() || null,
      visibility_role_ids: visibilityRoleIds,
    }
    const mutation = isEdit
      ? update.mutateAsync({ id: board!.id, payload })
      : create.mutateAsync(payload)
    mutation
      .then(() => {
        toast.success(isEdit ? "Đã lưu board" : "Đã tạo board")
        onOpenChange(false)
      })
      .catch((err) => toast.error(getApiErrorMessage(err, "Không lưu được board")))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa board" : "Tạo board mới"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Tên board</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Mô tả</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Tiền tố mã card (vd "CV-")
            </label>
            <Input value={cardPrefix} onChange={(e) => setCardPrefix(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Vai trò được thấy bảng này (bỏ trống = mọi người có quyền xem công việc)
            </label>
            <div className="grid grid-cols-2 gap-1.5 rounded-md border p-2">
              {roleOptions.length === 0 && (
                <p className="col-span-2 text-xs text-muted-foreground">
                  Chưa có vai trò nào để chọn.
                </p>
              )}
              {roleOptions.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={visibilityRoleIds.includes(r.id)}
                    onCheckedChange={() => toggleRole(r.id)}
                  />
                  {r.name}
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button onClick={submit} disabled={create.isPending || update.isPending}>
            {isEdit ? "Lưu thay đổi" : "Tạo board"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
