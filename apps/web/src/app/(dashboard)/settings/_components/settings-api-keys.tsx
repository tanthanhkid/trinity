'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { Resolver } from 'react-hook-form'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Copy,
  Info,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import apiClient from '@/lib/api-client'
import { formatDateTime } from '@/lib/format'
import { usePermissions } from '@/lib/rbac'
import { SettingsSectionActions } from './settings-section-header'
import { MOBILE_FAB_CLASS } from '@/components/app-shell/mobile-primary'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { InlineSelect } from "@/components/ui/inline-select"
import { VnDateTimeInput } from "@/components/ui/vn-datetime-input"

const SCOPES = [
  {
    value: 'auth:login',
    label: 'Đăng nhập người dùng',
    description: 'Cho phép POST /api/v1/public/auth/login bằng email + mật khẩu.',
  },
  {
    value: 'contacts:create',
    label: 'Tạo khách hàng',
    description: 'Cho phép POST /api/v1/public/contacts.',
  },
  {
    value: 'deals:create',
    label: 'Tạo thương vụ / đơn',
    description: 'Cho phép POST /api/v1/public/deals (Zapier, n8n…).',
  },
  {
    value: 'tasks:create',
    label: 'Tạo việc',
    description: 'Cho phép POST /api/v1/public/tasks — tạo thẻ việc trên bảng Kanban.',
  },
  // 🔴 Danh sách này là bản sao THỦ CÔNG của `API_KEY_SCOPES`
  // của BE — không import chéo service được. Thiếu ở đây thì BE có nhận phạm vi mới cũng VÔ NGHĨA:
  // không ô nào để tick, và `z.enum` bên dưới chặn luôn cả khi sửa tay payload
  // ⇒ tính năng "chạy mà như không chạy". Thêm phạm vi ở BE PHẢI thêm cả 2 chỗ
  // dưới đây; có test đối chiếu 2 danh sách.
] as const

type ScopeValue = (typeof SCOPES)[number]['value']

/** Tuple cho `z.enum` — giữ nguyên literal type, không rơi về `string[]`. */
const SCOPE_VALUES = SCOPES.map((s) => s.value) as unknown as [
  ScopeValue,
  ...ScopeValue[],
]

interface ApiKey {
  id: number
  name: string
  prefix: string
  scopes: string[]
  owner_user_id: number
  created_by: number
  last_used_at: string | null
  last_used_ip: string | null
  expires_at: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
}

interface UserLite {
  id: number
  full_name: string
  email: string
}

interface ApiKeyWithPlain extends ApiKey {
  plain_key: string
  message?: string
}

const createSchema = z.object({
  name: z.string().min(1, 'Tên không được để trống').max(120, 'Tối đa 120 ký tự'),
  scopes: z
    // Sinh TỪ `SCOPES` — thêm mục ở trên là zod tự nhận, không còn chỗ để quên.
    .array(z.enum(SCOPE_VALUES))
    .min(1, 'Chọn ít nhất 1 phạm vi'),
  owner_user_id: z
    .number({ error: 'Chọn người nhận' })
    .int('User ID phải là số nguyên')
    .positive('User ID không hợp lệ'),
  expires_at: z.string().optional().or(z.literal('')),
})
type CreateForm = z.infer<typeof createSchema>

async function fetchApiKeys(): Promise<ApiKey[]> {
  const res = await apiClient.get<ApiKey[]>('/api-keys')
  return Array.isArray(res.data) ? res.data : []
}

async function fetchOwnerUsers(): Promise<UserLite[]> {
  // Dùng `limit=1000` (tối đa BE cho phép): danh sách sắp theo `id` tăng dần và BE
  // cắt đúng `limit`, nên limit nhỏ sẽ làm người tạo sau biến mất khỏi dropdown.
  const res = await apiClient.get<{ data?: UserLite[] } | UserLite[]>(
    '/users?limit=1000&status=active',
  )
  const payload = res.data
  if (Array.isArray(payload)) return payload
  return payload?.data ?? []
}

function formatDate(value: string | null): string {
  return formatDateTime(value)
}

export function SettingsApiKeys() {
  const { can } = usePermissions()
  const canConfigure = can('settings.integrations')
  const queryClient = useQueryClient()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [pending, setPending] = useState<{ kind: 'rotate' | 'revoke'; key: ApiKey } | null>(null)
  const [revealed, setRevealed] = useState<ApiKeyWithPlain | null>(null)

  const { data: keys = [], isLoading } = useQuery({
    queryKey: ['api-keys'],
    queryFn: fetchApiKeys,
    enabled: canConfigure,
  })

  const { data: users = [] } = useQuery({
    queryKey: ['api-keys-owner-users'],
    queryFn: fetchOwnerUsers,
    enabled: canConfigure && can('users.view'),
  })

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateForm>({
    resolver: zodResolver(createSchema) as Resolver<CreateForm>,
    defaultValues: {
      name: '',
      scopes: ['contacts:create'],
      owner_user_id: undefined as unknown as number,
      expires_at: '',
    },
  })

  const createMutation = useMutation({
    mutationFn: (data: CreateForm) =>
      apiClient.post<ApiKeyWithPlain>('/api-keys', {
        name: data.name.trim(),
        scopes: data.scopes,
        owner_user_id: Number(data.owner_user_id),
        expires_at: data.expires_at ? data.expires_at : undefined,
      }),
    onSuccess: (res) => {
      setRevealed(res.data)
      setDialogOpen(false)
      reset({ name: '', scopes: ['contacts:create'], owner_user_id: undefined as unknown as number, expires_at: '' })
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string | string[] } } })?.response
          ?.data?.message ?? 'Không tạo được khoá'
      alert(Array.isArray(msg) ? msg.join('\n') : msg)
    },
  })

  const rotateMutation = useMutation({
    mutationFn: (id: number) =>
      apiClient.post<ApiKeyWithPlain>(`/api-keys/${id}/rotate`, {}),
    onSuccess: (res) => {
      setRevealed(res.data)
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response
          ?.data?.message ?? 'Không xoay được khoá'
      alert(msg)
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (id: number) => apiClient.delete(`/api-keys/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string | string[] } } })?.response
          ?.data?.message ?? 'Không thu hồi được khoá — khoá vẫn còn hiệu lực'
      alert(Array.isArray(msg) ? msg.join('\n') : msg)
    },
  })

  if (!canConfigure) {
    return (
      <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <CardContent className="py-10 text-center text-muted-foreground">
          Chỉ super admin mới quản lý được khoá API cho bên thứ 3.
        </CardContent>
      </Card>
    )
  }

  const selectedScopes = (watch('scopes') ?? []) as ScopeValue[]

  function toggleScope(scope: ScopeValue, checked: boolean) {
    const next = checked
      ? Array.from(new Set<ScopeValue>([...selectedScopes, scope]))
      : selectedScopes.filter((s) => s !== scope)
    setValue('scopes', next, { shouldValidate: true })
  }

  function ownerName(id: number): string {
    const u = users.find((x) => x.id === id)
    return u ? `${u.full_name} (${u.email})` : `User #${id}`
  }

  function copyToClipboard(value: string) {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        // ok
      })
      .catch(() => {
        alert('Không copy được — chọn và copy thủ công')
      })
  }

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-app-primary-ink)]" />
            <div>
              <p>
                Cấp <strong>khoá API</strong> để bên thứ 3 (landing page, đối tác…)
                đăng nhập hoặc tạo khách hàng mà không cần tài khoản
                nội bộ.
              </p>
              <p className="mt-1">
                Hệ thống <strong>chỉ hiển thị khoá gốc 1 lần duy nhất</strong> khi
                tạo / xoay.
              </p>
            </div>
          </div>
          <SettingsSectionActions>
            <Button className={MOBILE_FAB_CLASS} onClick={() => setDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Tạo khoá mới
            </Button>
          </SettingsSectionActions>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="py-8 text-center text-muted-foreground">
          Đang tải danh sách khoá…
        </p>
      ) : keys.length === 0 ? (
        <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
          <CardContent className="py-10 text-center text-muted-foreground">
            Chưa có khoá API nào. Bấm “Tạo khoá mới” để cấp cho đối tác đầu tiên.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {keys.map((k) => {
            const revoked = !!k.revoked_at
            const expired = k.expires_at
              ? new Date(k.expires_at).getTime() < Date.now()
              : false
            return (
              <Card
                key={k.id}
                className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]"
              >
                <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]">
                      <KeyRound className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base font-semibold">
                        {k.name}
                      </CardTitle>
                      <p className="font-mono text-xs text-muted-foreground">
                        {k.prefix}•••••••
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {revoked ? (
                      <Badge className="bg-red-50 text-red-600">Đã thu hồi</Badge>
                    ) : expired ? (
                      <Badge className="bg-orange-50 text-orange-600">
                        Đã hết hạn
                      </Badge>
                    ) : (
                      <Badge className="bg-green-50 text-green-600">Hoạt động</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex flex-wrap gap-1.5">
                    {k.scopes.map((scope) => (
                      <Badge
                        key={scope}
                        variant="secondary"
                        className="bg-blue-50 text-blue-700"
                      >
                        {scope}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                    <span>Gán cho</span>
                    <span className="min-w-0 break-words text-right font-medium text-foreground">
                      {ownerName(k.owner_user_id)}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                    <span>Tạo lúc</span>
                    <span>{formatDate(k.created_at)}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                    <span>Dùng gần nhất</span>
                    <span className="min-w-0 break-words text-right">
                      {formatDate(k.last_used_at)}
                      {k.last_used_ip ? ` • ${k.last_used_ip}` : ''}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                    <span>Hết hạn</span>
                    <span>{formatDate(k.expires_at)}</span>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2 pt-2 max-sm:hidden">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9"
                      disabled={revoked || rotateMutation.isPending}
                      onClick={() => setPending({ kind: 'rotate', key: k })}
                    >
                      <RefreshCw className="mr-1 h-3.5 w-3.5" /> Xoay khoá
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-9"
                      disabled={revoked || revokeMutation.isPending}
                      onClick={() => setPending({ kind: 'revoke', key: k })}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> Thu hồi
                    </Button>
                  </div>
                  <div className="flex justify-end pt-1 sm:hidden">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon" aria-label="Thao tác khác" />}
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem
                          className="gap-2"
                          disabled={revoked || rotateMutation.isPending}
                          onClick={() => setPending({ kind: 'rotate', key: k })}
                        >
                          <RefreshCw className="size-4" /> Xoay khoá
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          className="gap-2"
                          disabled={revoked || revokeMutation.isPending}
                          onClick={() => setPending({ kind: 'revoke', key: k })}
                        >
                          <Trash2 className="size-4" /> Thu hồi
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tạo khoá API mới</DialogTitle>
            <DialogDescription>
              Khoá gốc chỉ hiển thị 1 lần duy nhất sau khi tạo. Ghi lại + lưu bảo mật
              ngay; mất khoá phải Xoay khoá để sinh mới.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={handleSubmit((data) => createMutation.mutate(data))}
            className="space-y-4"
          >
            <div className="space-y-1">
              <Label>Tên khoá</Label>
              <Input
                {...register('name')}
                placeholder="Landing page Trinity, Đối tác ABC…"
                className="h-11"
              />
              {errors.name && (
                <p className="text-xs text-red-500">{errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Phạm vi cho phép</Label>
              <div className="space-y-2 rounded-xl border p-3">
                {SCOPES.map((s) => {
                  const checked = selectedScopes.includes(s.value)
                  return (
                    <label
                      key={s.value}
                      className="flex cursor-pointer items-start gap-3 max-sm:min-h-11"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggleScope(s.value, v === true)}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="text-sm font-medium">{s.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {s.description}
                        </p>
                      </div>
                    </label>
                  )
                })}
              </div>
              {errors.scopes && (
                <p className="text-xs text-red-500">
                  {errors.scopes.message as string}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Chủ khoá (owner) — quyết định phạm vi của khoá</Label>
              <InlineSelect<number>
                searchable
                options={users.map((u) => ({ value: u.id, label: u.full_name, description: u.email }))}
                value={watch('owner_user_id') ?? null}
                onChange={(v) =>
                  setValue('owner_user_id', v as number, { shouldValidate: true })
                }
                placeholder="-- Chọn user --"
                ariaLabel="Chủ khoá"
              />
              {errors.owner_user_id && (
                <p className="text-xs text-red-500">
                  {errors.owner_user_id.message}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Hết hạn (tuỳ chọn)</Label>
              <VnDateTimeInput
                value={watch('expires_at')}
                onChange={(v) => setValue('expires_at', v, { shouldValidate: true })}
                ariaLabel="Hết hạn"
              />
              <p className="text-xs text-muted-foreground">
                Bỏ trống = không hết hạn. Nên đặt hạn 6-12 tháng để rotate định kỳ.
              </p>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => setDialogOpen(false)}
              >
                Huỷ
              </Button>
              <Button
                type="submit"
                className="h-11"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? 'Đang tạo…' : 'Tạo khoá'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!revealed}
        onOpenChange={(v) => (v ? null : setRevealed(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="h-5 w-5" /> Lưu khoá ngay
            </DialogTitle>
            <DialogDescription>
              Đây là lần duy nhất khoá gốc hiển thị. Sau khi đóng cửa sổ này, không
              cách nào xem lại — mất khoá phải bấm Xoay để sinh key mới.
            </DialogDescription>
          </DialogHeader>

          {revealed && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Khoá API ({revealed.name})</Label>
                <div className="flex items-center gap-2 rounded-xl border bg-muted/30 p-3 max-sm:flex-col max-sm:items-stretch">
                  <code className="flex-1 break-all font-mono text-xs">
                    {revealed.plain_key}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 max-sm:h-11 max-sm:w-full"
                    onClick={() => copyToClipboard(revealed.plain_key)}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" /> Copy
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Dùng khoá bằng cách gửi header{' '}
                <code className="font-mono text-[var(--color-app-primary-ink)]">X-API-Key: {revealed.prefix}…</code>.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button className="h-11" onClick={() => setRevealed(null)}>
              Tôi đã lưu khoá
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        tone={pending?.kind === 'revoke' ? 'destructive' : 'default'}
        title={pending?.kind === 'revoke' ? 'Thu hồi khoá API' : 'Xoay khoá API'}
        description={
          pending?.kind === 'revoke'
            ? `Thu hồi khoá "${pending.key.name}"? Mọi request sau đó sẽ trả 401.`
            : `Xoay khoá "${pending?.key.name ?? ''}"? Khoá hiện tại sẽ vô hiệu ngay lập tức — bên thứ 3 phải cập nhật khoá mới.`
        }
        confirmLabel={pending?.kind === 'revoke' ? 'Thu hồi khoá' : 'Xoay khoá'}
        pending={rotateMutation.isPending || revokeMutation.isPending}
        onConfirm={() => {
          if (!pending) return
          const m = pending.kind === 'revoke' ? revokeMutation : rotateMutation
          m.mutate(pending.key.id, { onSettled: () => setPending(null) })
        }}
      />
    </div>
  )
}
