'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ImagePlus,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  ThumbsUp,
  Trash2,
  Video,
  X,
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
import { cn } from '@/lib/utils'
import {
  CATEGORY_CHIP,
  CATEGORY_INK,
  CATEGORY_LABEL,
  NEWSFEED_CATEGORIES,
  type NewsfeedCategory,
  type NewsfeedPost,
} from './types'
import {
  ACCEPT_VIDEO,
  MAX_IMAGES,
  MAX_REQUEST_BYTES,
  MAX_TOTAL_VIDEO_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEOS,
  compressImage,
  describeUploadError,
} from './post-composer'
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

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Chữ thuần của HTML bài (bỏ thẻ, giải mã entity) — để đếm ký tự và kiểm rỗng. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .trim()
}

/** Lỗi kiểm phía client khi lưu (câu tiếng Việt, hiện nguyên văn). */
class EditCheckError extends Error {}

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
  const [editCategory, setEditCategory] = useState<NewsfeedCategory>(post.category)
  // Ảnh/video thêm vào bài khi sửa (nối sau tệp đã có).
  const [newImages, setNewImages] = useState<File[]>([])
  const [newVideos, setNewVideos] = useState<File[]>([])
  const imageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
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
      const category = editCategory !== post.category ? editCategory : undefined
      // PATCH bắt buộc nội dung; bài chỉ có ảnh/video (nội dung rỗng) hoặc có tệp mới thì đi route multipart.
      if (newImages.length === 0 && newVideos.length === 0 && htmlToPlain(editContent) !== '') {
        await apiClient.patch(`/newsfeed/${post.id}`, { content: editContent, category })
        return
      }
      const videoBytes = newVideos.reduce((sum, v) => sum + v.size, 0)
      if (videoBytes > MAX_TOTAL_VIDEO_BYTES) {
        throw new EditCheckError(
          `Tổng dung lượng video vượt quá ${MAX_TOTAL_VIDEO_BYTES / (1024 * 1024)}MB — vui lòng bớt video`,
        )
      }
      const fd = new FormData()
      fd.append('content', editContent)
      if (category) fd.append('category', category)
      let requestBytes = videoBytes
      for (let i = 0; i < newImages.length; i++) {
        const blob = await compressImage(newImages[i]).catch(() => {
          throw new EditCheckError(`Không đọc được ảnh ${newImages[i].name} — chọn ảnh JPG, PNG hoặc WEBP khác`)
        })
        requestBytes += blob.size
        fd.append('images', blob, `image_${i}.jpg`)
      }
      if (requestBytes > MAX_REQUEST_BYTES) {
        throw new EditCheckError(
          `Tổng dung lượng ảnh + video vượt quá ${MAX_REQUEST_BYTES / (1024 * 1024)}MB — vui lòng bớt tệp`,
        )
      }
      for (const v of newVideos) fd.append('videos', v, v.name)
      await apiClient.post(`/newsfeed/${post.id}/upload`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
    },
    onSuccess: () => {
      toast.success('Đã lưu bài')
      setEditing(false)
      setNewImages([])
      setNewVideos([])
      qc.invalidateQueries({ queryKey: ['newsfeed', 'posts'] })
    },
    onError: (err) =>
      toast.error(err instanceof EditCheckError ? err.message : describeUploadError(err, 'Không lưu được')),
  })

  if (pendingDelete) return null

  const editPlain = editing ? htmlToPlain(editContent) : ''
  const editEmpty = editPlain === ''
  const hasMedia = post.images.length > 0 || !!post.image_url || newImages.length > 0 || newVideos.length > 0
  // Nút Lưu chỉ sáng khi có thay đổi (nội dung, mục hoặc tệp mới); bài phải còn chữ hoặc ảnh/video.
  const editDirty =
    (!editEmpty || hasMedia) &&
    (editContent !== post.content ||
      editCategory !== post.category ||
      newImages.length > 0 ||
      newVideos.length > 0)
  const editCount = [...editPlain].length
  const haveImages = post.images.filter((m) => (m.media_type ?? 'image') === 'image').length
  const haveVideos = post.images.length - haveImages
  const roomImages = Math.max(0, MAX_IMAGES - haveImages - newImages.length)
  const roomVideos = Math.max(0, MAX_VIDEOS - haveVideos - newVideos.length)
  const authorName = post.author.full_name
  const chip = CATEGORY_CHIP[post.category]
  const when = timeAgo(post.created_at)
  const openEdit = () => {
    setEditContent(post.content)
    setEditCategory(post.category)
    setNewImages([])
    setNewVideos([])
    setEditing(true)
  }
  const cancelEdit = () => {
    setEditing(false)
    setEditContent(post.content)
    setEditCategory(post.category)
    setNewImages([])
    setNewVideos([])
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
                      <DropdownMenuItem className="h-10" onClick={openEdit}>
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
                          openEdit()
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
                  disabled={editMutation.isPending || !editDirty}
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
              disabled={editMutation.isPending || !editDirty}
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
                  Đăng {when} · cả công ty thấy
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
            <h2 className="mt-3 mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ax-ink-2">Mục</h2>
            <div role="radiogroup" aria-label="Mục" className="flex flex-wrap gap-2">
              {([...NEWSFEED_CATEGORIES].reverse() as NewsfeedCategory[]).map((c) => {
                const on = editCategory === c
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setEditCategory(c)}
                    className={cn(
                      'h-11 cursor-pointer rounded-full border-[1.5px] px-4 text-[15px] font-semibold transition-colors',
                      on
                        ? 'border-ax-primary text-[var(--ax-stage-new-ink)] bg-[image:linear-gradient(180deg,#f5f9fd,#e8f0f8)]'
                        : 'border-ax-line bg-ax-surface text-ax-ink-2 hover:bg-ax-hover',
                    )}
                  >
                    {CATEGORY_LABEL[c]}
                  </button>
                )
              })}
            </div>
            {(newImages.length > 0 || newVideos.length > 0) && (
              <ul aria-label="Tệp sẽ thêm" className="mt-3 flex flex-col gap-1.5">
                {[...newImages.map((f, i) => ['image', f, i] as const), ...newVideos.map((f, i) => ['video', f, i] as const)].map(
                  ([kind, f, i]) => (
                    <li
                      key={`${kind}-${i}-${f.name}`}
                      className="flex items-center gap-2 rounded-ax-field border border-ax-line px-3 text-sm text-ax-ink-2"
                    >
                      {kind === 'image' ? (
                        <ImagePlus aria-hidden className="size-4 shrink-0 text-ax-primary" strokeWidth={1.75} />
                      ) : (
                        <Video aria-hidden className="size-4 shrink-0 text-ax-primary" strokeWidth={1.75} />
                      )}
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <button
                        type="button"
                        aria-label={`Bỏ ${f.name}`}
                        onClick={() =>
                          kind === 'image'
                            ? setNewImages((p) => p.filter((_, j) => j !== i))
                            : setNewVideos((p) => p.filter((_, j) => j !== i))
                        }
                        className="-mr-2 inline-flex size-11 items-center justify-center rounded-ax-field hover:bg-ax-hover"
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  ),
                )}
              </ul>
            )}
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
          <div className="flex items-center border-t border-ax-divider bg-ax-surface px-2 pt-1.5 pb-[max(18px,env(safe-area-inset-bottom))]">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                if (files.length > roomImages) toast.error(`Bài chỉ nhận tối đa ${MAX_IMAGES} ảnh`)
                setNewImages((prev) => [...prev, ...files.slice(0, roomImages)])
                e.target.value = ''
              }}
            />
            <input
              ref={videoInputRef}
              type="file"
              accept={ACCEPT_VIDEO}
              multiple
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? [])
                if (picked.some((f) => f.size > MAX_VIDEO_BYTES)) {
                  toast.error('Video vượt quá 40MB, vui lòng chọn file nhỏ hơn')
                }
                const ok = picked.filter((f) => f.size <= MAX_VIDEO_BYTES)
                if (ok.length > roomVideos) toast.error(`Bài chỉ nhận tối đa ${MAX_VIDEOS} video`)
                setNewVideos((prev) => [...prev, ...ok.slice(0, roomVideos)])
                e.target.value = ''
              }}
            />
            <button
              type="button"
              aria-label="Thêm ảnh"
              disabled={roomImages === 0 || editMutation.isPending}
              onClick={() => imageInputRef.current?.click()}
              className="inline-flex size-12 items-center justify-center rounded-ax-field text-ax-primary hover:bg-ax-hover disabled:text-ax-ink-3"
            >
              <ImagePlus aria-hidden className="size-6" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="Thêm video"
              disabled={roomVideos === 0 || editMutation.isPending}
              onClick={() => videoInputRef.current?.click()}
              className="inline-flex size-12 items-center justify-center rounded-ax-field text-ax-primary hover:bg-ax-hover disabled:text-ax-ink-3"
            >
              <Video aria-hidden className="size-6" strokeWidth={1.75} />
            </button>
            <span
              data-testid="edit-char-count"
              className="ml-auto mr-2 text-[13px] tabular-nums text-ax-ink-2"
            >
              {editCount} ký tự
            </span>
          </div>
        </div>
      )}
    </article>
  )
}
