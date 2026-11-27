'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, Link2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import apiClient from '@/lib/api-client'
import { apiErrorMessage } from './roles/use-roles-api'

export interface InvitationRow {
  id: number
  email: string
  role_id: number | null
  role_name: string | null
  status: 'pending' | 'accepted' | 'revoked' | 'expired' | 'unusable'
  expires_at: string
  created_at: string
}

interface CreatedInvitation extends InvitationRow {
  token: string
  path: string
}

export const INVITES_KEY = ['users', 'invitations'] as const

function inviteUrl(path: string): string {
  return `${window.location.origin}${path}`
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Đã chép link mời')
  } catch {
    toast.error('Không chép được, hãy bôi đen link và chép tay')
  }
}

/** Nút + hộp thoại "Mời bằng link": nhập email, chọn vai trò, nhận link để chép gửi qua Zalo/Messenger. */
export function InviteByLinkButton({
  prefill,
  roles: fixedRoles,
  disabled,
  label,
}: {
  prefill?: { email: string; roleId: number | null }
  /** Danh sách vai trò cố định (trang Thành viên); không truyền thì hỏi server như trước. */
  roles?: Array<{ id: number; name: string }>
  disabled?: boolean
  label?: string
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [roleId, setRoleId] = useState<number | null>(null)
  const [created, setCreated] = useState<CreatedInvitation | null>(null)
  // Server lọc theo đúng luật mời (ẩn vai trò Quản trị nếu không phải admin, ẩn vai trò có quyền vượt người mời).
  const { data: fetchedRoles = [], isLoading: fetchedLoading } = useQuery({
    queryKey: [...INVITES_KEY, 'roles'],
    enabled: open && !fixedRoles,
    queryFn: async () => (await apiClient.get<{ data: Array<{ id: number; name: string }> }>('/auth/invitations/roles')).data.data,
  })

  const roles = fixedRoles ?? fetchedRoles
  const rolesLoading = fixedRoles ? false : fetchedLoading
  const create = useMutation({
    mutationFn: async () =>
      (await apiClient.post<CreatedInvitation>('/auth/invitations', { email: email.trim(), role_id: roleId })).data,
    onSuccess: (inv) => {
      setCreated(inv)
      queryClient.invalidateQueries({ queryKey: INVITES_KEY })
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Chưa tạo được lời mời, vui lòng thử lại')),
  })

  function close() {
    setOpen(false)
    setCreated(null)
    setEmail('')
    setRoleId(null)
  }

  function start() {
    setEmail(prefill?.email ?? '')
    setRoleId(prefill?.roleId ?? null)
    setCreated(null)
    setOpen(true)
  }

  const valid = /^\S+@\S+\.\S+$/.test(email.trim()) && roleId !== null

  return (
    <>
      <Button variant={label && !prefill ? 'default' : 'outline'} className="h-11" onClick={start} disabled={disabled}>
        <Link2 className="mr-2 h-4 w-4" /> {label ?? (prefill ? 'Tạo link mới' : 'Mời bằng link')}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{created ? 'Link mời đã sẵn sàng' : 'Mời nhân viên bằng link'}</DialogTitle>
          </DialogHeader>
          {created ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Chép link rồi gửi cho <span className="font-semibold text-foreground">{created.email}</span> qua Zalo hoặc Messenger. Link dùng được một lần,
                hết hạn {new Date(created.expires_at).toLocaleDateString('vi-VN')}, và chỉ hiện lần này (cần link mới thì bấm "Tạo link mới" ở danh sách lời mời).
              </p>
              <div className="flex items-center gap-2">
                <Input readOnly value={inviteUrl(created.path)} className="h-11 font-mono text-xs" aria-label="Link mời" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" className="h-11 shrink-0" onClick={() => void copyText(inviteUrl(created.path))}>
                  <Copy className="mr-2 h-4 w-4" /> Sao chép
                </Button>
              </div>
              <DialogFooter>
                <Button className="h-11" onClick={close}>Xong</Button>
              </DialogFooter>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (valid) create.mutate()
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="invite-email">Email nhân viên</Label>
                <Input
                  id="invite-email"
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nhanvien@congty.vn"
                  className="h-11"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="invite-role">Vai trò</Label>
                <select
                  id="invite-role"
                  value={roleId ?? ''}
                  onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : null)}
                  disabled={rolesLoading}
                  className="h-11 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">{rolesLoading ? 'Đang tải...' : '— Chọn vai trò —'}</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                {!fixedRoles && <p className="text-xs text-muted-foreground">Chỉ hiện vai trò có quyền không vượt quá quyền của bạn.</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" className="h-11" onClick={close}>Huỷ</Button>
                <Button type="submit" className="h-11" disabled={!valid || create.isPending}>
                  {create.isPending ? 'Đang tạo...' : 'Tạo link mời'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Lời mời đang chờ: huỷ hoặc tạo lại (link cũ chết, link mới thay thế). Link gốc không xem lại được. */
export function PendingInvitations() {
  const queryClient = useQueryClient()
  const { data = [] } = useQuery({
    queryKey: INVITES_KEY,
    queryFn: async () => (await apiClient.get<{ data: InvitationRow[] }>('/auth/invitations')).data.data,
  })
  const revoke = useMutation({
    mutationFn: (id: number) => apiClient.post(`/auth/invitations/${id}/revoke`),
    onSuccess: () => {
      toast.success('Đã huỷ lời mời')
      queryClient.invalidateQueries({ queryKey: INVITES_KEY })
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Chưa huỷ được lời mời')),
  })
  if (data.length === 0) return null
  return (
    <section aria-label="Lời mời đang chờ" className="space-y-2 rounded-[var(--radius)] border bg-white p-4">
      <h3 className="text-sm font-semibold">Lời mời đang chờ ({data.filter((i) => i.status === 'pending').length})</h3>
      <ul className="divide-y">
        {data.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{inv.email}</div>
              <div className="text-xs text-muted-foreground">
                {inv.role_name ?? 'Chưa có vai trò'} · hết hạn {new Date(inv.expires_at).toLocaleDateString('vi-VN')}
              </div>
              {inv.status === 'unusable' && (
                <div className="text-xs font-medium text-destructive">
                  Link này không dùng được nữa (người mời đã mất quyền hoặc vai trò đã bị xoá). Hãy huỷ và tạo link mới.
                </div>
              )}
            </div>
            <InviteByLinkButton prefill={{ email: inv.email, roleId: inv.role_id }} />
            <Button variant="ghost" className="h-11" disabled={revoke.isPending} onClick={() => revoke.mutate(inv.id)}>
              <X className="mr-1 h-4 w-4" /> Huỷ
            </Button>
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <RefreshCw className="h-3 w-3" /> Tạo link mới cho cùng email thì link cũ hết dùng được.
      </p>
    </section>
  )
}
