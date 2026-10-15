'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { UserMinus, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import apiClient from '@/lib/api-client'
import { usePermissions } from '@/lib/rbac'
import {
  apiErrorMessage,
  useRoleList,
  useRoleMembers,
  useSetUserRoles,
  type RoleSummary,
} from './use-roles-api'

interface UserRow {
  id: number
  full_name: string
  email: string
  status: string
  roles?: string[]
}

/** Người trong phạm vi `users.view` của người xem (BE tự lọc scope). */
function useScopedUsers(enabled: boolean) {
  return useQuery({
    queryKey: ['users', 'rbac-members-picker'],
    enabled,
    queryFn: async () => (await apiClient.get<{ data: UserRow[] }>('/users?limit=1000')).data.data,
  })
}

interface Props {
  role: RoleSummary
}

/** Tab "Người giữ": danh sách + thêm/gỡ người (gọi `PUT /users/:id/roles`). */
export function RoleMembers({ role }: Props) {
  const { can } = usePermissions()
  const canAssign = can('users.manage') && !role.is_system
  const { data: members = [], isLoading } = useRoleMembers(role.id)
  const { data: roles = [] } = useRoleList()
  const { data: users = [] } = useScopedUsers(canAssign && can('users.view'))
  const setRoles = useSetUserRoles()
  const [search, setSearch] = useState('')

  const idByName = useMemo(() => new Map(roles.map((r) => [r.name, r.id])), [roles])
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])
  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members])

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return users
      .filter((u) => !memberIds.has(u.id) && u.status === 'active')
      .filter((u) => u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .slice(0, 8)
  }, [users, memberIds, search])

  function currentRoleIds(userId: number): number[] {
    const names = userById.get(userId)?.roles ?? []
    return names.map((n) => idByName.get(n)).filter((x): x is number => x !== undefined)
  }

  function change(userId: number, roleIds: number[], okMsg: string) {
    setRoles.mutate(
      { userId, roleIds },
      {
        onSuccess: () => {
          toast.success(okMsg)
          setSearch('')
        },
        onError: (e) => toast.error(apiErrorMessage(e, 'Không đổi được vai trò')),
      },
    )
  }

  return (
    <div className="space-y-4">
      {canAssign && (
        <div className="space-y-2 rounded-[var(--radius)] border bg-white p-3">
          <label className="text-sm font-medium" htmlFor="role-member-search">
            Thêm người vào vai trò
          </label>
          <Input
            id="role-member-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Gõ tên hoặc email..."
            className="h-10 max-sm:h-11"
            autoComplete="off"
          />
          {candidates.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {candidates.map((u) => (
                <li key={u.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {u.full_name} <span className="text-xs text-muted-foreground">{u.email}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={setRoles.isPending}
                    onClick={() => change(u.id, [...currentRoleIds(u.id), role.id], `Đã thêm ${u.full_name}`)}
                  >
                    <UserPlus className="mr-1.5 h-4 w-4" /> Thêm
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {isLoading && <p className="py-4 text-center text-sm text-muted-foreground">Đang tải...</p>}
      {!isLoading && members.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">Chưa có ai giữ vai trò này</p>
      )}
      <ul className="divide-y rounded-[var(--radius)] border bg-white">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {m.full_name}
              {m.email && <span className="ml-1 text-xs text-muted-foreground">{m.email}</span>}
              {m.status === 'locked' && <span className="ml-2 text-xs text-red-700">Đã khoá</span>}
            </span>
            {canAssign && (
              <Button
                size="sm"
                variant="destructive"
                disabled={setRoles.isPending || !userById.has(m.id)}
                title={userById.has(m.id) ? undefined : 'Người này ngoài phạm vi quản lý của bạn'}
                onClick={() =>
                  change(m.id, currentRoleIds(m.id).filter((id) => id !== role.id), `Đã gỡ ${m.full_name}`)
                }
              >
                <UserMinus className="mr-1.5 h-4 w-4" /> Gỡ
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
