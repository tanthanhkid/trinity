"use client"

/**
 * Dialog chi tiết card Kanban (kiểu Trello) — tự tải card + board (nhãn/field defs) theo `cardId`, dùng được ở CẢ
 * board view lẫn tab "Công việc" của Danh bạ. Bố cục 2 CỘT kiểu Trello: cột
 * trái = nội dung (mô tả/nhãn/người phụ trách/checklist/đính kèm), cột phải
 * = lịch sử + bình luận.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { MarkdownWithMentions } from "@/components/refs/markdown-with-mentions"
import { MentionEditor } from "@/components/refs/mention-editor"
import { toast } from "sonner"
import { Eye, Pencil } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { RecordCode } from "@/components/custom-objects/record-code"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { VnDateTimeInput } from "@/components/ui/vn-datetime-input"
import { isoToVnLocal, vnLocalToIso } from "@/lib/vn-datetime"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { getApiErrorMessage } from "@/lib/api-client"
import { formatDateTimeVn } from "@/lib/format"
import { useAuth } from "@/hooks/use-auth"
import { usePermissions } from "@/lib/rbac"
import { useKanbanBoardDetail } from "@/hooks/kanban/use-kanban-boards"
import { useDeleteKanbanCardWithUndo, useKanbanCard, useUpdateKanbanCard } from "@/hooks/kanban/use-kanban-cards"
import { KanbanUserPicker } from "./kanban-user-picker"
import { KanbanMultiUserPicker } from "./kanban-multi-user-picker"
import { KanbanContactPicker } from "./kanban-contact-picker"
import { KanbanAttributeField } from "./kanban-attribute-field"
import { KanbanCardActivityPanel } from "./kanban-card-activity-panel"
import { KanbanLabelPicker } from "./kanban-label-picker"
import { KanbanChecklistPanel } from "./kanban-checklist-panel"
import { KanbanAttachmentPanel } from "./kanban-attachment-panel"
import { KANBAN_PRIORITIES, type KanbanPriority } from "@/types/kanban"

const PRIORITY_LABELS: Record<KanbanPriority, string> = {
  low: "Thấp",
  normal: "Bình thường",
  high: "Cao",
  urgent: "Khẩn cấp",
}

interface KanbanCardDialogProps {
  cardId: number | null
  onClose: () => void
}

export function KanbanCardDialog({ cardId, onClose }: KanbanCardDialogProps) {
  const { user } = useAuth()
  const { can, isAdmin } = usePermissions()
  const { data: card, isLoading, isError } = useKanbanCard(cardId)
  // Callback qua ref — KHÔNG đưa `onClose` vào deps của effect.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Deep link `/kanban?card=<id>` có thể trỏ card đã xoá / ngoài quyền (BE 404):
  // báo rõ + đóng, KHÔNG để skeleton quay mãi.
  useEffect(() => {
    if (isError && cardId != null) {
      toast.error("Không mở được công việc này — có thể đã bị xoá hoặc bạn không có quyền xem.")
      onCloseRef.current()
    }
  }, [isError, cardId])
  const { data: board } = useKanbanBoardDetail(card?.board_id ?? null)
  const updateCard = useUpdateKanbanCard()
  const deleteCard = useDeleteKanbanCardWithUndo()

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [descPreview, setDescPreview] = useState(false)

  useEffect(() => {
    if (card) {
      setTitle(card.title)
      setDescription(card.description ?? "")
      setDescPreview(false)
    }
  }, [card])

  // Trường tuỳ biến: giữ giá trị đang gõ ở local (ô nhập không bị server data kéo lùi), gửi CHỈ key vừa đổi (BE merge theo key)
  // nên hai trường sửa liền nhau không ghi đè nhau; ô văn bản/số gom 600ms rồi mới PATCH thay vì mỗi phím một lần.
  const [attrDraft, setAttrDraft] = useState<Record<string, unknown>>({})
  const attrTimer = useRef<number | null>(null)
  const attrPending = useRef<Record<string, unknown>>({})
  const updateCardRef = useRef(updateCard)
  useEffect(() => { updateCardRef.current = updateCard }, [updateCard])
  useEffect(() => {
    setAttrDraft({})
    const id = cardId
    return () => {
      if (attrTimer.current !== null) window.clearTimeout(attrTimer.current)
      attrTimer.current = null
      const pending = attrPending.current
      attrPending.current = {}
      if (id != null && Object.keys(pending).length > 0) updateCardRef.current.mutate({ id, payload: { attributes: pending } })
    }
  }, [cardId])

  const labelDefs = useMemo(() => board?.label_defs ?? [], [board])
  const cardLabels = useMemo(() => new Set(card?.labels ?? []), [card])

  if (cardId == null) return null

  const patch = (payload: Record<string, unknown>) => {
    if (!cardId) return
    updateCard.mutate(
      { id: cardId, payload },
      { onError: (err) => toast.error(getApiErrorMessage(err, "Không lưu được thay đổi")) },
    )
  }

  const flushAttrs = () => {
    attrTimer.current = null
    const pending = attrPending.current
    attrPending.current = {}
    if (Object.keys(pending).length > 0) patch({ attributes: pending })
  }
  const changeAttr = (def: { key: string; type: string }, value: unknown) => {
    setAttrDraft((d) => ({ ...d, [def.key]: value }))
    attrPending.current = { ...attrPending.current, [def.key]: value }
    if (attrTimer.current !== null) window.clearTimeout(attrTimer.current)
    if (["text", "url", "number", "money"].includes(def.type)) attrTimer.current = window.setTimeout(flushAttrs, 600)
    else flushAttrs()
  }

  const handleDelete = () => {
    if (!cardId) return
    // Xoá có 5 giây hoàn tác (toast "Hoàn tác"); lệnh xoá gửi sau khi hết hạn.
    deleteCard(cardId, card?.title)
    setConfirmDelete(false)
    onClose()
  }

  // Xoá card: khớp BE `KanbanCardsService.remove` — người tạo card hoặc Quản trị
  // (KHÔNG suy từ scope `kanban.manage`: BE trả 403 cho người giữ quyền rộng nhưng không phải Quản trị).
  const canDelete = card
    ? isAdmin || (user?.id != null && user.id === card.created_by)
    : false
  const canLinkContact = can("contacts.view")

  return (
    <>
    <Dialog open={cardId != null} onOpenChange={(open) => !open && onClose()}>
      {/* `sm:max-w-*` PHẢI khai báo — dialog.tsx mặc định `sm:max-w-sm` thắng `max-w-4xl` trần → modal chỉ 384px, cột vỡ. 1 thanh cuộn duy nhất ở đây. */}
      <DialogContent className="flex max-h-[90vh] w-[95vw] max-w-[95vw] flex-col gap-0 overflow-y-auto p-0 sm:max-w-5xl">
        {isLoading || !card ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
            <DialogHeader className="border-b px-6 pb-3 pt-5">
              <DialogTitle className="flex items-center gap-2">
                <RecordCode code={card.code} />
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => title.trim() && title !== card.title && patch({ title: title.trim() })}
                  className="border-none px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
                />
              </DialogTitle>
            </DialogHeader>

            <div className="grid grid-cols-1 gap-0 md:grid-cols-[minmax(280px,30%)_1fr]">
              <div className="flex min-w-0 flex-col gap-5 p-5 md:border-r">
                {/* Hàng nhãn/người phụ trách/hạn/ưu tiên — mirror badge dưới tiêu đề của Trello */}
                <div className="grid gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Nhãn</label>
                    <KanbanLabelPicker
                      boardId={card.board_id}
                      labelDefs={labelDefs}
                      selectedIds={card.labels}
                      onToggle={(labelId) => {
                        const next = cardLabels.has(labelId)
                          ? card.labels.filter((l) => l !== labelId)
                          : [...card.labels, labelId]
                        patch({ labels: next })
                      }}
                    />
                    {card.labels.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {card.labels.map((id) => {
                          const def = labelDefs.find((l) => l.id === id)
                          return (
                            <span
                              key={id}
                              className="rounded-full px-2 py-0.5 text-sm font-medium text-white"
                              style={{ backgroundColor: def?.color ?? "#9ca3af" }}
                            >
                              {def?.name ?? "(đã xoá)"}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Người phụ trách</label>
                    <KanbanMultiUserPicker
                      value={card.assignee_ids}
                      onChange={(assignee_ids) => patch({ assignee_ids })}
                    />
                  </div>
                </div>

                <div className="grid gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Hạn xử lý</label>
                    <div className="flex items-center gap-2">
                      <VnDateTimeInput
                        ariaLabel="Hạn xử lý"
                        value={isoToVnLocal(card.due_at)}
                        onChange={(next) =>
                          patch({
                            due_at: next ? vnLocalToIso(next) : null,
                            ...(next ? {} : { due_completed_at: null }),
                          })
                        }
                      />
                      {card.due_at && (
                        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <Checkbox
                            checked={card.due_completed_at != null}
                            onCheckedChange={(checked) =>
                              patch({ due_completed_at: checked === true ? new Date().toISOString() : null })
                            }
                          />
                          Hoàn thành
                        </label>
                      )}
                    </div>
                    {card.is_overdue && (
                      <p className="mt-1 text-xs font-medium text-destructive">Đã quá hạn</p>
                    )}
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Mức ưu tiên</label>
                    <div className="flex flex-wrap gap-1.5">
                      {KANBAN_PRIORITIES.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => patch({ priority: card.priority === p ? null : p })}
                          className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                            card.priority === p
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-input bg-background hover:bg-accent"
                          }`}
                        >
                          {PRIORITY_LABELS[p]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Khách hàng</label>
                  {canLinkContact ? (
                    <KanbanContactPicker
                      value={card.contact_id}
                      valueLabel={card.contact?.full_name}
                      onChange={(contactId) => patch({ contact_id: contactId })}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Vai trò của bạn không xem được thông tin khách hàng.
                    </p>
                  )}
                  {canLinkContact && card.contact && (
                    <p className="mt-1 text-xs text-muted-foreground">SĐT: {card.contact.phone}</p>
                  )}
                  {canLinkContact && card.contact_id != null && !card.contact && (
                    <p className="mt-1 text-xs text-muted-foreground">— (không xem được thông tin khách hàng này)</p>
                  )}
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Mô tả</label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setDescPreview((v) => !v)}
                    >
                      {descPreview ? (
                        <>
                          <Pencil className="mr-1 size-3" /> Sửa
                        </>
                      ) : (
                        <>
                          <Eye className="mr-1 size-3" /> Xem trước
                        </>
                      )}
                    </Button>
                  </div>
                  {descPreview ? (
                    <div
                      className="min-h-[84px] cursor-text rounded-md border border-border/60 p-3 text-sm [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
                      onClick={() => setDescPreview(false)}
                    >
                      {description.trim() ? (
                        <MarkdownWithMentions text={description} />
                      ) : (
                        <p className="text-muted-foreground">Chưa có mô tả — bấm để soạn.</p>
                      )}
                    </div>
                  ) : (
                    <MentionEditor
                      value={description}
                      onChange={(v) => setDescription(v ?? "")}
                      onBlur={() => description !== (card.description ?? "") && patch({ description: description || null })}
                      rows={4}
                      maxLength={10000}
                      placeholder="Hỗ trợ Markdown — **đậm**, *nghiêng*, danh sách. Gõ @ để gắn thẻ khách hàng, công việc, bản ghi khác (vd @KH001)"
                    />
                  )}
                </div>

                {board && board.field_defs.length > 0 && (
                  <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Trường tuỳ biến</p>
                    {board.field_defs.map((def) => (
                      <div key={def.id}>
                        <label className="mb-1 block text-xs text-muted-foreground">
                          {def.label}
                          {def.required && <span className="text-destructive"> *</span>}
                        </label>
                        <KanbanAttributeField
                          def={def}
                          value={def.key in attrDraft ? attrDraft[def.key] : card.attributes[def.key]}
                          onChange={(value) => changeAttr(def, value)}
                        />
                      </div>
                    ))}
                  </div>
                )}

                <KanbanChecklistPanel cardId={card.id} />
                <KanbanAttachmentPanel cardId={card.id} />

                {/* Fallback picker đơn — giữ tương thích cho ai quen thao tác "1 người phụ trách"
                   (assignee_id vẫn là primary hiển thị ở mini-card).
                   ⚠️ PHẢI gửi `assignee_ids` (giữ nguyên mọi người phụ trách BỔ SUNG,
                   chỉ đổi/đặt primary lên đầu mảng) — gửi `assignee_id` ĐƠN ĐỘC sẽ bị
                   BE hiểu là "replace-all" (`resolveAssigneeIds`) và ÂM THẦM XOÁ mọi
                   người phụ trách khác đã thêm qua picker "Người phụ trách" phía trên. */}
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">Người phụ trách chính (nâng cao)</summary>
                  <div className="mt-2">
                    <KanbanUserPicker
                      value={card.assignee_id}
                      onChange={(userId) => {
                        const others = card.assignee_ids.filter((id) => id !== card.assignee_id)
                        const next = userId != null ? [userId, ...others.filter((id) => id !== userId)] : others
                        patch({ assignee_ids: next })
                      }}
                    />
                  </div>
                </details>
              </div>

              <div className="flex min-w-0 flex-col gap-3 border-t bg-muted/20 p-5 md:border-t-0">
                <p className="text-sm font-semibold">Hoạt động & bình luận</p>
                <KanbanCardActivityPanel cardId={card.id} columns={board?.columns} />
                <p className="mt-auto pt-3 text-sm text-muted-foreground">
                  Tạo lúc {formatDateTimeVn(card.created_at)}
                </p>
              </div>
            </div>

            <DialogFooter className="sticky bottom-0 z-10 mx-0 mb-0 justify-between rounded-none border-t bg-background px-6 py-3 sm:justify-between">
              {canDelete ? (
                <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
                  Xoá card
                </Button>
              ) : (
                <span />
              )}
              <Button variant="outline" onClick={onClose}>
                Đóng
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Xoá card"
        description="Card biến khỏi bảng ngay; bạn có 5 giây để bấm Hoàn tác trước khi xoá hẳn."
        confirmLabel="Xoá card"
        onConfirm={handleDelete}
      />
    </>
  )
}
