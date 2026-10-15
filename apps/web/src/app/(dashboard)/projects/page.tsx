'use client'

import { PermissionGate } from "@/lib/rbac"
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ShellPageHeader } from '@/components/app-shell/page-header'
import { MOBILE_FAB_CLASS } from '@/components/app-shell/mobile-primary'
import { ShellResponsiveList } from '@/components/app-shell/responsive-list'
import { ShellListCard, ShellListCardRow } from '@/components/app-shell/list-card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { FolderOpen, Plus, Pencil, Trash2, Loader2, Eye, MoreHorizontal } from 'lucide-react'
import apiClient from '@/lib/api-client'
import { usePermissions } from '@/lib/rbac'
import { formatDate } from '@/lib/format'
import { toast } from 'sonner'
import {
  ProjectFormDialog,
  type Project,
  COLOR_MAP,
  COLOR_LABEL,
} from '@/components/projects/project-form-dialog'

async function fetchProjects(): Promise<Project[]> {
  const res = await apiClient.get<Project[]>('/projects')
  const data = res.data
  return Array.isArray(data) ? data : (data as unknown as { data: Project[] }).data ?? []
}

export default function ProjectsPage() {
  return (
    <PermissionGate permission="products.view">
      <ProjectsScreen />
    </PermissionGate>
  )
}

function ProjectsScreen() {
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  // Catalog "Sản phẩm/Dự án" chỉ có 1 quyền ghi (`products.manage`) — không
  // tách tier xoá riêng (mirror BE `ProjectsController`).
  const canEdit = can('products.manage')
  const canDelete = can('products.manage')
  const [showCreate, setShowCreate] = useState(false)
  const [editProject, setEditProject] = useState<Project | null>(null)
  const [deleteProject, setDeleteProject] = useState<Project | null>(null)

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  })
  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiClient.delete(`/projects/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setDeleteProject(null)
      toast.success('Xoá dự án thành công')
    },
    onError: () => {
      toast.error('Xoá dự án thất bại. Vui lòng thử lại.')
    },
  })

  return (
    <div className="space-y-4">
      <ShellPageHeader
        title="Quản lý dự án"
        icon={FolderOpen}
        actions={
          canEdit && (
            <Button className={MOBILE_FAB_CLASS} onClick={() => setShowCreate(true)}>
              <Plus className="mr-2 h-4 w-4" /> Tạo dự án
            </Button>
          )
        }
      />

      <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)] max-sm:rounded-none max-sm:bg-transparent max-sm:py-0 max-sm:shadow-none max-sm:ring-0">
        <CardHeader className="pb-2 max-sm:px-0">
          <CardTitle className="text-base">Danh sách dự án</CardTitle>
        </CardHeader>
        <CardContent className="max-sm:px-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--color-app-primary-ink)]" />
            </div>
          ) : projects.length === 0 ? (
            <div className="text-center py-12">
              <FolderOpen className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">
                Chưa có dự án nào. Hãy tạo dự án đầu tiên.
              </p>
            </div>
          ) : (
            <ShellResponsiveList
              table={
            <div className="rounded-xl border overflow-hidden overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="font-medium">Tên dự án</TableHead>
                    <TableHead className="font-medium">Mã dự án</TableHead>
                    <TableHead className="font-medium">Màu sắc</TableHead>
                    <TableHead className="font-medium">Trạng thái</TableHead>
                    <TableHead className="font-medium">Ngày tạo</TableHead>
                    <TableHead className="font-medium text-right">
                      Thao tác
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((p) => (
                    <TableRow
                      key={p.id}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>
                        <code className="text-xs bg-muted px-2 py-1 rounded">
                          {p.code}
                        </code>
                      </TableCell>
                      <TableCell>
                        {p.color ? (
                          <Badge
                            variant="secondary"
                            className={
                              COLOR_MAP[p.color] ?? 'bg-gray-50 text-gray-600'
                            }
                          >
                            {COLOR_LABEL[p.color] ?? p.color}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">
                            --
                          </span>
                        )}
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
                      <TableCell className="text-muted-foreground">
                        {formatDate(p.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            href={`/projects/${p.id}`}
                            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                            title="Xem chi tiết dự án"
                            aria-label="Xem chi tiết dự án"
                          >
                            <Eye className="h-4 w-4" />
                          </Link>
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Sửa dự án"
                              onClick={() => setEditProject(p)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              variant="destructive"
                              size="icon"
                              aria-label="Xoá dự án"
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
                    <ProjectMobileCard
                      key={p.id}
                      project={p}
                      canEdit={canEdit}
                      canDelete={canDelete}
                      onEdit={() => setEditProject(p)}
                      onDelete={() => setDeleteProject(p)}
                    />
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
            Bạn có chắc muốn ẩn dự án{' '}
            <strong className="text-foreground">&laquo;{deleteProject?.name}&raquo;</strong>? Dự án
            sẽ biến khỏi danh sách; dữ liệu liên quan không bị xoá.
          </>
        }
        confirmLabel="Xoá dự án"
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteProject) deleteMutation.mutate(deleteProject.id)
        }}
      />
    </div>
  )
}

/** Điện thoại (<640px): mỗi dự án 1 thẻ — chạm = xem chi tiết; Sửa
 * nút outline 44px, Xoá nằm trong menu "⋯" và đi qua `ConfirmDialog`. */
function ProjectMobileCard({
  project: p, canEdit, canDelete, onEdit, onDelete,
}: {
  project: Project
  canEdit: boolean
  canDelete: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const router = useRouter()
  return (
    <ShellListCard onClick={() => router.push(`/projects/${p.id}`)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{p.name}</p>
          <code className="text-xs bg-muted px-2 py-1 rounded">{p.code}</code>
        </div>
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
      </div>
      {p.color && (
        <ShellListCardRow
          label="Màu sắc"
          value={
            <Badge variant="secondary" className={COLOR_MAP[p.color] ?? 'bg-gray-50 text-gray-600'}>
              {COLOR_LABEL[p.color] ?? p.color}
            </Badge>
          }
        />
      )}
      <ShellListCardRow label="Ngày tạo" value={formatDate(p.created_at)} />
      {(canEdit || canDelete) && (
        <div className="flex items-center justify-end gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
          {canEdit && (
            <Button variant="outline" onClick={onEdit}>
              <Pencil className="mr-1.5 h-4 w-4" /> Sửa
            </Button>
          )}
          {canDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Thao tác khác"
                className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'min-h-11 min-w-11')}
              >
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem className="min-h-11" variant="destructive" onClick={onDelete}>
                  <Trash2 className="h-4 w-4" /> Xoá dự án
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </ShellListCard>
  )
}
