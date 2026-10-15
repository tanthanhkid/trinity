"use client"

/**
 * Nhóm nút theo dòng của màn Cấu hình Kanban (board/cột/trường).
 * Desktop (≥640px): icon như cũ. Điện thoại (<640px): 1 icon Sửa +
 * menu "⋯" chứa Lên / Xuống / Xoá (Xoá cuối menu, vẫn qua dialog xác nhận có sẵn).
 */
import { ArrowDown, ArrowUp, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

interface KanbanRowActionsProps {
  onEdit: () => void
  onDelete: () => void
  deleteLabel: string
  /** Có cả `onMoveUp` và `onMoveDown` thì hiện nút đổi thứ tự. */
  onMoveUp?: () => void
  onMoveDown?: () => void
  disableUp?: boolean
  disableDown?: boolean
}

export function KanbanRowActions({
  onEdit,
  onDelete,
  deleteLabel,
  onMoveUp,
  onMoveDown,
  disableUp,
  disableDown,
}: KanbanRowActionsProps) {
  const canMove = onMoveUp != null && onMoveDown != null
  return (
    <>
      <div className="flex gap-1 max-sm:hidden">
        {canMove && (
          <>
            <Button variant="ghost" size="icon" aria-label="Lên" onClick={onMoveUp} disabled={disableUp}>
              <ArrowUp className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Xuống" onClick={onMoveDown} disabled={disableDown}>
              <ArrowDown className="size-3.5" />
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon" aria-label="Sửa" onClick={onEdit}>
          <Pencil className="size-3.5" />
        </Button>
        <Button variant="destructive" size="icon" aria-label={deleteLabel} onClick={onDelete}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="flex items-center gap-2 sm:hidden">
        <Button variant="ghost" size="icon" aria-label="Sửa" onClick={onEdit}>
          <Pencil className="size-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Thao tác khác"
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "min-h-11 min-w-11")}
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canMove && (
              <>
                <DropdownMenuItem className="min-h-11" disabled={disableUp} onClick={onMoveUp}>
                  <ArrowUp className="size-4" /> Lên
                </DropdownMenuItem>
                <DropdownMenuItem className="min-h-11" disabled={disableDown} onClick={onMoveDown}>
                  <ArrowDown className="size-4" /> Xuống
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem className="min-h-11" variant="destructive" onClick={onDelete}>
              <Trash2 className="size-4" /> {deleteLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )
}
