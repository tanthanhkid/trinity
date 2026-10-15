'use client'

import { useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Camera, Loader2 } from 'lucide-react'
import { useUploadAvatar } from '@/hooks/use-profile'
import { useRoleNames } from '@/lib/rbac'
import {
  getUserAriaLabel,
  getUserDisplayName,
  getUserEmail,
  getUserEmailTooltip,
} from '@/lib/user-identity'
import type { User } from '@/types/auth'

function getInitials(name: string): string {
  return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
}

interface ProfileAvatarSectionProps {
  user: User
  onMessage: (msg: string) => void
}

export function ProfileAvatarSection({ user, onMessage }: ProfileAvatarSectionProps) {
  const uploadAvatar = useUploadAvatar()
  const roleNames = useRoleNames()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const userDisplayName = getUserDisplayName(user)
  const userEmail = getUserEmail(user)
  const userEmailTooltip = getUserEmailTooltip(user)

  const handleAvatarClick = () => fileInputRef.current?.click()

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      onMessage('Chỉ chấp nhận ảnh JPG, PNG, WebP')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      onMessage('Ảnh tối đa 5MB')
      return
    }

    const reader = new FileReader()
    reader.onload = (ev) => setAvatarPreview(ev.target?.result as string)
    reader.readAsDataURL(file)

    try {
      const result = await uploadAvatar.mutateAsync(file)
      onMessage(result.message)
    } catch {
      setAvatarPreview(null)
      onMessage('Upload ảnh thất bại, vui lòng thử lại')
    }
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-4">Ảnh đại diện</h2>
      <div className="flex items-center gap-6 max-sm:gap-4">
        <div className="relative group">
          <Avatar className="!size-24">
            <AvatarImage src={avatarPreview ?? user.avatar_url ?? undefined} alt={userDisplayName} />
            <AvatarFallback className="text-2xl">{getInitials(userDisplayName)}</AvatarFallback>
          </Avatar>
          <button
            type="button"
            onClick={handleAvatarClick}
            disabled={uploadAvatar.isPending}
            aria-label="Đổi ảnh đại diện"
            className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            {uploadAvatar.isPending ? (
              <Loader2 className="size-6 text-white animate-spin" />
            ) : (
              <Camera className="size-6 text-white" />
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleAvatarChange}
            className="hidden"
          />
        </div>
        <div>
          <p
            className="font-medium"
            title={userEmailTooltip}
            aria-label={getUserAriaLabel(user)}
          >
            {userDisplayName}
          </p>
          <p className="text-sm text-muted-foreground">{userEmail ?? '—'}</p>
          {roleNames && <p className="text-sm text-muted-foreground">{roleNames}</p>}
          <Button variant="outline" size="sm" className="mt-2" onClick={handleAvatarClick} disabled={uploadAvatar.isPending}>
            Thay đổi ảnh
          </Button>
        </div>
      </div>
    </Card>
  )
}
