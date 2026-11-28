'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  ThumbsUp,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { PersonAvatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { StageChip } from '@/components/ui/stage-chip'
import { showUndoToast } from '@/components/ui/undo-toast'
import { HeroCard } from '@/components/ui/hero-card'
import {
  BottomSheet,
  BottomSheetClose,
  BottomSheetContent,
  BottomSheetTrigger,
} from '@/components/ui/bottom-sheet'
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
  CATEGORY_CHIP,
  CATEGORY_INK,
  CATEGORY_LABEL,
  type NewsfeedPost,
} from './types'
import { useIsDesktop } from './use-is-desktop'
import { PostComments } from './post-comments'
import { PostImageGallery } from './post-image-gallery'
import { errorMessage } from '@/lib/error-messages'

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

/** Thời gian chờ trước khi xoá thật — trong lúc đó toast cho Hoàn tác (UI-only, không đổi API). */
const DELETE_UNDO_MS = 5000

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
  const isDesktop = useIsDesktop()
  const [showComments, setShowComments] = useState(false)
  const [editing, setEditing] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [editContent, setEditContent] = useState(post.content)
  // Bài đang chờ xoá (ẩn tạm, còn Hoàn tác).
  const [pendingDelete, setPendingDelete] = useState(false)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const undoToastId = useRef<string | number | null>(null)
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
    onError: (err) => toast.error(errorMessage(err, 'Không thực hiện được')),
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiClient.delete(`/newsfeed/${post.id}`)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['newsfeed', 'posts'] })
    },
    onError: (err) => {
      setPendingDelete(false)
      toast.error(errorMessage(err, 'Không xoá được bài đăng'))
    },
  })

  const { mutate: runDelete } = deleteMutation
  // Rời trang khi còn đang chờ → xoá luôn, không để bài "ẩn" mà vẫn còn trên máy chủ.
  useEffect(
    () => () => {
      if (deleteTimer.current) {
        clearTimeout(deleteTimer.current)
        deleteTimer.current = null
        runDelete()
        // Bài đã xoá thật ⇒ gỡ toast, không để «Hoàn tác» còn bấm được mà không làm gì.
        if (undoToastId.current != null) toast.dismiss(undoToastId.current)
      }
    },
    [runDelete],
  )

  const startDelete = useCallback(() => {
    setConfirmingDelete(false)
    setSheetOpen(false)
    setEditing(false)
    setPendingDelete(true)
    deleteTimer.current = setTimeout(() => {
      deleteTimer.current = null
      runDelete()
    }, DELETE_UNDO_MS)
    undoToastId.current = showUndoToast('Đã xoá bài', {
      onUndo: () => {
        if (deleteTimer.current) clearTimeout(deleteTimer.current)
        deleteTimer.current = null
        setPendingDelete(false)
      },
    })
  }, [runDelete])

  const editMutation = useMutation({
    mutationFn: async () => {
      await apiClient.patch(`/newsfeed/${post.id}`, { content: editContent })
    },
    onSuccess: () => {
      toast.success('Đã lưu bài')
      setEditing(false)
      qc.invalidateQueries({ queryKey: ['newsfeed', 'posts'] })
    },
    onError: (err) => toast.error(errorMessage(err, 'Không lưu được')),
  })

  if (pendingDelete) return null

  const editEmpty = editContent.replace(/<[^>]*>/g, '').trim() === ''
  const authorName = post.author.full_name
  const chip = CATEGORY_CHIP[post.category]
  const when = timeAgo(post.created_at)
  const cancelEdit = () => {
    setEditing(false)
    setEditContent(post.content)
  }

  const menuButtonClass =
    'inline-flex size-11 items-center justify-center rounded-ax-field text-ax-ink-2 transition-colors hover:bg-ax-hover lg:size-10'

  return (
    <article
      id={`newsfeed-post-${post.id}`}
      className={`relative scroll-mt-24 transition-shadow max-sm:-mx-4 max-sm:px-4 max-lg:bg-ax-surface sm:max-lg:-mx-5 sm:max-lg:px-5 max-lg:pt-3.5 max-lg:pb-1 lg:ax-card lg:px-5 lg:pt-[18px] lg:pb-2 ${
        highlighted ? 'ring-2 ring-ax-primary ring-offset-2' : ''
      }`}
    >
      <div className="flex flex-col gap-3">
        <header className="flex items-center gap-3">
          <PersonAvatar kind="staff" size="lg" name={authorName} src={post.author.avatar_url ?? undefined} />
          <div className="flex min-w-0 flex-1 flex-col leading-snug">
            <span className="truncate text-[15px] font-semibold text-ax-ink">{authorName}</span>
            <span className="text-[13px] text-ax-ink-2">
              {when}
              {post.edited_at && <> · đã sửa</>}
              <span className={`lg:hidden ${CATEGORY_INK[post.category]} font-semibold`}>
                {' · '}
                {CATEGORY_LABEL[post.category]}
              </span>
            </span>
          </div>
          <StageChip
            size="sm"
            tone={chip.tone}
            style={chip.style}
            className="max-lg:hidden"
          >
            {CATEGORY_LABEL[post.category]}
          </StageChip>
          {(canEdit || canDelete) && (
            <>
              <div className="max-lg:hidden">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<button type="button" aria-label="Thao tác với bài" className={menuButtonClass} />}
                  >
                    <MoreHorizontal className="size-[18px]" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[170px]">
                    {canEdit && (
                      <DropdownMenuItem className="h-10" onClick={() => setEditing(true)}>
                        <Pencil className="size-4" /> Sửa bài
                      </DropdownMenuItem>
                    )}
                    {canDelete && (
                      <DropdownMenuItem
                        className="h-10"
                        variant="destructive"
                        onClick={() => setConfirmingDelete(true)}
                      >
                        <Trash2 className="size-4" /> Xoá bài
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="lg:hidden">
                <BottomSheet open={sheetOpen} onOpenChange={setSheetOpen}>
                  <BottomSheetTrigger
                    aria-label="Thao tác với bài"
                    className={menuButtonClass}
                  >
                    <MoreHorizontal className="size-5" />
                  </BottomSheetTrigger>
                  <BottomSheetContent title="Thao tác với bài" hideTitle>
                    {canEdit && (
                      <Button
                        variant="ax-secondary"
                        size="ax-lg"
                        className="h-[52px] w-full bg-ax-sunken text-[17px]"
                        onClick={() => {
                          setSheetOpen(false)
                          setEditing(true)
                        }}
                      >
                        Sửa bài
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ax-ghost"
                        size="ax-lg"
                        className="h-[52px] w-full text-[17px] text-ax-danger"
                        onClick={startDelete}
                      >
                        Xoá bài
                      </Button>
                    )}
                    <BottomSheetClose
                      className="h-12 rounded-ax-field text-base text-ax-ink-2 hover:bg-ax-hover"
                    >
                      Đóng
                    </BottomSheetClose>
                  </BottomSheetContent>
                </BottomSheet>
              </div>
            </>
          )}
        </header>

        {editing && isDesktop && (
          <div className="space-y-3">
            <RichTextEditor
              value={editContent}
              onChange={setEditContent}
              placeholder="Nội dung bài đăng..."
              className="min-h-[140px]"
              contentClassName="min-h-[110px]"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] text-ax-ink-2">Bài sẽ ghi “đã sửa” sau khi lưu.</span>
              <div className="flex gap-2">
                <Button variant="ax-ghost" size="ax" onClick={cancelEdit}>
                  Huỷ
                </Button>
                <Button
                  variant="ax-primary"
                  size="ax"
                  disabled={editMutation.isPending || editEmpty}
                  onClick={() => editMutation.mutate()}
                >
                  {editMutation.isPending && <Loader2 className="size-4 animate-spin" />}
                  Lưu thay đổi
                </Button>
              </div>
            </div>
          </div>
        )}
        {!(editing && isDesktop) && post.content && (
          <RichTextContent html={post.content} className="text-base leading-[1.55] lg:text-[15px] lg:leading-[1.6]" />
        )}

        {!(editing && isDesktop) && <PostImageGallery post={post} />}

        <div className="flex gap-1 border-t border-ax-divider py-1 max-lg:mt-0 max-lg:gap-0 max-lg:py-0">
          <button
            type="button"
            aria-pressed={post.liked_by_me}
            className={`inline-flex h-10 items-center gap-2 rounded-ax-field px-3.5 text-sm tabular-nums transition-colors hover:bg-ax-hover max-lg:h-12 max-lg:flex-1 max-lg:justify-center max-lg:rounded-none max-lg:text-[15px] ${
              post.liked_by_me ? 'font-semibold text-ax-primary-hover' : 'font-medium text-ax-ink-2'
            }`}
            onClick={() => likeMutation.mutate()}
            disabled={likeMutation.isPending}
          >
            <ThumbsUp
              className={`size-[18px] max-lg:size-5 ${post.liked_by_me ? 'fill-current' : ''}`}
              strokeWidth={1.75}
            />
            Thích<span className="max-lg:hidden"> ·</span> {post._count.likes}
          </button>
          <button
            type="button"
            aria-expanded={showComments}
            className="inline-flex h-10 items-center gap-2 rounded-ax-field px-3.5 text-sm font-medium tabular-nums text-ax-ink-2 transition-colors hover:bg-ax-hover max-lg:h-12 max-lg:flex-1 max-lg:justify-center max-lg:rounded-none max-lg:text-[15px]"
            onClick={() => setShowComments((s) => !s)}
          >
            <MessageCircle className="size-[18px] max-lg:size-5" strokeWidth={1.75} />
            Bình luận<span className="max-lg:hidden"> ·</span> {post._count.comments}
          </button>
        </div>

        {showComments && <PostComments postId={post.id} />}
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Xoá bài đăng này?"
        description="Bài sẽ biến khỏi bảng tin của mọi người. Bạn còn vài giây để hoàn tác ngay sau khi xoá."
        confirmLabel="Xoá bài"
        cancelLabel="Giữ lại"
        tone="destructive"
        onConfirm={startDelete}
      />

      {editing && !isDesktop && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Sửa bài"
          className="fixed inset-0 z-50 flex flex-col bg-ax-surface text-ax-ink"
        >
          <div className="flex items-center justify-between border-b border-ax-divider px-2 pt-2 pb-1">
            <button
              type="button"
              onClick={cancelEdit}
              className="h-11 px-3 text-base text-ax-ink-2"
            >
              Huỷ
            </button>
            <h1 className="text-[17px] font-semibold tracking-[-0.011em]">Sửa bài</h1>
            <button
              type="button"
              disabled={editMutation.isPending || editEmpty}
              onClick={() => editMutation.mutate()}
              className="h-11 px-3.5 text-base font-bold text-ax-primary-hover disabled:text-ax-ink-3"
            >
              {editMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Lưu'}
            </button>
          </div>
          <div className="flex-1 overflow-auto px-4 py-3.5">
            <HeroCard className="mb-3 flex items-center gap-3 !p-4 !rounded-[18px]">
              <PersonAvatar kind="staff" size="xl" name={authorName} src={post.author.avatar_url ?? undefined} />
              <div className="leading-snug">
                <div className="text-[17px] font-semibold tracking-[-0.011em]">{authorName}</div>
                <div className="text-[13px] text-white/95">
                  Đăng {when} · {CATEGORY_LABEL[post.category]}
                </div>
              </div>
            </HeroCard>
            <RichTextEditor
              value={editContent}
              onChange={setEditContent}
              placeholder="Nội dung bài đăng..."
              className="min-h-[200px]"
              contentClassName="min-h-[170px]"
            />
            {canDelete && (
              <Button
                variant="ax-danger"
                size="ax-lg"
                className="mt-7 w-full"
                onClick={startDelete}
              >
                Xoá bài này
              </Button>
            )}
            <p className="mt-3 text-[13px] leading-normal text-ax-ink-2">
              Lưu xong bài ghi “đã sửa”. Xoá xong còn vài giây để hoàn tác.
            </p>
          </div>
        </div>
      )}
    </article>
  )
}
