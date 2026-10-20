"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { DndContext, DragOverlay, PointerSensor, useDraggable, useSensor, useSensors, type DragStartEvent } from "@dnd-kit/core"
import { motion, MotionConfig } from "motion/react"
import { KanbanSquare, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { useCustomRecordMutations, useCustomRecords } from "@/hooks/custom-objects/use-custom-objects"
import { useBoardDrag } from "@/hooks/use-board-drag"
import { getApiErrorMessage } from "@/lib/api-client"
import { formatNumberVn } from "@/lib/custom-objects/format-value"
import { CSS_EASE_ENTER, motionTokens } from "@/lib/motion-tokens"
import { usePermissions } from "@/lib/rbac"
import { cn } from "@/lib/utils"
import type { CustomFieldDef, CustomObjectDef, CustomRecord, CustomViewDef, SelectChoice } from "@/types/custom-objects"
import { CustomFieldValue } from "./custom-field-value"
import { RecordCode } from "./record-code"
import { ViewTabs } from "./view-tabs"

const PER_COLUMN = 50
const CARD_FRAME = "space-y-1 rounded-[var(--radius)] border bg-card p-3 text-sm shadow-sm"

function KanbanCardBody({ def, record, cardFields }: { def: CustomObjectDef; record: CustomRecord; cardFields: CustomFieldDef[] }) {
  return (
    <>
      <div className="flex items-start gap-1.5">
        <RecordCode code={record.code} />
        <Link href={`/x/${def.key}/${record.id}`} className="font-semibold text-primary underline-offset-2 hover:underline">{record.title ?? `#${record.id}`}</Link>
      </div>
      {cardFields.map((f) => (
        <div key={f.key} className="flex gap-1 text-xs text-muted-foreground"><span className="shrink-0">{f.label}:</span> <CustomFieldValue field={f} record={record} /></div>
      ))}
      {record.owner_name && <p className="text-xs text-muted-foreground">Phụ trách: {record.owner_name}</p>}
    </>
  )
}

function KanbanCard({ def, record, cardFields, canMove, placeholderHeight }: { def: CustomObjectDef; record: CustomRecord; cardFields: CustomFieldDef[]; canMove: boolean; placeholderHeight?: number }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `rec-${record.id}`, data: { record }, disabled: !canMove })
  // Đang kéo thẻ này: chỉ còn ô giữ chỗ viền đứt ở vị trí sẽ thả, bản thật nằm trong DragOverlay.
  if (isDragging) {
    return <div ref={setNodeRef} style={{ height: placeholderHeight ?? 72 }} className="rounded-[var(--radius)] border-2 border-dashed border-primary/40 bg-primary/5" />
  }
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={cn(CARD_FRAME, "touch-manipulation", canMove && "cursor-grab active:cursor-grabbing")} data-testid="kanban-card">
      <KanbanCardBody def={def} record={record} cardFields={cardFields} />
    </div>
  )
}

type DropSlot = { record: CustomRecord; index: number; height: number }

function KanbanColumn({ def, view, choice, groupKey, cardFields, canMove, hiddenId, drop, onArrived }: {
  def: CustomObjectDef; view: CustomViewDef; choice: SelectChoice; groupKey: string; cardFields: CustomFieldDef[]; canMove: boolean
  /** Thẻ đang kéo/vừa thả — ẩn khỏi vị trí cũ. */
  hiddenId: number | null
  /** Chỉ có ở cột đích: chèn ô giữ chỗ (đang kéo) hoặc thẻ vừa thả (chờ tải lại) vào `index`. */
  drop: DropSlot | null
  /** Thẻ vừa thả đã có trong dữ liệu tải lại của cột này. */
  onArrived: (recordId: number) => void
}) {
  const filter = JSON.stringify({ ...(view.config.filter ?? {}), [groupKey]: choice.value })
  const sort = view.config.sort ? `field:${view.config.sort.field}` : undefined
  const q = useCustomRecords(def.key, { filter, sort, dir: view.config.sort?.dir }, 1, PER_COLUMN)
  const allRows = q.data?.items ?? []
  const arrived = drop != null && allRows.some((r) => r.id === drop.record.id)
  useEffect(() => {
    if (arrived && drop) onArrived(drop.record.id)
  }, [arrived, drop, onArrived])
  const rows = hiddenId != null ? allRows.filter((r) => r.id !== hiddenId) : allRows
  const items = rows.map((r) => (
    <motion.div key={r.id} layout="position" transition={motionTokens.spring.smooth} data-board-item={r.id}>
      <KanbanCard def={def} record={r} cardFields={cardFields} canMove={canMove} />
    </motion.div>
  ))
  if (drop) {
    items.splice(Math.min(drop.index, items.length), 0, (
      <motion.div key={drop.record.id} layout="position" transition={motionTokens.spring.smooth}>
        <KanbanCard def={def} record={drop.record} cardFields={cardFields} canMove={canMove} placeholderHeight={drop.height} />
      </motion.div>
    ))
  }
  return (
    <div
      data-board-column={choice.value}
      className="flex w-72 shrink-0 flex-col gap-2 rounded-2xl bg-muted/50 p-2"
      data-testid="kanban-column" aria-label={choice.label}
    >
      <div className="flex items-center justify-between px-1 py-1">
        <span className="text-sm font-semibold">{choice.label}</span>
        <span className="rounded-full bg-background px-2 text-xs text-muted-foreground">{q.data?.total != null ? formatNumberVn(q.data.total) : "…"}</span>
      </div>
      {q.isLoading && <Loader2 className="mx-auto size-4 animate-spin" aria-label="Đang tải" />}
      {q.isError && <p className="px-1 text-xs text-red-700">{getApiErrorMessage(q.error, "Không tải được")}</p>}
      <div data-board-list className="flex flex-col gap-2">{items}</div>
      {q.data?.total != null && q.data.total > allRows.length && <p className="px-1 text-xs text-muted-foreground">+{formatNumberVn(q.data.total - allRows.length)} thẻ nữa — mở Danh sách để xem hết</p>}
    </div>
  )
}

/**
 * Kanban cho bảng tuỳ biến: cột = lựa chọn của trường `group_by` (select), kéo thả thẻ sang cột khác = đổi giá trị
 * trường đó qua ĐÚNG API sửa bản ghi (BE kiểm phạm vi + validate). Mỗi cột tải tối đa 50 thẻ.
 * Kéo thả cùng kiểu với board Kanban (`@dnd-kit/core` + `useBoardDrag`, nhịp `motionTokens`); thứ tự trong cột
 * vẫn theo cách sắp của view — thẻ vừa thả nằm ở chỗ thả tới khi cột tải lại.
 */
export function CustomKanbanBoard({ def, view }: { def: CustomObjectDef; view: CustomViewDef }) {
  const { can } = usePermissions()
  const canMove = can("custom_records.manage")
  const { update } = useCustomRecordMutations(def.key)
  const group = def.fields.find((f) => f.key === view.config.group_by && f.type === "select")
  const cardFields = (view.config.card_fields ?? []).map((k) => def.fields.find((f) => f.key === k)).filter((f): f is CustomFieldDef => !!f && !f.is_title)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const { rootRef: boardRef, target: dropTarget, start: startDrag, stop: stopDrag } = useBoardDrag()
  const [active, setActive] = useState<{ record: CustomRecord; width: number; height: number } | null>(null)
  const [settling, setSettling] = useState<{ value: string; slot: DropSlot } | null>(null)

  function onMove(recordId: number, value: string) {
    if (!group) return
    update.mutate({ id: recordId, input: { data: { [group.key]: value } } }, {
      onSuccess: () => toast.success("Đã chuyển thẻ"),
      onError: (e) => {
        setSettling(null)
        toast.error(getApiErrorMessage(e, "Không chuyển được thẻ"))
      },
    })
  }

  function onDragStart(e: DragStartEvent) {
    const record = (e.active.data.current as { record: CustomRecord } | undefined)?.record
    if (!record || !group) return
    const rect = e.active.rect.current.initial
    setActive({ record, width: rect?.width ?? 288, height: rect?.height ?? 72 })
    startDrag(String(record.id), String(record.data[group.key] ?? ""))
  }

  function onDragEnd() {
    const cur = active
    setActive(null)
    const result = stopDrag()
    if (!cur || !result || result.unchanged || !group) return
    const value = result.target.column
    if (value === String(cur.record.data[group.key] ?? "")) return
    setSettling({ value, slot: { record: { ...cur.record, data: { ...cur.record.data, [group.key]: value } }, index: result.target.index, height: cur.height } })
    onMove(cur.record.id, value)
  }

  const onArrived = (recordId: number) => setSettling((s) => (s?.slot.record.id === recordId ? null : s))

  return (
    <div className="space-y-4">
      <ShellPageHeader icon={KanbanSquare} title={view.label} description={`${def.label_plural}${group ? ` · theo ${group.label}` : ""}`} />
      <ViewTabs objectKey={def.key} active={view.key} />
      {!group ? (
        <Card className="rounded-2xl"><ShellEmptyState icon={KanbanSquare} title="Kanban chưa dùng được" description="Trường chia cột không còn (hoặc không còn là trường lựa chọn). Hãy nhờ AI sửa màn này." /></Card>
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => { stopDrag(); setActive(null) }}>
          <MotionConfig reducedMotion="user">
            <div ref={boardRef} className="flex gap-3 overflow-x-auto pb-2" data-testid="kanban-board">
              {(group.options.choices ?? []).map((c) => (
                <KanbanColumn
                  key={c.value} def={def} view={view} choice={c} groupKey={group.key} cardFields={cardFields} canMove={canMove}
                  hiddenId={active?.record.id ?? settling?.slot.record.id ?? null}
                  drop={
                    active && dropTarget?.column === c.value
                      ? { record: active.record, index: dropTarget.index, height: active.height }
                      : !active && settling?.value === c.value ? settling.slot : null
                  }
                  onArrived={onArrived}
                />
              ))}
            </div>
            <DragOverlay dropAnimation={{ duration: 260, easing: CSS_EASE_ENTER }}>
              {active ? (
                <motion.div
                  initial={{ rotate: 0, scale: 1 }}
                  animate={{ rotate: 2.5, scale: 1.03 }}
                  transition={motionTokens.spring.snappy}
                  style={{ width: active.width }}
                  className={cn(CARD_FRAME, "cursor-grabbing shadow-xl")}
                >
                  <KanbanCardBody def={def} record={active.record} cardFields={cardFields} />
                </motion.div>
              ) : null}
            </DragOverlay>
          </MotionConfig>
        </DndContext>
      )}
    </div>
  )
}
