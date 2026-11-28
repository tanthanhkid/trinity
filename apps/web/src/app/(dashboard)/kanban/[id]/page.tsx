"use client"

/**
 * Trang chi tiết MỘT việc (thẻ Kanban) — link trực tiếp `/kanban/<id>` và bản điện thoại.
 * Cùng dữ liệu/quyền với hộp thoại chi tiết ở `/kanban`; giao diện «Ánh xanh» (congviec-*).
 */
import { PermissionGate } from "@/lib/rbac"
import { useRouteParams } from "@/lib/route-params"
import { KanbanCardPage } from "@/components/kanban/kanban-card-page"
import { Skeleton } from "@/components/ui/skeleton"

export default function KanbanCardRoute() {
  const route = useRouteParams<"id">("/kanban/:id")
  const id = route ? Number(route.id) : NaN
  return (
    <PermissionGate permission="kanban.view">
      {route === null ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : (
        <KanbanCardPage cardId={Number.isInteger(id) && id > 0 ? id : null} />
      )}
    </PermissionGate>
  )
}
