"use client"

import { useState, type DragEvent } from "react"
import Link from "next/link"
import { KanbanSquare, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { useCustomRecordMutations, useCustomRecords } from "@/hooks/custom-objects/use-custom-objects"
import { getApiErrorMessage } from "@/lib/api-client"
import { formatNumberVn } from "@/lib/custom-objects/format-value"
import { usePermissions } from "@/lib/rbac"
import { cn } from "@/lib/utils"
import type { CustomFieldDef, CustomObjectDef, CustomRecord, CustomViewDef, SelectChoice } from "@/types/custom-objects"
import { CustomFieldValue } from "./custom-field-value"
import { RecordCode } from "./record-code"
import { ViewTabs } from "./view-tabs"

const PER_COLUMN = 50
const DRAG_TYPE = "application/x-trinity-record"

function KanbanCard({ def, record, cardFields, canMove }: { def: CustomObjectDef; record: CustomRecord; cardFields: CustomFieldDef[]; canMove: boolean }) {
  return (
    <div
      draggable={canMove}
      onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, String(record.id)); e.dataTransfer.effectAllowed = "move" }}
      className={cn("space-y-1 rounded-[var(--radius)] border bg-card p-3 text-sm shadow-sm", canMove && "cursor-grab active:cursor-grabbing")}
      data-testid="kanban-card"
    >
      <div className="flex items-start gap-1.5">
        <RecordCode code={record.code} />
        <Link href={`/x/${def.key}/${record.id}`} className="font-semibold text-primary underline-offset-2 hover:underline">{record.title ?? `#${record.id}`}</Link>
      </div>
      {cardFields.map((f) => (
        <div key={f.key} className="flex gap-1 text-xs text-muted-foreground"><span className="shrink-0">{f.label}:</span> <CustomFieldValue field={f} record={record} /></div>
      ))}
      {record.owner_name && <p className="text-xs text-muted-foreground">Phụ trách: {record.owner_name}</p>}
    </div>
  )
}

function KanbanColumn({ def, view, choice, groupKey, cardFields, onMove, canMove }: {
  def: CustomObjectDef; view: CustomViewDef; choice: SelectChoice; groupKey: string; cardFields: CustomFieldDef[]; canMove: boolean
  onMove: (recordId: number, value: string) => void
}) {
  const [over, setOver] = useState(false)
  const filter = JSON.stringify({ ...(view.config.filter ?? {}), [groupKey]: choice.value })
  const sort = view.config.sort ? `field:${view.config.sort.field}` : undefined
  const q = useCustomRecords(def.key, { filter, sort, dir: view.config.sort?.dir }, 1, PER_COLUMN)
  const rows = q.data?.items ?? []
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setOver(false)
    const id = Number(e.dataTransfer.getData(DRAG_TYPE))
    if (Number.isFinite(id) && id > 0 && !rows.some((r) => r.id === id)) onMove(id, choice.value)
  }
  return (
    <div
      onDragOver={(e) => { if (canMove) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn("flex w-72 shrink-0 flex-col gap-2 rounded-2xl bg-muted/50 p-2", over && "ring-2 ring-primary")}
      data-testid="kanban-column" aria-label={choice.label}
    >
      <div className="flex items-center justify-between px-1 py-1">
        <span className="text-sm font-semibold">{choice.label}</span>
        <span className="rounded-full bg-background px-2 text-xs text-muted-foreground">{q.data?.total != null ? formatNumberVn(q.data.total) : "…"}</span>
      </div>
      {q.isLoading && <Loader2 className="mx-auto size-4 animate-spin" aria-label="Đang tải" />}
      {q.isError && <p className="px-1 text-xs text-red-700">{getApiErrorMessage(q.error, "Không tải được")}</p>}
      {rows.map((r) => <KanbanCard key={r.id} def={def} record={r} cardFields={cardFields} canMove={canMove} />)}
      {q.data?.total != null && q.data.total > rows.length && <p className="px-1 text-xs text-muted-foreground">+{formatNumberVn(q.data.total - rows.length)} thẻ nữa — mở Danh sách để xem hết</p>}
    </div>
  )
}

/**
 * Kanban cho bảng tuỳ biến: cột = lựa chọn của trường `group_by` (select), kéo thả thẻ sang cột khác = đổi giá trị
 * trường đó qua ĐÚNG API sửa bản ghi (BE kiểm phạm vi + validate). Mỗi cột tải tối đa 50 thẻ.
 */
export function CustomKanbanBoard({ def, view }: { def: CustomObjectDef; view: CustomViewDef }) {
  const { can } = usePermissions()
  const canMove = can("custom_records.manage")
  const { update } = useCustomRecordMutations(def.key)
  const group = def.fields.find((f) => f.key === view.config.group_by && f.type === "select")
  const cardFields = (view.config.card_fields ?? []).map((k) => def.fields.find((f) => f.key === k)).filter((f): f is CustomFieldDef => !!f && !f.is_title)

  function onMove(recordId: number, value: string) {
    if (!group) return
    update.mutate({ id: recordId, input: { data: { [group.key]: value } } }, {
      onSuccess: () => toast.success("Đã chuyển thẻ"),
      onError: (e) => toast.error(getApiErrorMessage(e, "Không chuyển được thẻ")),
    })
  }

  return (
    <div className="space-y-4">
      <ShellPageHeader icon={KanbanSquare} title={view.label} description={`${def.label_plural}${group ? ` · theo ${group.label}` : ""}`} />
      <ViewTabs objectKey={def.key} active={view.key} />
      {!group ? (
        <Card className="rounded-2xl"><ShellEmptyState icon={KanbanSquare} title="Kanban chưa dùng được" description="Trường chia cột không còn (hoặc không còn là trường lựa chọn). Hãy nhờ AI sửa màn này." /></Card>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2" data-testid="kanban-board">
          {(group.options.choices ?? []).map((c) => (
            <KanbanColumn key={c.value} def={def} view={view} choice={c} groupKey={group.key} cardFields={cardFields} onMove={onMove} canMove={canMove} />
          ))}
        </div>
      )}
    </div>
  )
}
