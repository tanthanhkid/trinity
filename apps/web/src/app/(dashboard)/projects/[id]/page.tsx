'use client'

import { PermissionGate } from "@/lib/rbac"
import { use } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, FolderOpen, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ShellPageHeader } from '@/components/app-shell/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { fetchProject } from './_components/api'
import { PROJECT_COLOR_MAP } from './_components/types'
import { formatDate } from '@/lib/format'

export default function ProjectDetailPage(props: {
  params: Promise<{ id: string }>
}) {
  return (
    <PermissionGate permission="products.view">
      <ProjectDetailScreen {...props} />
    </PermissionGate>
  )
}

function ProjectDetailScreen({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const projectId = Number(id)

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => fetchProject(projectId),
    enabled: Number.isFinite(projectId),
  })

  if (!isLoading && !project) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <p className="text-sm text-muted-foreground">Không tải được dự án này (không tồn tại hoặc bạn không có quyền xem).</p>
        <Link href="/projects" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Quay lại danh sách dự án
        </Link>
      </div>
    )
  }

  if (isLoading || !project) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--color-app-primary-ink)]" />
      </div>
    )
  }

  const colorClass = project.color
    ? PROJECT_COLOR_MAP[project.color] ?? 'bg-gray-50 text-gray-600'
    : 'bg-gray-50 text-gray-600'

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground max-sm:min-h-11"
        >
          <ArrowLeft className="h-4 w-4" /> Quay lại danh sách dự án
        </Link>
        <ShellPageHeader
          title={project.name}
          icon={FolderOpen}
          badge={
            <>
              <Badge variant="secondary" className={colorClass}>
                <code className="text-xs">{project.code}</code>
              </Badge>
              {!project.is_active && (
                <Badge variant="secondary" className="bg-gray-100 text-gray-500">
                  Ngừng hoạt động
                </Badge>
              )}
            </>
          }
        />
      </div>

      <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Thông tin dự án</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Tên dự án</dt>
              <dd className="font-medium">{project.name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Mã dự án</dt>
              <dd>
                <code className="text-xs bg-muted px-2 py-1 rounded">
                  {project.code}
                </code>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Ngày tạo</dt>
              <dd>{formatDate(project.created_at)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

    </div>
  )
}
