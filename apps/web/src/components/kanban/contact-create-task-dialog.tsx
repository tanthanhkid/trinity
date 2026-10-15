"use client"

/**
 * Dialog "Tạo công việc" ở chi tiết Danh bạ — tạo card Kanban đã
 * gắn sẵn khách hàng (`contact_id`). TÁI DÙNG `POST /kanban/cards` (BE đã kiểm
 * quyền xem contact qua `assertContactLinkable` + quyền xem board), KHÔNG có
 * endpoint mới. Bảng/Cột chọn bằng `InlineSelect` dùng chung (dropdown inline,
 * không portal); Hạn xử lý dùng `VnDateTimeInput` (dd/mm/yyyy HH:mm).
 */
import { useEffect, useMemo } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { VnDateTimeInput } from "@/components/ui/vn-datetime-input"
import { InlineSelect } from "@/components/ui/inline-select"
import { vnLocalToIso } from "@/lib/vn-datetime"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getApiErrorMessage } from "@/lib/api-client"
import { useKanbanBoardDetail, useKanbanBoards } from "@/hooks/kanban/use-kanban-boards"
import { useCreateKanbanCard } from "@/hooks/kanban/use-kanban-cards"
import { KANBAN_PRIORITIES, type KanbanPriority } from "@/types/kanban"
import { KanbanUserPicker } from "./kanban-user-picker"

const PRIORITY_LABELS: Record<KanbanPriority, string> = {
  low: "Thấp",
  normal: "Bình thường",
  high: "Cao",
  urgent: "Khẩn cấp",
}

const schema = z.object({
  board_id: z.number({ message: "Chọn bảng công việc" }).int().min(1, "Chọn bảng công việc"),
  column_id: z.number({ message: "Chọn cột" }).int().min(1, "Chọn cột"),
  title: z.string().trim().min(1, "Nhập tiêu đề công việc").max(500, "Tối đa 500 ký tự"),
  description: z.string().max(10000, "Mô tả quá dài").optional(),
  /** `YYYY-MM-DDTHH:mm` (giờ VN) — rỗng = không đặt hạn. */
  due_date: z.string().optional(),
  priority: z.enum(KANBAN_PRIORITIES).nullable(),
  assignee_id: z.number().int().nullable(),
})
type FormValues = z.infer<typeof schema>

const EMPTY: FormValues = {
  board_id: 0,
  column_id: 0,
  title: "",
  description: "",
  due_date: "",
  priority: null,
  assignee_id: null,
}
const LABEL_CLASS = "mb-1 block text-xs font-medium text-muted-foreground"

interface Props {
  open: boolean
  onClose: () => void
  contactId: number
  contactName?: string | null
}

export function ContactCreateTaskDialog({ open, onClose, contactId, contactName }: Props) {
  const { register, handleSubmit, watch, setValue, reset, formState: { errors } } =
    useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY })
  const createCard = useCreateKanbanCard()
  const { data: boards = [] } = useKanbanBoards()
  const activeBoards = useMemo(() => boards.filter((b) => b.is_active), [boards])
  const boardId = watch("board_id")
  const { data: detail } = useKanbanBoardDetail(boardId > 0 ? boardId : null)
  const columns = useMemo(
    () => (detail?.columns ?? []).filter((c) => !c.is_archived).sort((a, b) => a.position - b.position),
    [detail],
  )

  useEffect(() => {
    if (open) reset(EMPTY)
  }, [open, reset])
  // Mặc định: board đầu tiên; cột đầu tiên chưa "hoàn thành" của board đang chọn.
  useEffect(() => {
    if (open && boardId === 0 && activeBoards[0]) setValue("board_id", activeBoards[0].id)
  }, [open, boardId, activeBoards, setValue])
  useEffect(() => {
    if (columns.length === 0) return
    const cur = watch("column_id")
    if (!columns.some((c) => c.id === cur)) {
      setValue("column_id", (columns.find((c) => !c.is_done) ?? columns[0]).id)
    }
  }, [columns, setValue, watch])

  const onSubmit = handleSubmit((v) => {
    createCard.mutate(
      {
        column_id: v.column_id,
        title: v.title,
        description: v.description?.trim() ? v.description.trim() : null,
        contact_id: contactId,
        assignee_id: v.assignee_id,
        due_at: v.due_date ? vnLocalToIso(v.due_date) : null,
        priority: v.priority,
      },
      {
        onSuccess: () => {
          toast.success("Đã tạo công việc")
          onClose()
        },
        onError: (e) => toast.error(getApiErrorMessage(e, "Không tạo được công việc")),
      },
    )
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>Tạo công việc{contactName ? ` cho ${contactName}` : ""}</DialogTitle>
          </DialogHeader>
          {activeBoards.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Chưa có bảng công việc nào bạn được dùng — liên hệ quản trị để tạo bảng.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL_CLASS}>Bảng</label>
                  <InlineSelect<number>
                    options={activeBoards.map((b) => ({ value: b.id, label: b.name }))}
                    value={boardId > 0 ? boardId : null}
                    onChange={(v) => {
                      setValue("board_id", v ?? 0, { shouldValidate: true })
                      setValue("column_id", 0)
                    }}
                    placeholder="Chọn bảng…"
                    ariaLabel="Bảng"
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS}>Cột</label>
                  <InlineSelect<number>
                    options={columns.map((c) => ({ value: c.id, label: c.name }))}
                    value={watch("column_id") > 0 ? watch("column_id") : null}
                    onChange={(v) => setValue("column_id", v ?? 0, { shouldValidate: true })}
                    placeholder="Chọn cột…"
                    ariaLabel="Cột"
                  />
                  {errors.column_id && <p className="mt-1 text-xs text-destructive">{errors.column_id.message}</p>}
                </div>
              </div>
              <div>
                <label className={LABEL_CLASS}>Tiêu đề</label>
                <Input autoFocus placeholder="VD: Liên hệ lại khách hàng" {...register("title")} />
                {errors.title && <p className="mt-1 text-xs text-destructive">{errors.title.message}</p>}
              </div>
              <div>
                <label className={LABEL_CLASS}>Mô tả</label>
                <Textarea rows={3} {...register("description")} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL_CLASS}>Hạn xử lý</label>
                  <VnDateTimeInput value={watch("due_date")} onChange={(v) => setValue("due_date", v)} ariaLabel="Hạn xử lý" />
                </div>
                <div>
                  <label className={LABEL_CLASS}>Người phụ trách</label>
                  <KanbanUserPicker value={watch("assignee_id")} onChange={(id) => setValue("assignee_id", id)} />
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {KANBAN_PRIORITIES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setValue("priority", watch("priority") === p ? null : p)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      watch("priority") === p
                        ? "border-primary/30 bg-primary/10 text-[var(--color-app-primary-ink)]"
                        : "border-input bg-background hover:bg-accent"
                    }`}
                  >
                    {PRIORITY_LABELS[p]}
                  </button>
                ))}
              </div>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Huỷ</Button>
            <Button type="submit" disabled={createCard.isPending || activeBoards.length === 0}>
              {createCard.isPending ? "Đang tạo…" : "Tạo công việc"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
