'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Heart,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Save,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { MobileActionBar } from '@/components/app-shell/mobile-action-bar'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { RichTextEditor } from '@/components/ui/rich-text-editor'
import { RichTextContent } from '@/components/ui/rich-text-content'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import apiClient from '@/lib/api-client'
import { useAuthStore } from '@/store/auth'
import { usePermissions } from '@/lib/rbac'
import { formatDate } from '@/lib/format'
import {
  CATEGORY_BADGE,
  CATEGORY_LABEL,
  type NewsfeedPost,
} from './types'
import { PostComments } from './post-comments'
import { PostImageGallery } from './post-image-gallery'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'vừa xong'
  if (m < 60) return `${m} phút trước`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} giờ trước`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} ngày trước`
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

export function PostCard({
  post,
  highlight = false,
}: {
  post: NewsfeedPost
  highlight?: boolean
}) {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const canModerate = usePermissions().can('newsfeed.moderate')
  const [showComments, setShowComments] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [editContent, setEditContent] = useState(post.content)
  // Khi mở bài từ thông báo (?post=<id>) → cuộn tới + làm nổi bài trong ~2.5s.
  const [highlighted, setHighlighted] = useState(false)

  useEffect(() => {
    if (!highlight) return
    document
      .getElementById(`newsfeed-post-${post.id}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlighted(true)
    const t = setTimeout(() => setHighlighted(false), 2500)
    return () => clearTimeout(t)
  }, [highlight, post.id])

  const isOwner = me?.id === post.author_id
  const canEdit = isOwner || canModerate
  const canDelete = isOwner || canModerate

  const likeMutation = useMutation({
    mutationFn: async () => {
      await apiClient.post(`/newsfeed/${post.id}/like`)
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['newsfeed', 'posts'] }),
    onError: () => toast.error('Không thực hiện được'),
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiClient.delete(`/newsfeed/${post.id}`)
    },
    onSuccess: () => {
      toast.success('Đã xoá bài đăng')
      setConfirmingDelete(false)
      qc.invalidateQueries({ queryKey: ['newsfeed', 'posts'] })
    },
    onError: () => toast.error('Không xoá được bài đăng'),
  })

  const editMutation = useMutation({
    mutationFn: async () => {
      await apiClient.patch(`/newsfeed/${post.id}`, { content: editContent })
    },
    onSuccess: () => {
      toast.success('Đã cập nhật')
      setEditing(false)
      qc.invalidateQueries({ queryKey: ['newsfeed', 'posts'] })
    },
    onError: () => toast.error('Không lưu được'),
  })

  return (
    <Card
      id={`newsfeed-post-${post.id}`}
      className={`scroll-mt-24 rounded-2xl transition-shadow ${
        highlighted ? 'ring-2 ring-[var(--color-app-primary)] ring-offset-2' : ''
      }`}
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between">
          <div className="flex gap-3">
            <Avatar>
              <AvatarFallback>{avatarText(post.author.full_name)}</AvatarFallback>
            </Avatar>
            <div>
              <div className="font-semibold">{post.author.full_name}</div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge className={CATEGORY_BADGE[post.category]}>
                  {CATEGORY_LABEL[post.category]}
                </Badge>
                <span>{timeAgo(post.created_at)}</span>
                {post.edited_at && <span>(đã sửa)</span>}
              </div>
            </div>
          </div>
          {(canEdit || canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon" aria-label="Thao tác bài đăng" />}
              >
                <MoreHorizontal className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit && (
                  <DropdownMenuItem onClick={() => setEditing(true)}>
                    <Pencil className="size-4" /> Sửa bài
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <Trash2 className="size-4" /> Xoá bài
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {editing ? (
          <div className="space-y-2">
            <RichTextEditor
              value={editContent}
              onChange={setEditContent}
              placeholder="Nội dung bài đăng..."
              className="min-h-[140px]"
              contentClassName="min-h-[110px]"
            />
            <MobileActionBar>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(false)
                  setEditContent(post.content)
                }}
              >
                Huỷ
              </Button>
              <Button
                variant="outline"
                disabled={
                  editMutation.isPending ||
                  editContent.replace(/<[^>]*>/g, '').trim() === ''
                }
                onClick={() => editMutation.mutate()}
              >
                {editMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Lưu thay đổi
              </Button>
            </MobileActionBar>
          </div>
        ) : (
          post.content && <RichTextContent html={post.content} />
        )}

        {!editing && <PostImageGallery post={post} />}

        <div className="flex items-center justify-between border-t pt-2 text-sm">
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors hover:bg-muted max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center ${
              post.liked_by_me ? 'text-rose-600' : 'text-muted-foreground'
            }`}
            onClick={() => likeMutation.mutate()}
            disabled={likeMutation.isPending}
          >
            <Heart
              className={`size-4 ${post.liked_by_me ? 'fill-current' : ''}`}
            />
            <span>{post._count.likes}</span>
            <span className="hidden sm:inline">Thích</span>
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-muted max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center"
            onClick={() => setShowComments((s) => !s)}
          >
            <MessageCircle className="size-4" />
            <span>{post._count.comments}</span>
            <span className="hidden sm:inline">Bình luận</span>
          </button>
        </div>

        {showComments && (
          <PostComments postId={post.id} />
        )}
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title="Xoá bài đăng này?"
          description="Bài đăng sẽ bị xoá khỏi bảng tin."
          confirmLabel="Xoá bài"
          cancelLabel="Huỷ"
          tone="destructive"
          pending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate()}
        />
      </CardContent>
    </Card>
  )
}
