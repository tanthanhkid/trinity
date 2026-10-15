"use client"

/** Một màn xem (kanban / lịch / bảng / danh sách) của bảng tuỳ biến. BE trả 404 nếu không có / không được thấy. */
import { Loader2, SearchX } from "lucide-react"
import { useParams } from "next/navigation"
import { PermissionGate } from "@/lib/rbac"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { CustomObjectGate } from "@/components/custom-objects/custom-object-gate"
import { CustomKanbanBoard } from "@/components/custom-objects/custom-kanban-board"
import { CustomRecordsScreen } from "@/components/custom-objects/custom-records-screen"
import { CustomCalendarView } from "@/components/custom-objects/custom-calendar-view"
import { CustomTableView } from "@/components/custom-objects/custom-table-view"
import { useCustomView } from "@/hooks/custom-objects/use-custom-views"
import type { CustomObjectDef } from "@/types/custom-objects"

function ViewBody({ def, viewKey }: { def: CustomObjectDef; viewKey: string }) {
  const q = useCustomView(def.key, viewKey)
  if (q.isLoading) return <div className="flex justify-center p-10"><Loader2 className="animate-spin" aria-label="Đang tải" /></div>
  if (q.isError || !q.data) return <ShellEmptyState icon={SearchX} title="Không tìm thấy màn xem này" description="Màn xem không tồn tại hoặc vai trò của bạn không được phép xem." />
  if (q.data.type === "kanban") return <CustomKanbanBoard def={def} view={q.data} />
  if (q.data.type === "calendar") return <CustomCalendarView def={def} view={q.data} />
  if (q.data.type === "table") return <CustomTableView def={def} view={q.data} />
  return <CustomRecordsScreen def={def} view={q.data} />
}

export default function CustomViewPage() {
  const { objectKey, viewKey } = useParams<{ objectKey: string; viewKey: string }>()
  return (
    <PermissionGate permission="custom_records.view">
      <CustomObjectGate objectKey={objectKey}>{(def) => <ViewBody def={def} viewKey={viewKey} />}</CustomObjectGate>
    </PermissionGate>
  )
}
