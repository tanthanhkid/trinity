'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Check, KeyRound, Loader2, Mail } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { getAccount, removeAccountPassword, setAccountPassword, startGoogleLink, unlinkGoogle } from '@/lib/auth-api'
import { errorMessage } from '@/lib/error-messages'
import { ProfilePasswordSection } from './profile-password-section'
import { GoogleMark } from '@/components/auth/google-mark'

const ACCOUNT_KEY = ['auth', 'account'] as const
/** Google trả về đúng mục này của Cài đặt sau khi liên kết. */
const RETURN_PATH = '/settings?tab=profile'

const setSchema = z
  .object({
    newPassword: z.string().min(8, 'Mật khẩu tối thiểu 8 ký tự').max(200),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Hai mật khẩu chưa giống nhau' })
type SetValues = z.infer<typeof setSchema>

/** Kết quả liên kết Google trên URL (`?google=linked|cancelled`, `?google_error=…`). */
function readGoogleResult(): { ok: boolean; text: string } | null {
  if (typeof window === 'undefined') return null
  const q = new URLSearchParams(window.location.search)
  if (q.get('google') === 'linked') return { ok: true, text: 'Đã liên kết tài khoản Google.' }
  if (q.get('google') === 'cancelled') return { ok: false, text: 'Bạn đã huỷ liên kết Google.' }
  const err = q.get('google_error')
  return err ? { ok: false, text: err } : null
}

/**
 * Cài đặt › Hồ sơ › Cách đăng nhập (#675): mã qua email (theo cấu hình máy chủ), liên kết/gỡ Google, mật khẩu tuỳ chọn
 * (đặt khi chưa có, đổi/bỏ khi đã có). Máy chủ không cho bỏ đường đăng nhập cuối cùng. Máy chủ cũ chưa có `/auth/account`
 * ⇒ chỉ hiện khối đổi mật khẩu như trước.
 */
export function ProfileLoginMethodsSection({ email }: { email: string }) {
  const queryClient = useQueryClient()
  const account = useQuery({ queryKey: ACCOUNT_KEY, queryFn: getAccount, retry: false })
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(readGoogleResult)
  const [linking, setLinking] = useState(false)
  const [unlinkOpen, setUnlinkOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [current, setCurrent] = useState('')
  const form = useForm<SetValues>({ resolver: zodResolver(setSchema), defaultValues: { newPassword: '', confirm: '' } })

  if (account.isError) return <ProfilePasswordSection />
  if (!account.data) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Đang tải cách đăng nhập...
        </div>
      </Card>
    )
  }
  const a = account.data
  const google = a.identities.find((i) => i.provider === 'google')
  const refresh = () => queryClient.invalidateQueries({ queryKey: ACCOUNT_KEY })

  async function link() {
    setLinking(true)
    setNotice(null)
    try {
      window.location.assign(await startGoogleLink(RETURN_PATH))
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err, 'Chưa mở được trang Google') })
      setLinking(false)
    }
  }

  async function doUnlink() {
    setPending(true)
    try {
      const r = await unlinkGoogle()
      setNotice({ ok: true, text: r.message })
      setUnlinkOpen(false)
      await refresh()
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err, 'Chưa gỡ được liên kết Google') })
      setUnlinkOpen(false)
    } finally {
      setPending(false)
    }
  }

  async function doSet(values: SetValues) {
    setNotice(null)
    try {
      const r = await setAccountPassword({ new_password: values.newPassword })
      setNotice({ ok: true, text: r.message })
      form.reset()
      await refresh()
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err, 'Chưa đặt được mật khẩu') })
    }
  }

  async function doRemove() {
    setPending(true)
    try {
      const r = await removeAccountPassword(current)
      setNotice({ ok: true, text: r.message })
      setRemoveOpen(false)
      setCurrent('')
      await refresh()
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err, 'Chưa bỏ được mật khẩu') })
      setRemoveOpen(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Card className="p-6">
        <h2 className="mb-1 text-lg font-semibold">Cách đăng nhập</h2>
        <p className="mb-4 text-sm text-muted-foreground">Chọn những cách bạn dùng để vào Trinity.</p>

        {notice && (
          <div
            role={notice.ok ? 'status' : 'alert'}
            className={notice.ok ? 'mb-4 flex items-center gap-2 text-sm text-green-700' : 'mb-4 text-sm text-destructive'}
          >
            {notice.ok && <Check className="size-4" aria-hidden />}
            {notice.text}
          </div>
        )}

        <ul className="divide-y">
          {a.email_login_enabled && (
            <li className="flex items-center gap-3 py-3">
              <Mail className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Mã qua email</p>
                <p className="truncate text-sm text-muted-foreground">Nhận mã đăng nhập tại {email}</p>
              </div>
              <span className="text-sm text-muted-foreground">Đang bật</span>
            </li>
          )}

          {(a.google_enabled || google) && (
            <li className="flex flex-wrap items-center gap-3 py-3">
              <GoogleMark size={20} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Google</p>
                <p className="truncate text-sm text-muted-foreground">
                  {google ? `Đã liên kết${google.email ? ` · ${google.email}` : ''}` : 'Chưa liên kết'}
                </p>
              </div>
              {google ? (
                <Button variant="outline" className="max-sm:h-11" onClick={() => setUnlinkOpen(true)}>
                  Gỡ liên kết
                </Button>
              ) : (
                <Button variant="outline" className="max-sm:h-11" disabled={linking} onClick={() => void link()}>
                  {linking && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
                  Liên kết Google
                </Button>
              )}
            </li>
          )}

          <li className="flex flex-wrap items-center gap-3 py-3">
            <KeyRound className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Mật khẩu</p>
              <p className="text-sm text-muted-foreground">
                {a.has_password ? 'Đã đặt mật khẩu' : 'Chưa đặt — không bắt buộc'}
                {!a.password_login_enabled && ' · bản cài đặt này đang tắt đăng nhập bằng mật khẩu'}
              </p>
            </div>
            {a.has_password && (
              <Button variant="outline" className="max-sm:h-11" onClick={() => setRemoveOpen(true)}>
                Bỏ mật khẩu
              </Button>
            )}
          </li>
        </ul>

        {!a.has_password && (
          <form onSubmit={form.handleSubmit(doSet)} className="mt-4 space-y-4" method="post">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setNewPassword">Đặt mật khẩu (tuỳ chọn)</Label>
              <Input id="setNewPassword" type="password" autoComplete="new-password" placeholder="Tối thiểu 8 ký tự" className="max-sm:h-11" {...form.register('newPassword')} />
              {form.formState.errors.newPassword && <p className="text-sm text-destructive">{form.formState.errors.newPassword.message}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setConfirm">Nhập lại mật khẩu</Label>
              <Input id="setConfirm" type="password" autoComplete="new-password" className="max-sm:h-11" {...form.register('confirm')} />
              {form.formState.errors.confirm && <p className="text-sm text-destructive">{form.formState.errors.confirm.message}</p>}
            </div>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
              Đặt mật khẩu
            </Button>
          </form>
        )}
      </Card>

      {a.has_password && <ProfilePasswordSection />}

      <ConfirmDialog
        open={unlinkOpen}
        onOpenChange={setUnlinkOpen}
        title="Gỡ liên kết Google?"
        description="Sau khi gỡ, bạn không đăng nhập bằng Google được nữa cho tới khi liên kết lại."
        confirmLabel="Gỡ liên kết"
        tone="destructive"
        pending={pending}
        onConfirm={doUnlink}
      />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={(o) => {
          setRemoveOpen(o)
          if (!o) setCurrent('')
        }}
        title="Bỏ mật khẩu?"
        description={
          <span className="flex flex-col gap-3">
            <span>Bạn sẽ đăng nhập bằng mã qua email hoặc Google. Nhập mật khẩu hiện tại để xác nhận.</span>
            <Input
              type="password"
              autoComplete="current-password"
              aria-label="Mật khẩu hiện tại"
              placeholder="Mật khẩu hiện tại"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </span>
        }
        confirmLabel="Bỏ mật khẩu"
        tone="destructive"
        pending={pending || current.length === 0}
        onConfirm={doRemove}
      />
    </>
  )
}

