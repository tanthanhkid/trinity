"use client"

/**
 * Cấu hình Kanban (RBAC quyền+phạm vi — `kanban.boards`). Quản lý board/cột/
 * trường tuỳ biến/board mẫu. RBAC thật ở BE (`@Can('kanban.boards')`) — gate
 * FE chỉ để không cho vào nhầm màn hình.
 */
import { useState } from "react"
import { toast } from "sonner"
import Link from "next/link"
import { ArrowLeft, Plus, ShieldOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { Badge } from "@/components/ui/badge"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useAuth } from "@/hooks/use-auth"
import { usePermissions } from "@/lib/rbac"
import { getApiErrorMessage } from "@/lib/api-client"
import {
  useCreateKanbanBoardFromTemplate,
  useDeleteKanbanBoard,
  useKanbanBoardDetail,
  useKanbanBoards,
  useKanbanTemplates,
} from "@/hooks/kanban/use-kanban-boards"
import { useDeleteKanbanFieldDef, useReorderKanbanFieldDefs } from "@/hooks/kanban/use-kanban-field-defs"
import { useReorderKanbanColumns } from "@/hooks/kanban/use-kanban-columns"
import { KanbanRowActions } from "./_components/kanban-row-actions"
import { KanbanBoardFormDialog } from "./_components/kanban-board-form-dialog"
import { KanbanColumnFormDialog } from "./_components/kanban-column-form-dialog"
import { KanbanDeleteColumnDialog } from "./_components/kanban-delete-column-dialog"
import { KanbanFieldDefFormDialog } from "./_components/kanban-field-def-form-dialog"
import type { KanbanBoard, KanbanColumn, KanbanFieldDef } from "@/types/kanban"

function AccessDenied() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-12 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50">
        <ShieldOff className="h-8 w-8 text-red-500" />
      </div>
      <h1 className="text-lg font-semibold text-red-700">Bạn không có quyền truy cập trang này</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Bạn cần quyền "Tạo/cấu hình bảng" để cấu hình board Kanban.
      </p>
    </div>
  )
}

export default function KanbanSettingsPage() {
  const { isLoading } = useAuth()
  const { can } = usePermissions()
  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Đang tải…</p>
  if (!can("kanban.boards")) return <AccessDenied />
  return <KanbanSettingsContent />
}

function KanbanSettingsContent() {
  const { data: boards = [] } = useKanbanBoards()
  const { data: templates = [] } = useKanbanTemplates()
  const [selectedBoardId, setSelectedBoardId] = useState<number | null>(null)
  const [boardDialogOpen, setBoardDialogOpen] = useState(false)
  const [editingBoard, setEditingBoard] = useState<KanbanBoard | null>(null)
  const deleteBoard = useDeleteKanbanBoard()
  const [deletingBoard, setDeletingBoard] = useState<KanbanBoard | null>(null)
  const createFromTemplate = useCreateKanbanBoardFromTemplate()

  const createFromTemplateKey = (key: string) =>
    createFromTemplate
      .mutateAsync({ template_key: key })
      .then((b) => {
        toast.success(`Đã tạo board "${b.name}"`)
        setSelectedBoardId(b.id)
      })
      .catch((err) => toast.error(getApiErrorMessage(err, "Không tạo được board")))

  const activeBoardId =
    selectedBoardId != null && boards.some((b) => b.id === selectedBoardId)
      ? selectedBoardId
      : (boards[0]?.id ?? null)
  const { data: boardDetail } = useKanbanBoardDetail(activeBoardId)

  return (
    <div className="flex flex-col gap-4">
      <ShellPageHeader
        title="Cấu hình Kanban"
        actions={
          <>
            <Link
              href="/kanban"
              aria-label="Quay lại công việc"
              className={`${buttonVariants({ variant: "outline" })} max-sm:min-h-11 max-sm:min-w-11 max-sm:px-0`}
            >
              <ArrowLeft className="size-4 sm:mr-1" /> <span className="max-sm:hidden">Quay lại công việc</span>
            </Link>
            <Button
              className={MOBILE_FAB_CLASS}
              onClick={() => {
                setEditingBoard(null)
                setBoardDialogOpen(true)
              }}
            >
              <Plus className="mr-1 size-4" /> Tạo board
            </Button>
          </>
        }
      />

      <section className="rounded-lg border p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Board</h2>
          <div className="flex flex-wrap gap-2 max-sm:hidden">
            {templates.map((t) => (
              <Button
                key={t.key}
                variant="outline"
                size="sm"
                onClick={() => createFromTemplateKey(t.key)}
              >
                + Từ mẫu: {t.name}
              </Button>
            ))}
          </div>
          {templates.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1 min-h-11 sm:hidden")}
              >
                <Plus className="size-4" /> Từ mẫu
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {templates.map((t) => (
                  <DropdownMenuItem key={t.key} className="min-h-11" onClick={() => createFromTemplateKey(t.key)}>
                    {t.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          {boards.map((b) => (
            <div
              key={b.id}
              className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${
                b.id === activeBoardId ? "border-primary bg-primary/5" : ""
              }`}
            >
              <button className="relative after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] pointer-coarse:sm:after:-inset-y-3 flex-1 text-left max-sm:min-h-11" onClick={() => setSelectedBoardId(b.id)}>
                {b.name}{" "}
                {!b.is_active && (
                  <Badge variant="outline" className="ml-1 text-sm">
                    Đã tắt
                  </Badge>
                )}
                <span className="ml-2 text-xs text-muted-foreground">
                  {b.column_count} cột · {b.card_count} card
                </span>
              </button>
              <KanbanRowActions
                deleteLabel="Xoá board"
                onEdit={() => {
                  setEditingBoard(b)
                  setBoardDialogOpen(true)
                }}
                onDelete={() => setDeletingBoard(b)}
              />
            </div>
          ))}
        </div>
      </section>

      {boardDetail && (
        <>
          <ColumnsSection boardId={boardDetail.id} columns={boardDetail.columns} />
          <FieldDefsSection boardId={boardDetail.id} fieldDefs={boardDetail.field_defs} />
        </>
      )}

      <ConfirmDialog
        open={deletingBoard != null}
        onOpenChange={(o) => !o && setDeletingBoard(null)}
        title="Xoá board"
        description={`Xoá mềm board "${deletingBoard?.name ?? ""}"?`}
        confirmLabel="Xoá board"
        pending={deleteBoard.isPending}
        onConfirm={() => {
          if (!deletingBoard) return
          deleteBoard.mutate(deletingBoard.id, {
            onSuccess: () => {
              toast.success("Đã xoá board")
              setDeletingBoard(null)
            },
            onError: (err) => toast.error(getApiErrorMessage(err, "Không xoá được board")),
          })
        }}
      />
      <KanbanBoardFormDialog open={boardDialogOpen} onOpenChange={setBoardDialogOpen} board={editingBoard} />
    </div>
  )
}

function ColumnsSection({ boardId, columns }: { boardId: number; columns: KanbanColumn[] }) {
  const reorder = useReorderKanbanColumns(boardId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<KanbanColumn | null>(null)
  const [deleting, setDeleting] = useState<KanbanColumn | null>(null)

  const move = (index: number, dir: -1 | 1) => {
    const next = [...columns]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    reorder.mutate(next.map((c) => c.id))
  }

  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium">Cột</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus className="mr-1 size-4" /> Thêm cột
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        {columns.map((c, i) => (
          <div key={c.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="min-w-0">
              {c.name} {c.is_done && <Badge variant="secondary" className="ml-1 text-sm">Hoàn thành</Badge>}
              {c.wip_limit != null && (
                <span className="ml-2 text-xs text-muted-foreground">WIP ≤ {c.wip_limit}</span>
              )}
            </span>
            <KanbanRowActions
              deleteLabel="Xoá cột"
              onMoveUp={() => move(i, -1)}
              onMoveDown={() => move(i, 1)}
              disableUp={i === 0}
              disableDown={i === columns.length - 1}
              onEdit={() => {
                setEditing(c)
                setDialogOpen(true)
              }}
              onDelete={() => setDeleting(c)}
            />
          </div>
        ))}
      </div>
      <KanbanColumnFormDialog boardId={boardId} open={dialogOpen} onOpenChange={setDialogOpen} column={editing} />
      <KanbanDeleteColumnDialog
        boardId={boardId}
        open={deleting != null}
        onOpenChange={(o) => !o && setDeleting(null)}
        column={deleting}
        otherColumns={columns.filter((c) => c.id !== deleting?.id)}
      />
    </section>
  )
}

function FieldDefsSection({ boardId, fieldDefs }: { boardId: number; fieldDefs: KanbanFieldDef[] }) {
  const reorder = useReorderKanbanFieldDefs(boardId)
  const removeDef = useDeleteKanbanFieldDef(boardId)
  const [deletingDef, setDeletingDef] = useState<KanbanFieldDef | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<KanbanFieldDef | null>(null)

  const move = (index: number, dir: -1 | 1) => {
    const next = [...fieldDefs]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    reorder.mutate(next.map((d) => d.id))
  }

  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium">Trường tuỳ biến</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus className="mr-1 size-4" /> Thêm trường
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        {fieldDefs.length === 0 && (
          <p className="text-sm text-muted-foreground">Board chưa có trường tuỳ biến nào.</p>
        )}
        {fieldDefs.map((d, i) => (
          <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="min-w-0">
              {d.label} <span className="text-xs text-muted-foreground">({d.key} · {d.type})</span>
              {d.required && <Badge variant="outline" className="ml-1 text-sm">Bắt buộc</Badge>}
            </span>
            <KanbanRowActions
              deleteLabel="Xoá trường"
              onMoveUp={() => move(i, -1)}
              onMoveDown={() => move(i, 1)}
              disableUp={i === 0}
              disableDown={i === fieldDefs.length - 1}
              onEdit={() => {
                setEditing(d)
                setDialogOpen(true)
              }}
              onDelete={() => setDeletingDef(d)}
            />
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={deletingDef != null}
        onOpenChange={(o) => !o && setDeletingDef(null)}
        title="Xoá trường"
        description={`Xoá trường "${deletingDef?.label ?? ""}"? Giá trị đã lưu trên card sẽ giữ nguyên nhưng không còn hiển thị.`}
        confirmLabel="Xoá trường"
        pending={removeDef.isPending}
        onConfirm={() => {
          if (!deletingDef) return
          removeDef.mutate(deletingDef.id, {
            onSuccess: () => setDeletingDef(null),
            onError: (err) => toast.error(getApiErrorMessage(err, "Không xoá được trường")),
          })
        }}
      />
      <KanbanFieldDefFormDialog boardId={boardId} open={dialogOpen} onOpenChange={setDialogOpen} fieldDef={editing} />
    </section>
  )
}
