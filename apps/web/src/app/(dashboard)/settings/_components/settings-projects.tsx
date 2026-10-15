'use client'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SettingsSectionActions } from './settings-section-header'
import { useState } from 'react'
import Link from 'next/link'
import {
  Loader2,
  Pencil,
  Lock,
  FolderOpen,
  Trash2,
  Plus,
  Eye,
  MoreHorizontal,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ShellResponsiveList } from '@/components/app-shell/responsive-list'
import { ShellListCard } from '@/components/app-shell/list-card'
import { MOBILE_FAB_CLASS } from '@/components/app-shell/mobile-primary'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { usePermissions } from '@/lib/rbac'
import { useProjectsAdmin } from '@/hooks/use-projects-admin'
import type { Project } from '@/components/projects/project-types'
import { useDeleteProject } from '@/hooks/use-delete-project'
import { ProjectFormDialog } from '@/components/projects/project-form-dialog'

// Projects management (Settings > Projects).
// View = `products.view`, create/edit/delete = `products.manage`.

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SettingsProjects() {
  const { can } = usePermissions()
  const hasAccess = can('products.view')
  const canManage = can('products.manage')
  const canDelete = canManage
  const [editProject, setEditProject] = useState<Project | null>(
    null,
  )
  const [deleteProject, setDeleteProject] =
    useState<Project | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const { data: projects = [], isLoading } = useProjectsAdmin()
  const deleteMutation = useDeleteProject(() => setDeleteProject(null))

  if (!hasAccess) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="flex items-center gap-3 py-8 text-muted-foreground">
          <Lock className="h-5 w-5" />
          Bạn không có quyền xem Dự án.
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FolderOpen className="h-5 w-5 text-[var(--color-app-primary-ink)]" />
                Dự án
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-1 max-sm:line-clamp-2">
                Danh sách Dự án (Sản phẩm) dùng để phân loại khách hàng.
              </p>
            </div>
            {canManage && (
              <SettingsSectionActions>
                <Button className={MOBILE_FAB_CLASS} onClick={() => setShowCreate(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Thêm dự án
                </Button>
              </SettingsSectionActions>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--color-app-primary-ink)]" />
            </div>
          ) : projects.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground mb-3">
                Chưa có dự án nào.
              </p>
              {canManage ? (
                <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Tạo dự án đầu tiên
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Vui lòng tạo dự án tại trang{' '}
                  <a href="/projects" className="text-[var(--color-app-primary-ink)] underline">
                    Quản lý dự án
                  </a>
                  .
                </p>
              )}
            </div>
          ) : (
            <ShellResponsiveList
              table={
            <div className="rounded-xl border overflow-hidden overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="font-medium">Dự án</TableHead>
                    <TableHead className="font-medium">Trạng thái</TableHead>
                    <TableHead className="font-medium text-right">
                      Hành động
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((p) => (
                    <TableRow
                      key={p.id}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      <TableCell className="font-medium">
                        <div>
                          <span>{p.name}</span>
                          <code className="ml-2 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            {p.code}
                          </code>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={
                            p.is_active
                              ? 'bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]'
                              : 'bg-gray-100 text-gray-500'
                          }
                        >
                          {p.is_active ? 'Hoạt động' : 'Ngừng'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            href={`/projects/${p.id}`}
                            title="Xem chi tiết dự án"
                          >
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:text-[var(--color-app-primary-ink)]"
                              title="Xem chi tiết dự án"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </Link>
                          {canManage && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:text-[var(--color-app-primary-ink)]"
                              title="Sửa dự án"
                              onClick={() => setEditProject(p)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive"
                              title="Xoá dự án"
                              onClick={() => setDeleteProject(p)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
              }
              cards={
                <div className="space-y-3">
                  {projects.map((p) => (
                    <ShellListCard key={p.id} className="flex items-center gap-2 p-3">
                      <Link
                        href={`/projects/${p.id}`}
                        className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-1"
                      >
                        <span className="break-words font-medium">{p.name}</span>
                        <span className="flex flex-wrap items-center gap-2">
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {p.code}
                          </code>
                          <Badge
                            variant="secondary"
                            className={
                              p.is_active
                                ? 'bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]'
                                : 'bg-gray-100 text-gray-500'
                            }
                          >
                            {p.is_active ? 'Hoạt động' : 'Ngừng'}
                          </Badge>
                        </span>
                      </Link>
                      {canManage && (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button variant="ghost" size="icon" aria-label="Thao tác khác" />
                            }
                          >
                            <MoreHorizontal className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem className="gap-2" onClick={() => setEditProject(p)}>
                              <Pencil className="size-4" />
                              Sửa dự án
                            </DropdownMenuItem>
                            {canDelete && (
                              <DropdownMenuItem
                                variant="destructive"
                                className="gap-2"
                                onClick={() => setDeleteProject(p)}
                              >
                                <Trash2 className="size-4" />
                                Xoá dự án
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </ShellListCard>
                  ))}
                </div>
              }
            />
          )}
        </CardContent>
      </Card>

      <ProjectFormDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={() => setShowCreate(false)}
      />
      <ProjectFormDialog
        open={!!editProject}
        project={editProject ?? undefined}
        onClose={() => setEditProject(null)}
        onSuccess={() => setEditProject(null)}
      />

      <ConfirmDialog
        open={!!deleteProject}
        onOpenChange={(o) => !o && setDeleteProject(null)}
        title="Xoá dự án"
        description={
          <>
            Bạn có chắc muốn xoá dự án <strong>&laquo;{deleteProject?.name}&raquo;</strong>? Dự án sẽ bị ẩn
            khỏi hệ thống và không còn xuất hiện trong các dropdown lựa chọn. Dữ liệu hồ sơ liên quan không bị xoá.
          </>
        }
        confirmLabel="Xoá dự án"
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteProject) deleteMutation.mutate(deleteProject.id)
        }}
      />
    </>
  )
}
