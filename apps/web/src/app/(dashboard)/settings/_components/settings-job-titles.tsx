"use client"

import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Briefcase, Plus, Trash2, Loader2, Pencil, Check, X, ExternalLink, MoreHorizontal } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SettingsSectionActions } from "./settings-section-header"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  useJobTitles,
  useCreateJobTitle,
  useUpdateJobTitle,
  useDeleteJobTitle,
} from "@/hooks/use-job-titles"
import { usePermissions } from "@/lib/rbac"

/** Bỏ dấu tiếng Việt + ký tự đặc biệt → mã rank_code (≤20, unique do BE check). */
function deriveRankCode(name: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
  return (
    ascii.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase().slice(0, 20) ||
    "CV"
  )
}

/** Ký hiệu ngắn (≤10) = chữ cái đầu mỗi từ. */
function deriveSymbol(name: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
  const initials = ascii
    .split(/\s+/)
    .map((w) => w[0])
    .filter((c) => /[a-zA-Z0-9]/.test(c ?? ""))
    .join("")
    .toUpperCase()
  return (initials || ascii.replace(/[^a-zA-Z0-9]/g, "").slice(0, 3) || "CV").slice(0, 10)
}

export function SettingsJobTitles(): React.ReactElement {
  const canEdit = usePermissions().can("org.manage")
  const { data: jobTitles = [], isLoading } = useJobTitles()
  const create = useCreateJobTitle()
  const update = useUpdateJobTitle()
  const del = useDeleteJobTitle()

  const [newName, setNewName] = useState("")
  const [newCategory, setNewCategory] = useState("")
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState("")
  const [toDelete, setToDelete] = useState<{ id: number; name: string } | null>(null)

  const handleAdd = () => {
    if (create.isPending) return
    const name = newName.trim()
    if (!name) {
      toast.error("Nhập tên chức vụ")
      return
    }
    create.mutate(
      {
        name,
        category: newCategory.trim() || "Khác",
        rank_code: deriveRankCode(name),
        symbol: deriveSymbol(name),
        review_cycle_months: 3,
        base_salary: 0,
        standard_target: 0,
      },
      {
        onSuccess: () => {
          setNewName("")
          setNewCategory("")
        },
      },
    )
  }

  const handleSaveEdit = (id: number) => {
    if (update.isPending) return
    const name = editName.trim()
    if (!name) {
      toast.error("Tên chức vụ không được rỗng")
      return
    }
    update.mutate(
      { id, payload: { name } },
      { onSuccess: () => setEditingId(null) },
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Briefcase className="size-5 text-[var(--color-app-primary-ink)]" />
          Chức vụ
        </CardTitle>
        <CardDescription className="space-y-1">
          <span>
            Tạo / sửa tên / xoá chức vụ (chức danh). Dùng cho dropdown Chức danh trong
            Quản lý nhân viên.
          </span>
          <Link
            href="/management/job-titles"
            className="inline-flex items-center gap-1 text-[var(--color-app-primary-ink)] hover:underline max-sm:min-h-11"
          >
            <ExternalLink className="size-3.5" />
            Cấu hình lương / chỉ tiêu / BHXH chi tiết
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Thêm mới */}
        {canEdit && (
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1">
              <label className="text-xs text-muted-foreground">Tên chức vụ *</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Vd: Admin nhập liệu"
                maxLength={100}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd()
                }}
              />
            </div>
            <div className="w-full space-y-1 sm:w-44">
              <label className="text-xs text-muted-foreground">Nhóm (tuỳ chọn)</label>
              <Input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="Khác"
                maxLength={100}
              />
            </div>
            {/* Điện thoại: nút chính "Thêm chức vụ" là FAB ở slot header; nút trong form chỉ hiện ≥640px. */}
            <SettingsSectionActions mobile="fab">
              <Button
                type="button"
                onClick={handleAdd}
                disabled={create.isPending || !newName.trim()}
                className="gap-1 sm:hidden"
              >
                {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                Thêm chức vụ
              </Button>
            </SettingsSectionActions>
            <Button
              type="button"
              onClick={handleAdd}
              disabled={create.isPending || !newName.trim()}
              className="gap-1 max-sm:hidden"
            >
              {create.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Thêm chức vụ
            </Button>
          </div>
        )}

        {/* Danh sách */}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Đang tải chức vụ...
          </div>
        ) : jobTitles.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Chưa có chức vụ nào.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {jobTitles.map((jt) => (
              <li key={jt.id} className="flex items-center gap-2 px-3 py-2">
                {editingId === jt.id ? (
                  <>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      maxLength={100}
                      className="h-8 max-sm:h-11"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveEdit(jt.id)
                        if (e.key === "Escape") setEditingId(null)
                      }}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      type="button"
                      className="size-8"
                      onClick={() => handleSaveEdit(jt.id)}
                      disabled={update.isPending}
                      title="Lưu"
                    >
                      <Check className="size-4 text-emerald-600" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      type="button"
                      className="size-8"
                      onClick={() => setEditingId(null)}
                      title="Huỷ"
                    >
                      <X className="size-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 truncate text-sm font-medium">{jt.name}</span>
                    <span className="shrink-0 rounded-full border bg-muted px-2 py-0.5 text-sm text-muted-foreground">
                      {jt.category}
                    </span>
                    {canEdit && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          type="button"
                          className="size-8 max-sm:hidden"
                          onClick={() => {
                            setEditingId(jt.id)
                            setEditName(jt.name)
                          }}
                          title="Sửa tên"
                        >
                          <Pencil className="size-4 text-muted-foreground" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          type="button"
                          className="size-8 max-sm:hidden"
                          onClick={() => setToDelete(jt)}
                          disabled={del.isPending}
                          title="Xoá"
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                        {/* Điện thoại: Sửa/Xoá vào menu "⋯", Xoá cuối + ConfirmDialog. */}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={<Button size="icon" variant="ghost" type="button" className="sm:hidden" aria-label="Thao tác khác" />}
                          >
                            <MoreHorizontal className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="max-sm:min-h-11"
                              onClick={() => {
                                setEditingId(jt.id)
                                setEditName(jt.name)
                              }}
                            >
                              <Pencil className="size-4" /> Sửa tên
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              className="max-sm:min-h-11"
                              disabled={del.isPending}
                              onClick={() => setToDelete(jt)}
                            >
                              <Trash2 className="size-4" /> Xoá
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {!canEdit && (
          <p className="text-sm text-muted-foreground">
            Bạn không có quyền chỉnh sửa chức vụ.
          </p>
        )}
      </CardContent>
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Xoá chức vụ"
        description={`Xoá chức vụ "${toDelete?.name ?? ""}"?`}
        confirmLabel="Xoá chức vụ"
        pending={del.isPending}
        onConfirm={() => {
          if (!toDelete) return
          del.mutate(toDelete.id, { onSuccess: () => setToDelete(null) })
        }}
      />
    </Card>
  )
}
