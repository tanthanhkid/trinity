'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Loader2, Check } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { useUpdateProfile } from '@/hooks/use-profile'
import { SettingsSectionActions } from './settings-section-header'
import { ProfileAvatarSection } from './profile-avatar-section'
import { ProfilePasswordSection } from './profile-password-section'

const profileSchema = z.object({
  full_name: z.string().min(2, 'Họ tên tối thiểu 2 ký tự').max(100, 'Họ tên tối đa 100 ký tự'),
  phone: z.string().regex(/^(0|\+84)\d{9}$/, 'Số điện thoại không hợp lệ (VD: 0900000001)').or(z.literal('')).optional(),
})
type ProfileForm = z.infer<typeof profileSchema>

export function SettingsProfile() {
  const { user } = useAuth()
  const updateProfile = useUpdateProfile()
  const [profileMsg, setProfileMsg] = useState<string | null>(null)

  const profileForm = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    values: { full_name: user?.full_name ?? '', phone: user?.phone ?? '' },
  })

  const onProfileSubmit = async (data: ProfileForm) => {
    setProfileMsg(null)
    try {
      const payload: Record<string, string> = {}
      if (data.full_name !== user?.full_name) payload.full_name = data.full_name
      if (data.phone && data.phone !== (user?.phone ?? '')) payload.phone = data.phone
      if (Object.keys(payload).length === 0) {
        setProfileMsg('Không có thông tin cần cập nhật')
        return
      }
      const result = await updateProfile.mutateAsync(payload)
      setProfileMsg(result.message)
    } catch {
      setProfileMsg('Có lỗi xảy ra, vui lòng thử lại')
    }
  }

  if (!user) return null

  return (
    <div className="max-w-2xl space-y-6">
      <ProfileAvatarSection user={user} onMessage={setProfileMsg} />

      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-4">Thông tin cá nhân</h2>
        <form onSubmit={profileForm.handleSubmit(onProfileSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={user.email} disabled className="bg-muted max-sm:h-11" />
            <p className="text-xs text-muted-foreground">Email không thể thay đổi</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="full_name">Họ và tên</Label>
            <Input id="full_name" placeholder="Nhập họ và tên" className="max-sm:h-11" {...profileForm.register('full_name')} />
            {profileForm.formState.errors.full_name && (
              <p className="text-sm text-destructive">{profileForm.formState.errors.full_name.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Số điện thoại</Label>
            <Input id="phone" placeholder="0900000001" className="max-sm:h-11" {...profileForm.register('phone')} />
            {profileForm.formState.errors.phone && (
              <p className="text-sm text-destructive">{profileForm.formState.errors.phone.message}</p>
            )}
          </div>
          {profileMsg && (
            <div className="flex items-center gap-2 text-sm text-green-600">
              <Check className="size-4" />
              {profileMsg}
            </div>
          )}
          <SettingsSectionActions mobile="bar">
            <Button
              type="button"
              disabled={updateProfile.isPending}
              onClick={profileForm.handleSubmit(onProfileSubmit)}
            >
              {updateProfile.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
              Lưu thay đổi
            </Button>
          </SettingsSectionActions>
        </form>
      </Card>

      <Separator />
      <ProfilePasswordSection />
    </div>
  )
}
