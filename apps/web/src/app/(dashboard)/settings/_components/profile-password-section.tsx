'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import axios from 'axios'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Loader2,
  KeyRound,
  Copy,
  Check,
  Eye,
  EyeOff,
} from 'lucide-react'
import { useChangePassword, useResetMyPassword } from '@/hooks/use-profile'

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Vui lòng nhập mật khẩu hiện tại'),
    newPassword: z.string().min(8, 'Mật khẩu mới tối thiểu 8 ký tự'),
    confirmPassword: z.string().min(1, 'Vui lòng nhập lại mật khẩu mới'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Mật khẩu xác nhận không khớp',
    path: ['confirmPassword'],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: 'Mật khẩu mới phải khác mật khẩu hiện tại',
    path: ['newPassword'],
  })

type ChangePasswordForm = z.infer<typeof changePasswordSchema>

function extractErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string | string[] } | undefined
    const raw = data?.message
    if (Array.isArray(raw)) return raw.join(', ')
    if (typeof raw === 'string' && raw.length > 0) return raw
  }
  return fallback
}

export function ProfilePasswordSection() {
  const changePassword = useChangePassword()
  const resetPassword = useResetMyPassword()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [resetCurrent, setResetCurrent] = useState('')
  const [copied, setCopied] = useState(false)
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [resetErrorMsg, setResetErrorMsg] = useState<string | null>(null)

  const form = useForm<ChangePasswordForm>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  })

  const onSubmit = async (data: ChangePasswordForm) => {
    setSuccessMsg(null)
    setErrorMsg(null)
    try {
      const res = await changePassword.mutateAsync({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      })
      setSuccessMsg(res.message || 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại.')
      form.reset()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err, 'Đổi mật khẩu thất bại, vui lòng thử lại'))
    }
  }

  const handleReset = async () => {
    setConfirmOpen(false)
    setResetErrorMsg(null)
    try {
      const result = await resetPassword.mutateAsync(resetCurrent)
      setResetCurrent('')
      setNewPassword(result.newPassword)
      setResultOpen(true)
    } catch (err) {
      setResetErrorMsg(extractErrorMessage(err, 'Reset mật khẩu thất bại, vui lòng thử lại'))
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(newPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard API không khả dụng — user có thể chọn text thủ công từ ô trên
    }
  }

  return (
    <>
      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-2">Đổi mật khẩu</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Nhập mật khẩu hiện tại để xác minh, sau đó đặt mật khẩu mới (tối thiểu 8 ký tự).
          Bạn sẽ cần đăng nhập lại sau khi đổi.
        </p>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="currentPassword">Mật khẩu hiện tại</Label>
            <div className="relative">
              <Input
                id="currentPassword"
                type={showCurrent ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Nhập mật khẩu hiện tại"
                className="pr-10 max-sm:h-11 max-sm:pr-12"
                {...form.register('currentPassword')}
              />
              <button
                type="button"
                onClick={() => setShowCurrent((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 after:absolute after:-inset-1.5 after:content-[''] pointer-coarse:sm:after:-inset-[14px] text-muted-foreground hover:text-foreground max-sm:right-0 max-sm:flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-center"
                aria-label={showCurrent ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              >
                {showCurrent ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {form.formState.errors.currentPassword && (
              <p className="text-sm text-destructive">
                {form.formState.errors.currentPassword.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="newPassword">Mật khẩu mới</Label>
            <div className="relative">
              <Input
                id="newPassword"
                type={showNew ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Tối thiểu 8 ký tự"
                className="pr-10 max-sm:h-11 max-sm:pr-12"
                {...form.register('newPassword')}
              />
              <button
                type="button"
                onClick={() => setShowNew((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 after:absolute after:-inset-1.5 after:content-[''] pointer-coarse:sm:after:-inset-[14px] text-muted-foreground hover:text-foreground max-sm:right-0 max-sm:flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-center"
                aria-label={showNew ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              >
                {showNew ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {form.formState.errors.newPassword && (
              <p className="text-sm text-destructive">
                {form.formState.errors.newPassword.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirmPassword">Xác nhận mật khẩu mới</Label>
            <div className="relative">
              <Input
                id="confirmPassword"
                type={showConfirm ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Nhập lại mật khẩu mới"
                className="pr-10 max-sm:h-11 max-sm:pr-12"
                {...form.register('confirmPassword')}
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 after:absolute after:-inset-1.5 after:content-[''] pointer-coarse:sm:after:-inset-[14px] text-muted-foreground hover:text-foreground max-sm:right-0 max-sm:flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-center"
                aria-label={showConfirm ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              >
                {showConfirm ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {form.formState.errors.confirmPassword && (
              <p className="text-sm text-destructive">
                {form.formState.errors.confirmPassword.message}
              </p>
            )}
          </div>

          {successMsg && (
            <div className="flex items-center gap-2 text-sm text-green-600">
              <Check className="size-4" />
              {successMsg}
            </div>
          )}
          {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}

          <Button
            type="submit"
            variant="outline"
            disabled={changePassword.isPending}
          >
            {changePassword.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
            Đổi mật khẩu
          </Button>
        </form>

        <Separator className="my-6" />

        <h3 className="text-base font-semibold mb-2">Tạo mật khẩu ngẫu nhiên</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Tạo mật khẩu mới ngẫu nhiên (cần nhập mật khẩu hiện tại để xác nhận). Nếu đã quên mật khẩu, nhờ quản trị viên đặt lại. Bạn sẽ cần đăng nhập lại sau khi reset.
        </p>
        <Button
          variant="outline"
          onClick={() => setConfirmOpen(true)}
          disabled={resetPassword.isPending}
        >
          {resetPassword.isPending ? (
            <Loader2 className="size-4 mr-2 animate-spin" />
          ) : (
            <KeyRound className="size-4 mr-2" />
          )}
          Reset mật khẩu
        </Button>
        {resetErrorMsg && (
          <p className="text-sm text-destructive mt-2">{resetErrorMsg}</p>
        )}
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Xác nhận reset mật khẩu</DialogTitle>
            <DialogDescription>
              Mật khẩu hiện tại sẽ bị thay thế bằng mật khẩu mới ngẫu nhiên.
              Bạn sẽ cần đăng nhập lại sau khi reset.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="resetCurrentPassword">Mật khẩu hiện tại</Label>
            <Input
              id="resetCurrentPassword"
              type="password"
              autoComplete="current-password"
              value={resetCurrent}
              onChange={(e) => setResetCurrent(e.target.value)}
              placeholder="Nhập mật khẩu hiện tại để xác nhận"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Huỷ
            </Button>
            <Button onClick={handleReset} disabled={!resetCurrent}>
              Xác nhận reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resultOpen} onOpenChange={setResultOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mật khẩu mới</DialogTitle>
            <DialogDescription>
              Hãy lưu lại mật khẩu mới trước khi đóng. Bạn sẽ cần dùng mật
              khẩu này để đăng nhập lại.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input
              value={newPassword}
              readOnly
              className="font-mono text-base"
            />
            <Button variant="outline" size="icon" onClick={handleCopy}>
              {copied ? (
                <Check className="size-4 text-green-600" />
              ) : (
                <Copy className="size-4" />
              )}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setResultOpen(false)}>Đã lưu, đóng</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
