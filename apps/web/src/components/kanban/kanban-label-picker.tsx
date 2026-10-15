"use client"

/**
 * Picker "Nhãn" kiểu Trello — toggle nhãn có sẵn của board +
 * tạo/sửa/xoá nhãn ngay tại chỗ. Mirror khuôn dropdown inline của `kanban-user-picker.tsx`:
 * dropdown INLINE `position:absolute` trong `relative` container, KHÔNG dùng
 * `Popover`/`Select` Base-UI (portal ra `document.body` bên trong Dialog bị
 * "outside press" đóng nhầm cả Dialog).
 */
import { useState } from "react"
import { Pencil, Plus, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { getApiErrorMessage } from "@/lib/api-client"
import {
  useCreateKanbanLabel,
  useDeleteKanbanLabel,
  useUpdateKanbanLabel,
} from "@/hooks/kanban/use-kanban-labels"
import { KANBAN_LABEL_COLOR_PRESETS, type KanbanLabelDef } from "@/types/kanban"

interface KanbanLabelPickerProps {
  boardId: number
  labelDefs: KanbanLabelDef[]
  selectedIds: string[]
  onToggle: (labelId: string) => void
  disabled?: boolean
}

export function KanbanLabelPicker({
  boardId,
  labelDefs,
  selectedIds,
  onToggle,
  disabled = false,
}: KanbanLabelPickerProps) {
  const [open, setOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState("")
  const [draftColor, setDraftColor] = useState<string>(KANBAN_LABEL_COLOR_PRESETS[0])

  const createLabel = useCreateKanbanLabel(boardId)
  const updateLabel = useUpdateKanbanLabel(boardId)
  const deleteLabel = useDeleteKanbanLabel(boardId)

  const startCreate = () => {
    setEditingId("__new__")
    setDraftName("")
    setDraftColor(KANBAN_LABEL_COLOR_PRESETS[labelDefs.length % KANBAN_LABEL_COLOR_PRESETS.length])
  }

  const startEdit = (label: KanbanLabelDef) => {
    setEditingId(label.id)
    setDraftName(label.name)
    setDraftColor(label.color)
  }

  const cancelEdit = () => setEditingId(null)

  const saveEdit = () => {
    if (createLabel.isPending || updateLabel.isPending) return
    const name = draftName.trim()
    if (!name) {
      toast.error("Tên nhãn không được rỗng")
      return
    }
    if (editingId === "__new__") {
      createLabel.mutate(
        { name, color: draftColor },
        {
          onSuccess: () => setEditingId(null),
          onError: (err) => toast.error(getApiErrorMessage(err, "Không tạo được nhãn")),
        },
      )
    } else if (editingId) {
      updateLabel.mutate(
        { id: editingId, payload: { name, color: draftColor } },
        {
          onSuccess: () => setEditingId(null),
          onError: (err) => toast.error(getApiErrorMessage(err, "Không sửa được nhãn")),
        },
      )
    }
  }

  const removeLabel = (id: string) => {
    deleteLabel.mutate(id, {
      onSuccess: () => setDeletingId(null),
      onError: (err) => toast.error(getApiErrorMessage(err, "Không xoá được nhãn")),
    })
  }

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full justify-start"
      >
        Nhãn
      </Button>
      {open && !disabled && (
        <div className="absolute z-50 mt-1 w-72 rounded-lg border border-input bg-popover p-2.5 text-popover-foreground shadow-lg ring-1 ring-foreground/10">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Nhãn</p>
            <button type="button" onClick={() => setOpen(false)} aria-label="Đóng">
              <X className="size-3.5 text-muted-foreground" />
            </button>
          </div>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {labelDefs.length === 0 && (
              <p className="px-1 py-2 text-xs text-muted-foreground">Board chưa có nhãn nào.</p>
            )}
            {labelDefs.map((label) => (
              <div key={label.id} className="flex items-center gap-1.5">
                {editingId === label.id ? (
                  <LabelEditRow
                    name={draftName}
                    color={draftColor}
                    onNameChange={setDraftName}
                    onColorChange={setDraftColor}
                    onSave={saveEdit}
                    onCancel={cancelEdit}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onToggle(label.id)}
                      className="flex h-8 flex-1 items-center rounded-md px-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
                      style={{
                        backgroundColor: label.color,
                        outline: selectedIds.includes(label.id) ? "2px solid currentColor" : undefined,
                      }}
                    >
                      <span className="truncate">{label.name}</span>
                      {selectedIds.includes(label.id) && <span className="ml-auto">✓</span>}
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(label)}
                      className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      aria-label="Sửa nhãn"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeletingId(label.id)}
                      className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Xoá nhãn"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
            {editingId === "__new__" && (
              <LabelEditRow
                name={draftName}
                color={draftColor}
                onNameChange={setDraftName}
                onColorChange={setDraftColor}
                onSave={saveEdit}
                onCancel={cancelEdit}
              />
            )}
          </div>
          {editingId === null && (
            <Button type="button" variant="ghost" size="sm" className="mt-1.5 w-full justify-start text-xs" onClick={startCreate}>
              <Plus className="mr-1 size-3.5" /> Tạo nhãn mới
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={deletingId != null}
        onOpenChange={(o) => !o && setDeletingId(null)}
        title="Xoá nhãn"
        description="Xoá nhãn này? Sẽ gỡ khỏi mọi card đang gắn."
        confirmLabel="Xoá nhãn"
        pending={deleteLabel.isPending}
        onConfirm={() => {
          if (deletingId) removeLabel(deletingId)
        }}
      />
    </div>
  )
}

function LabelEditRow({
  name,
  color,
  onNameChange,
  onColorChange,
  onSave,
  onCancel,
}: {
  name: string
  color: string
  onNameChange: (v: string) => void
  onColorChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex w-full flex-col gap-1.5 rounded-md border border-border/60 p-2">
      <Input
        autoFocus
        value={name}
        placeholder="Tên nhãn…"
        onChange={(e) => onNameChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave()
          if (e.key === "Escape") onCancel()
        }}
        className="h-7 text-xs"
      />
      <div className="flex flex-wrap gap-1">
        {KANBAN_LABEL_COLOR_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onColorChange(preset)}
            className="size-5 rounded-full transition-transform"
            style={{
              backgroundColor: preset,
              transform: color === preset ? "scale(1.2)" : undefined,
              outline: color === preset ? "2px solid currentColor" : undefined,
            }}
            aria-label={preset}
          />
        ))}
      </div>
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>
          Huỷ
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onSave}>
          Lưu
        </Button>
      </div>
    </div>
  )
}
