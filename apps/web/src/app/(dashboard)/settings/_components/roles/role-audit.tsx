'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatDateTimeVn } from '@/lib/format'
import { auditActionLabel, describeAudit } from './audit-format'
import { apiErrorMessage, useRoleAudit, type RbacCatalog } from './use-roles-api'

interface Props {
  roleId: number
  catalog: RbacCatalog | undefined
}

/** Tab "Nhật ký": ai sửa gì, lúc nào (quyền hiển thị dạng diff, nhãn từ danh mục). */
export function RoleAudit({ roleId, catalog }: Props) {
  const [page, setPage] = useState(1)
  const { data, isLoading, isError, error } = useRoleAudit(roleId, page)
  const labelOf = (key: string) => catalog?.permissions.find((p) => p.key === key)?.label ?? key
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  if (isLoading) return <p className="py-6 text-center text-sm text-muted-foreground">Đang tải nhật ký...</p>
  if (isError) {
    return <p className="py-6 text-center text-sm text-red-600">{apiErrorMessage(error, 'Không tải được nhật ký')}</p>
  }
  if (!data || data.data.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Chưa có thay đổi nào</p>
  }
  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-[var(--radius)] border bg-white">
        {data.data.map((row) => (
          <li key={row.id} className="space-y-1 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{auditActionLabel(row.action)}</span>
              <span className="text-muted-foreground">bởi {row.actor_name}</span>
              <span className="ml-auto text-xs text-muted-foreground">{formatDateTimeVn(row.created_at)}</span>
            </div>
            {describeAudit(row, labelOf).map((line, i) => (
              <div key={i} className="break-words text-xs text-muted-foreground">
                {line}
              </div>
            ))}
          </li>
        ))}
      </ul>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Trước
          </Button>
          <span>
            {page}/{pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Sau
          </Button>
        </div>
      )}
    </div>
  )
}
