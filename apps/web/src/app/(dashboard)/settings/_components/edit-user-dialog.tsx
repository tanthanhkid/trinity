'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RotateCcw, Ban, Trash2, Eye, EyeOff, MoreHorizontal } from 'lucide-react'
import apiClient from '@/lib/api-client'
import {
  getUserAriaLabel,
  getUserDisplayName,
  getUserEmail,
  getUserEmailTooltip,
} from '@/lib/user-identity'
import { useAuth } from '@/hooks/use-auth'
import { usePermissions } from '@/lib/rbac'
import { ManagerSelectCombobox } from './manager-select-combobox'
import { RoleMultiSelect } from './roles/role-multi-select'
import { apiErrorMessage, useRoleList, useSetUserRoles } from './roles/use-roles-api'
import type { OrgUser } from './user-org-tree'

export interface EditableUser extends OrgUser {
  phone?: string | null
}

interface EditForm {
  email: string
  full_name: string
  phone: string
  manager_id: number | null
  status: 'active' | 'locked'
}

interface EditUserDialogProps {
  user: EditableUser
  /** Toàn bộ người dùng đang thấy — nguồn chọn quản lý trực tiếp (không còn lọc theo vai trò). */
  allUsers: EditableUser[]
  onClose: () => void
}

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')
}

export function EditUserDialog({ user, allUsers, onClose }: EditUserDialogProps) {
  const queryClient = useQueryClient()
  const { user: currentUser } = useAuth()
  const { can, isAdmin } = usePermissions()
  const { data: roles = [], isLoading: rolesLoading } = useRoleList()
  const setUserRoles = useSetUserRoles()

  const initialRoleIds = roles.filter((r) => (user.roles ?? []).includes(r.name)).map((r) => r.id)
  const [roleIds, setRoleIds] = useState<number[] | null>(null)
  const selectedRoleIds = roleIds ?? initialRoleIds
  const [form, setForm] = useState<EditForm>({
    email: user.email,
    full_name: user.full_name,
    phone: user.phone ?? '',
    manager_id: user.manager_id ?? null,
    status: user.status,
  })
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
  const [showPermanentDeleteConfirm, setShowPermanentDeleteConfirm] = useState(false)
  const [permanentDeleteEmailInput, setPermanentDeleteEmailInput] = useState('')
  const [customPasswordInput, setCustomPasswordInput] = useState('')
  const [showCustomPassword, setShowCustomPassword] = useState(false)
  // Điện thoại: 2 hành động đỏ gom vào khối thu gọn, tách khỏi nút Lưu.
  const [showDanger, setShowDanger] = useState(false)
  // BE chặn tự sửa/khoá/reset chính mình (403) — FE khoá nút để khỏi click rồi fail.
  const isSelf = currentUser?.id === user.id
  const canManage = can('users.manage')
  const phoneMasked = form.phone.includes('*')
  const userDisplayName = getUserDisplayName(user)
  const userEmailTooltip = getUserEmailTooltip(user)
  const userAriaLabel = getUserAriaLabel(user)

  const managerOptions = allUsers
    .filter((u) => u.id !== user.id && u.status === 'active')
    .map((u) => ({ id: u.id, label: `${u.full_name} (${u.email})` }))

  const editMutation = useMutation({
    mutationFn: async () => {
      await apiClient.patch(`/users/${user.id}`, {
        email: form.email,
        full_name: form.full_name,
        // Ô SĐT bị xoá trống ⇒ null để BE xoá thật (undefined bị bỏ khỏi JSON, số cũ vẫn còn). Số đang che (*) thì không gửi.
        phone: phoneMasked ? undefined : form.phone || null,
        manager_id: form.manager_id,
        status: form.status,
      })
      if (!sameIds(selectedRoleIds, initialRoleIds)) {
        await setUserRoles.mutateAsync({ userId: user.id, roleIds: selectedRoleIds })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      onClose()
    },
    // hiện NGUYÊN VĂN message BE (vd "Không thể cấp quyền bạn không có", "Phải còn ít nhất 1 Quản trị").
    onError: (e) => toast.error(apiErrorMessage(e, 'Không lưu được thay đổi')),
  })

  const resetPasswordMutation = useMutation({
    mutationFn: (payload: { password: string }) =>
      apiClient.patch<{ message: string }>(`/users/${user.id}/reset-password`, payload),
    onSuccess: () => {
      setShowResetConfirm(false)
      setCustomPasswordInput('')
      setShowCustomPassword(false)
      toast.success('Đã cài lại mật khẩu thành công')
    },
    onError: (err: unknown) => {
      toast.error('Cài lại mật khẩu thất bại', { description: apiErrorMessage(err, 'Vui lòng thử lại.') })
    },
  })

  const disableMutation = useMutation({
    mutationFn: () => apiClient.delete(`/users/${user.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setShowDisableConfirm(false)
      onClose()
    },
    onError: (err: unknown) => {
      setShowDisableConfirm(false)
      toast.error('Không vô hiệu hoá được người dùng', { description: apiErrorMessage(err, 'Vui lòng thử lại.') })
    },
  })

  const permanentDeleteMutation = useMutation({
    mutationFn: () => apiClient.delete(`/users/${user.id}/permanent`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setShowPermanentDeleteConfirm(false)
      setPermanentDeleteEmailInput('')
      onClose()
    },
    onError: (err: unknown) => {
      // Hành động irreversible — phải feedback rõ khi BE từ chối (Quản trị cuối cùng, tự xoá...).
      toast.error('Không xoá được người dùng', { description: apiErrorMessage(err, 'Vui lòng thử lại sau.') })
    },
  })

  return (
    <>
      <Dialog open onOpenChange={() => onClose()}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle title={userEmailTooltip} aria-label={`Sửa người dùng: ${userAriaLabel}`}>
              Sửa người dùng: {userDisplayName}
            </DialogTitle>
          </DialogHeader>
          {isSelf && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Bạn không thể tự sửa tài khoản hoặc vai trò của chính mình — nhờ người quản trị khác thực hiện.
            </p>
          )}
          <div className="min-w-0 space-y-4">
            <div className="space-y-1">
              <Label>Email</Label>
              <Input value={form.email} disabled={isSelf} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" className="h-11" />
            </div>
            <div className="space-y-1">
              <Label>Họ tên</Label>
              <Input value={form.full_name} disabled={isSelf} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Nguyễn Văn A" className="h-11" />
            </div>
            <div className="space-y-1">
              <Label>Số điện thoại</Label>
              <Input
                value={form.phone}
                disabled={isSelf || phoneMasked}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="0900000002"
                className="h-11"
              />
              {phoneMasked && (
                <p className="text-xs text-muted-foreground">Số điện thoại đang bị che theo quyền của bạn nên không sửa được.</p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Vai trò (có thể chọn nhiều — quyền cộng dồn)</Label>
              <RoleMultiSelect
                roles={roles}
                value={selectedRoleIds}
                onChange={setRoleIds}
                canGrantSystem={isAdmin}
                loading={rolesLoading}
                disabled={isSelf}
              />
            </div>
            <div className="space-y-1">
              <Label>Quản lý trực tiếp</Label>
              <ManagerSelectCombobox
                options={managerOptions}
                value={form.manager_id ? String(form.manager_id) : null}
                onChange={(v) => setForm({ ...form, manager_id: v ? Number(v) : null })}
                placeholder="Chọn người quản lý"
                unassignedLabel="— Chưa gán người quản lý —"
                disabled={isSelf}
              />
              <p className="text-xs text-muted-foreground">
                Phạm vi dữ liệu (của mình / cấp dưới / toàn bộ cấp dưới) tính theo cây quản lý này.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Trạng thái</Label>
              <Select value={form.status} disabled={isSelf} onValueChange={(v) => setForm({ ...form, status: v as 'active' | 'locked' })}>
                <SelectTrigger className="h-11">
                  <SelectValue placeholder="Chọn trạng thái">
                    {(v) => (v === 'active' ? 'Hoạt động' : v === 'locked' ? 'Đã khoá' : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Hoạt động</SelectItem>
                  <SelectItem value="locked">Đã khoá</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t pt-2">
            {canManage && (
              <Button
                variant="outline"
                className="h-11 shrink-0 max-sm:w-full"
                disabled={isSelf}
                title={isSelf ? 'Không thể cài lại mật khẩu của chính bạn — nhờ quản trị viên khác thực hiện' : undefined}
                onClick={() => setShowResetConfirm(true)}
              >
                <RotateCcw className="mr-2 h-4 w-4" /> Cài lại mật khẩu
              </Button>
            )}
            {canManage && user.status === 'active' && (
              <Button variant="destructive" disabled={isSelf} className="h-11 shrink-0 max-sm:hidden" onClick={() => setShowDisableConfirm(true)}>
                <Ban className="mr-2 h-4 w-4" /> Vô hiệu hoá
              </Button>
            )}
            {isAdmin && (
              <Button
                variant="destructive"
                disabled={isSelf}
                className="h-11 shrink-0 max-sm:hidden"
                onClick={() => {
                  setPermanentDeleteEmailInput('')
                  setShowPermanentDeleteConfirm(true)
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Xoá vĩnh viễn
              </Button>
            )}
            {/* Điện thoại: khối "Thao tác khác" thu gọn mặc định; nút nguy hiểm dạng outline, không nền đỏ đặc. */}
            {(canManage || isAdmin) && (
              <div className="hidden w-full max-sm:block">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-start text-muted-foreground"
                  aria-expanded={showDanger}
                  aria-label="Thao tác khác"
                  onClick={() => setShowDanger((v) => !v)}
                >
                  <MoreHorizontal className="mr-2 h-4 w-4" /> Thao tác khác
                </Button>
                {showDanger && (
                  <div className="mt-1 flex flex-col gap-3 rounded-lg border border-dashed p-3">
                    {canManage && user.status === 'active' && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isSelf}
                        className="text-destructive"
                        onClick={() => setShowDisableConfirm(true)}
                      >
                        <Ban className="mr-2 h-4 w-4" /> Vô hiệu hoá
                      </Button>
                    )}
                    {isAdmin && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isSelf}
                        className="text-destructive"
                        onClick={() => {
                          setPermanentDeleteEmailInput('')
                          setShowPermanentDeleteConfirm(true)
                        }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Xoá vĩnh viễn
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => onClose()}>Huỷ</Button>
            <Button
              className="h-11"
              disabled={isSelf || editMutation.isPending || !canManage}
              onClick={() => editMutation.mutate()}
            >
              {editMutation.isPending ? 'Đang lưu...' : 'Lưu'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showResetConfirm} onOpenChange={(open) => {
        setShowResetConfirm(open)
        if (!open) { setCustomPasswordInput(''); setShowCustomPassword(false) }
      }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cài lại mật khẩu</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Đặt mật khẩu mới cho{' '}
              <span className="font-semibold" title={userEmailTooltip} aria-label={userAriaLabel}>
                {userDisplayName}
              </span>.
            </p>
            <div className="space-y-1">
              <Label>Mật khẩu mới <span className="text-red-500">*</span></Label>
              <div className="relative">
                <Input
                  type={showCustomPassword ? 'text' : 'password'}
                  value={customPasswordInput}
                  onChange={(e) => setCustomPasswordInput(e.target.value)}
                  placeholder="Nhập mật khẩu mới (tối thiểu 8 ký tự)"
                  className="h-11 pr-10"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground max-sm:after:absolute max-sm:after:-inset-3"
                  onClick={() => setShowCustomPassword((v) => !v)}
                  tabIndex={-1}
                >
                  {showCustomPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {customPasswordInput.length === 0 && (
                <p className="text-xs text-red-500">Vui lòng nhập mật khẩu mới</p>
              )}
              {customPasswordInput.length > 0 && customPasswordInput.length < 8 && (
                <p className="text-xs text-red-500">Mật khẩu phải có ít nhất 8 ký tự</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setShowResetConfirm(false)}>Huỷ</Button>
            <Button
              className="h-11"
              disabled={resetPasswordMutation.isPending || customPasswordInput.trim().length < 8}
              onClick={() => resetPasswordMutation.mutate({ password: customPasswordInput })}
            >
              {resetPasswordMutation.isPending ? 'Đang xử lý...' : 'Xác nhận reset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showPermanentDeleteConfirm}
        onOpenChange={(open) => {
          setShowPermanentDeleteConfirm(open)
          if (!open) setPermanentDeleteEmailInput('')
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Xác nhận xoá vĩnh viễn tài khoản</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-red-700">
              Tài khoản{' '}
              <span className="font-semibold" title={userEmailTooltip} aria-label={userAriaLabel}>
                {userDisplayName}
              </span>{' '}
              sẽ bị ẩn khỏi mọi danh sách quản trị và không thể đăng nhập lại.
              Hành động này không thể hoàn tác qua giao diện.
            </p>
            <div className="space-y-1">
              <Label>
                Nhập lại email <span className="font-mono">{getUserEmail(user) ?? '—'}</span> để
                xác nhận
              </Label>
              <Input
                value={permanentDeleteEmailInput}
                onChange={(e) => setPermanentDeleteEmailInput(e.target.value)}
                placeholder={user.email}
                className="h-11"
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => setShowPermanentDeleteConfirm(false)}
            >
              Huỷ
            </Button>
            <Button
              variant="destructive"
              className="h-11"
              disabled={
                permanentDeleteMutation.isPending ||
                permanentDeleteEmailInput.trim() !== user.email
              }
              onClick={() => permanentDeleteMutation.mutate()}
            >
              {permanentDeleteMutation.isPending
                ? 'Đang xoá...'
                : 'Xoá vĩnh viễn'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDisableConfirm} onOpenChange={setShowDisableConfirm}>
        <DialogContent>
          <DialogHeader><DialogTitle>Xác nhận vô hiệu hoá tài khoản</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Tài khoản{' '}
            <span className="font-semibold" title={userEmailTooltip} aria-label={userAriaLabel}>
              {userDisplayName}
            </span>{' '}
            sẽ bị khoá và không thể đăng nhập. Bạn có thể kích hoạt lại sau.
          </p>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setShowDisableConfirm(false)}>Huỷ</Button>
            <Button variant="destructive" className="h-11" disabled={disableMutation.isPending} onClick={() => disableMutation.mutate()}>
              {disableMutation.isPending ? 'Đang xử lý...' : 'Vô hiệu hoá'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
