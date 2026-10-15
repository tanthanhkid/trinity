'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Download, Plus, Search } from 'lucide-react'
import apiClient from '@/lib/api-client'
import { usePermissions } from '@/lib/rbac'
import { EditUserDialog, type EditableUser } from './edit-user-dialog'
import { ManagerSelectCombobox } from './manager-select-combobox'
import { RoleMultiSelect } from './roles/role-multi-select'
import { apiErrorMessage, useRoleList } from './roles/use-roles-api'
import { UserOrgTree } from './user-org-tree'
import { SettingsSectionActions } from './settings-section-header'

interface UsersResponse {
  data: EditableUser[]
  total: number
  page: number
  limit: number
}

const createSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
  full_name: z.string().min(2, 'Tên tối thiểu 2 ký tự'),
  password: z.string().min(8, 'Mật khẩu tối thiểu 8 ký tự'),
  manager_id: z.number().optional().nullable(),
})
type CreateForm = z.infer<typeof createSchema>

// Lấy TOÀN BỘ user 1 lần để dựng sơ đồ tổ chức client-side (KHÔNG phân trang —
// cây cần đủ mọi node). limit=1000 khớp cap BE (users.controller findAll). BE tự
// lọc theo phạm vi `users.view` của người xem.
async function fetchAllUsers(): Promise<EditableUser[]> {
  const res = await apiClient.get<UsersResponse>('/users?limit=1000')
  return res.data?.data ?? []
}

export function SettingsUsers() {
  const queryClient = useQueryClient()
  const { can, isAdmin } = usePermissions()
  const [showCreate, setShowCreate] = useState(false)
  const [editUser, setEditUser] = useState<EditableUser | null>(null)
  const [search, setSearch] = useState('')
  const [createRoleIds, setCreateRoleIds] = useState<number[]>([])

  const usersQuery = useQuery({
    queryKey: ['users', 'org-tree'],
    queryFn: fetchAllUsers,
    enabled: can('users.view'),
  })
  const allUsers = usersQuery.data ?? []
  const { data: roles = [], isLoading: rolesLoading } = useRoleList(showCreate)

  const canManage = can('users.manage')
  const canExport = can('users.export')
  const [isExporting, setIsExporting] = useState(false)

  // Xuất Excel danh sách người dùng đang hiển thị (áp dụng ô tìm kiếm hiện hành).
  async function handleExport() {
    try {
      setIsExporting(true)
      const params = new URLSearchParams()
      const q = search.trim()
      if (q) params.set('search', q)
      const res = await apiClient.get<Blob>(
        `/users/export?${params.toString()}`,
        { responseType: 'blob' },
      )
      const blob = res.data
      if (!blob || blob.size === 0) {
        toast.error('Không có dữ liệu để xuất')
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'danh-sach-nguoi-dung.xlsx'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch {
      toast.error('Xuất Excel thất bại, vui lòng thử lại')
    } finally {
      setIsExporting(false)
    }
  }

  const { register, handleSubmit, setValue, reset, watch, formState: { errors } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
  })
  const selectedManagerId = watch('manager_id')

  const managerOptions = allUsers
    .filter((u) => u.status === 'active')
    .map((u) => ({ id: u.id, label: `${u.full_name} (${u.email})` }))

  const createMutation = useMutation({
    mutationFn: async (data: CreateForm) => {
      const created = await apiClient.post<{ id: number }>('/users', {
        email: data.email,
        full_name: data.full_name,
        password: data.password,
        manager_id: data.manager_id ?? null,
      })
      if (createRoleIds.length === 0) return { roleError: null as string | null }
      try {
        await apiClient.put(`/users/${created.data.id}/roles`, { roleIds: createRoleIds })
        return { roleError: null as string | null }
      } catch (e) {
        // Tài khoản ĐÃ tạo — chỉ phần gán vai trò lỗi; báo nguyên văn BE.
        return { roleError: apiErrorMessage(e, 'Không gán được vai trò') }
      }
    },
    onSuccess: ({ roleError }) => {
      if (roleError) toast.warning(`Đã tạo người dùng nhưng chưa gán được vai trò: ${roleError}`)
      else toast.success('Đã tạo người dùng mới')
      queryClient.invalidateQueries({ queryKey: ['users'] })
      queryClient.invalidateQueries({ queryKey: ['rbac'] })
      closeCreate()
    },
    onError: (error: unknown) => {
      toast.error(apiErrorMessage(error, 'Không thể tạo người dùng, vui lòng thử lại'))
    },
  })

  function closeCreate() {
    setShowCreate(false)
    setCreateRoleIds([])
    reset()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1 max-sm:min-w-0 max-sm:basis-full">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm theo tên, email hoặc vai trò..."
            className="h-11 pl-9"
          />
        </div>
        <div className="text-sm text-muted-foreground max-sm:flex-1 max-sm:text-xs">
          {usersQuery.isLoading ? 'Đang tải...' : `${allUsers.length} người dùng`}
        </div>
        {canExport && (
          <Button variant="outline" className="h-11" onClick={handleExport} disabled={isExporting || usersQuery.isLoading}>
            <Download className="mr-2 h-4 w-4" />
            {isExporting ? 'Đang xuất...' : 'Xuất Excel'}
          </Button>
        )}
      </div>
      {canManage && (
        <SettingsSectionActions mobile="fab">
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-4 w-4" /> Thêm người dùng
          </Button>
        </SettingsSectionActions>
      )}

      {usersQuery.isError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <span>Không tải được danh sách người dùng. Vui lòng thử lại.</span>
          <Button variant="outline" size="sm" className="h-8" onClick={() => usersQuery.refetch()}>
            Thử lại
          </Button>
        </div>
      )}

      {usersQuery.isLoading ? (
        <div className="rounded-[var(--radius)] border bg-white p-8 text-center text-sm text-muted-foreground shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
          Đang tải sơ đồ tổ chức...
        </div>
      ) : (
        <UserOrgTree users={allUsers} search={search.trim()} canManage={canManage} onEdit={(u) => setEditUser(u as EditableUser)} />
      )}

      <Dialog open={showCreate} onOpenChange={(open) => !open && closeCreate()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Thêm người dùng</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit((d) => createMutation.mutate(d))} className="space-y-4">
            <div className="space-y-1">
              <Label>Email</Label>
              <Input {...register('email')} placeholder="email@example.com" className="h-11" />
              {errors.email && <p className="text-xs text-red-500">{errors.email.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>Họ tên</Label>
              <Input {...register('full_name')} placeholder="Nguyễn Văn A" className="h-11" />
              {errors.full_name && <p className="text-xs text-red-500">{errors.full_name.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>Mật khẩu</Label>
              <Input type="password" {...register('password')} placeholder="Tối thiểu 8 ký tự" className="h-11" />
              {errors.password && <p className="text-xs text-red-500">{errors.password.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>Vai trò (có thể chọn nhiều — quyền cộng dồn)</Label>
              <RoleMultiSelect roles={roles} value={createRoleIds} onChange={setCreateRoleIds} canGrantSystem={isAdmin} loading={rolesLoading} />
            </div>
            <div className="space-y-1">
              <Label>Quản lý trực tiếp</Label>
              <ManagerSelectCombobox
                options={managerOptions}
                value={selectedManagerId ? String(selectedManagerId) : null}
                onChange={(v) => setValue('manager_id', v ? Number(v) : null)}
                placeholder="Chọn người quản lý (có thể gán sau)"
                unassignedLabel="— Chưa gán người quản lý —"
              />
              <p className="text-xs text-muted-foreground">
                Phạm vi dữ liệu của người này tính theo cây quản lý; chọn người quản lý để họ thấy dữ liệu cấp dưới.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" className="h-11" onClick={closeCreate}>Huỷ</Button>
              <Button type="submit" className="h-11" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Đang tạo...' : 'Tạo'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {editUser && (
        <EditUserDialog key={editUser.id} user={editUser} allUsers={allUsers} onClose={() => setEditUser(null)} />
      )}
    </div>
  )
}
