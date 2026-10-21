'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import apiClient from '@/lib/api-client'
import { useAuthStore } from '@/store/auth'
import { formatDate } from '@/lib/format'
import type { NewsfeedComment } from './types'
import { usePermissions } from '@/lib/rbac'
import { errorMessage } from '@/lib/error-messages'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'vừa xong'
  if (m < 60) return `${m} phút`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} giờ`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} ngày`
  return formatDate(new Date(iso))
}

function avatarText(name?: string | null): string {
  if (!name) return '?'
  return name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function PostComments({ postId }: { postId: number }) {
  const canModerate = usePermissions().can('newsfeed.moderate')
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const [draft, setDraft] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['newsfeed', 'comments', postId],
    queryFn: async (): Promise<{ data: NewsfeedComment[] }> => {
      const res = await apiClient.get(`/newsfeed/${postId}/comments`)
      return res.data
    },
  })

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post(`/newsfeed/${postId}/comments`, {
        content: draft,
      })
      return res.data
    },
    onSuccess: () => {
      setDraft('')
      qc.invalidateQueries({ queryKey: ['newsfeed', 'comments', postId] })
      qc.invalidateQueries({ queryKey: ['newsfeed', 'posts'] })
    },
    onError: (err) => toast.error(errorMessage(err, 'Không gửi được bình luận')),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/newsfeed/comments/${id}`)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['newsfeed', 'comments', postId] })
      qc.invalidateQueries({ queryKey: ['newsfeed', 'posts'] })
    },
    onError: (err) => toast.error(errorMessage(err, 'Không xoá được bình luận')),
  })

  return (
    <div className="space-y-3 border-t pt-3">
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Đang tải bình luận...</div>
      ) : (
        <div className="space-y-2">
          {data?.data.map((c) => {
            const canDelete =
              c.user_id === me?.id || canModerate
            return (
              <div key={c.id} className="flex gap-2">
                <Avatar className="size-8">
                  <AvatarFallback className="text-xs">
                    {avatarText(c.user.full_name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <div className="rounded-2xl bg-muted px-3 py-2">
                    <div className="text-xs font-semibold">
                      {c.user.full_name}
                    </div>
                    <div className="whitespace-pre-wrap text-sm">
                      {c.content}
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-2 px-2 text-xs text-muted-foreground">
                    <span>{timeAgo(c.created_at)}</span>
                    {canDelete && (
                      <button
                        type="button"
                        className="text-rose-600 hover:underline max-sm:min-h-11 max-sm:px-2"
                        onClick={() => deleteMutation.mutate(c.id)}
                      >
                        <Trash2 className="inline size-3" /> Xoá
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          {data?.data.length === 0 && (
            <div className="text-sm text-muted-foreground">
              Chưa có bình luận nào.
            </div>
          )}
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!draft.trim()) return
          addMutation.mutate()
        }}
      >
        <Input
          placeholder="Viết bình luận..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          aria-label="Gửi bình luận"
          disabled={addMutation.isPending || !draft.trim()}
        >
          {addMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </form>
    </div>
  )
}
