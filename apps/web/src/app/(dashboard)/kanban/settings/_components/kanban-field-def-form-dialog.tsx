"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Plus, X } from "lucide-react"
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
import { KANBAN_FIELD_TYPES, type KanbanFieldDef, type KanbanFieldOption } from "@/types/kanban"
import {
  useCreateKanbanFieldDef,
  useUpdateKanbanFieldDef,
} from "@/hooks/kanban/use-kanban-field-defs"
import { InlineSelect } from "@/components/ui/inline-select"

const TYPE_LABELS: Record<string, string> = {
  text: "Văn bản",
  number: "Số",
  money: "Tiền (VNĐ)",
  date: "Ngày",
  select: "Lựa chọn (1)",
  multi_select: "Lựa chọn (nhiều)",
  user: "Người dùng",
  checkbox: "Có/Không",
  url: "Đường dẫn (URL)",
}

/** Giá trị mới không trùng giá trị đang có, kể cả sau khi xoá một lựa chọn ở giữa. */
function nextOptionValue(options: { value: string }[]): string {
  const used = new Set(options.map((o) => o.value))
  let n = options.length + 1
  while (used.has(`opt_${n}`)) n++
  return `opt_${n}`
}

const OPTION_TYPES = new Set(["select", "multi_select"])

interface KanbanFieldDefFormDialogProps {
  boardId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  fieldDef?: KanbanFieldDef | null
}

export function KanbanFieldDefFormDialog({
  boardId,
  open,
  onOpenChange,
  fieldDef,
}: KanbanFieldDefFormDialogProps) {
  const isEdit = fieldDef != null
  const create = useCreateKanbanFieldDef(boardId)
  const update = useUpdateKanbanFieldDef(boardId)
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  const [type, setType] = useState<string>("text")
  const [required, setRequired] = useState(false)
  const [showOnCard, setShowOnCard] = useState(false)
  const [options, setOptions] = useState<KanbanFieldOption[]>([])

  useEffect(() => {
    if (open) {
      setKey(fieldDef?.key ?? "")
      setLabel(fieldDef?.label ?? "")
      setType(fieldDef?.type ?? "text")
      setRequired(fieldDef?.required ?? false)
      setShowOnCard(fieldDef?.show_on_card ?? false)
      setOptions(fieldDef?.options ?? [])
    }
  }, [open, fieldDef])

  const submit = () => {
    const trimmedLabel = label.trim()
    if (!trimmedLabel) {
      toast.error("Nhãn không được rỗng")
      return
    }
    if (OPTION_TYPES.has(type) && options.length === 0) {
      toast.error("Cần ít nhất 1 lựa chọn")
      return
    }
    if (OPTION_TYPES.has(type) && options.some((o) => !o.label.trim())) {
      toast.error("Nhãn lựa chọn không được để trống")
      return
    }

    if (isEdit) {
      update
        .mutateAsync({
          id: fieldDef!.id,
          payload: {
            label: trimmedLabel,
            options: OPTION_TYPES.has(type) ? options : undefined,
            required,
            show_on_card: showOnCard,
          },
        })
        .then(() => {
          toast.success("Đã lưu trường")
          onOpenChange(false)
        })
        .catch((err) => toast.error(getApiErrorMessage(err, "Không lưu được trường")))
      return
    }

    const trimmedKey = key.trim()
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(trimmedKey)) {
      toast.error("Khoá kỹ thuật chỉ chứa chữ thường/số/gạch dưới, bắt đầu bằng chữ")
      return
    }
    create
      .mutateAsync({
        key: trimmedKey,
        label: trimmedLabel,
        type: type as never,
        options: OPTION_TYPES.has(type) ? options : undefined,
        required,
        show_on_card: showOnCard,
      })
      .then(() => {
        toast.success("Đã tạo trường")
        onOpenChange(false)
      })
      .catch((err) => toast.error(getApiErrorMessage(err, "Không tạo được trường")))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa trường tuỳ biến" : "Thêm trường tuỳ biến"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {!isEdit && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Khoá kỹ thuật (KHÔNG đổi được sau khi tạo)
              </label>
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="muc_do_uu_tien" />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Nhãn hiển thị</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          {!isEdit && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Kiểu dữ liệu</label>
              <InlineSelect<string>
                options={KANBAN_FIELD_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))}
                value={type}
                onChange={(v) => v != null && setType(v)}
                ariaLabel="Kiểu dữ liệu"
              />
            </div>
          )}
          {OPTION_TYPES.has(type) && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Danh sách lựa chọn</label>
              <div className="flex flex-col gap-1.5">
                {options.map((opt, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input
                      value={opt.label}
                      placeholder="Nhãn"
                      onChange={(e) => {
                        const next = [...options]
                        next[i] = { ...next[i], label: e.target.value, value: next[i].value || e.target.value }
                        setOptions(next)
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setOptions(options.filter((_, j) => j !== i))}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setOptions([...options, { value: nextOptionValue(options), label: "" }])
                  }
                >
                  <Plus className="mr-1 size-3.5" /> Thêm lựa chọn
                </Button>
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={required} onCheckedChange={(c) => setRequired(c === true)} />
            Bắt buộc nhập
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={showOnCard} onCheckedChange={(c) => setShowOnCard(c === true)} />
            Hiện trên mặt trước card (view Kanban)
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button onClick={submit} disabled={create.isPending || update.isPending}>
            {isEdit ? "Lưu thay đổi" : "Thêm trường"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
