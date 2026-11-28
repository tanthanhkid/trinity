'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImagePlus, Loader2, PenLine, Video, X } from 'lucide-react'
import { toast } from 'sonner'
import axios from 'axios'
import { Button } from '@/components/ui/button'
import { PersonAvatar } from '@/components/ui/avatar'
import { HeroCard } from '@/components/ui/hero-card'
import { cn } from '@/lib/utils'
import { RichTextEditor } from '@/components/ui/rich-text-editor'
import { useAuthStore } from '@/store/auth'
import { usePermissions } from '@/lib/rbac'
import apiClient, { getApiErrorMessage } from '@/lib/api-client'
import { useIsDesktop } from './use-is-desktop'
import {
  CATEGORY_LABEL,
  NEWSFEED_CATEGORIES,
  type NewsfeedCategory,
  type NewsfeedPost,
} from './types'

const MAX_IMAGES = 10
const MAX_VIDEOS = 5
// Khớp giới hạn upload của BE: video ≤40MB, chỉ MP4/WebM/MOV.
// PHẢI đồng bộ UPLOAD_FIELD_SIZE_MAX/MAX_VIDEO_SIZE của BE và giới hạn body của reverse proxy.
const MAX_VIDEO_BYTES = 40 * 1024 * 1024
// Trần TỔNG dung lượng video 1 bài: giới hạn body của reverse proxy áp cho TOÀN
// request (mọi field cộng lại), KHÔNG per-file — nhiều video mỗi cái ≤40MB
// nhưng tổng vượt sẽ bị trả 413 với thông báo khó hiểu. Chặn sớm FE.
const MAX_TOTAL_VIDEO_BYTES = 40 * 1024 * 1024
// Trần TOÀN request (ảnh đã nén + video): giới hạn 50MB của proxy trừ headroom overhead
// multipart. Kiểm SAU khi nén ảnh vì chỉ lúc đó mới biết dung lượng thật.
const MAX_REQUEST_BYTES = 48 * 1024 * 1024

const ACCEPT_VIDEO = 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov'

// Nén ảnh phía client: resize về 1920px + convert JPEG quality 85 bằng canvas.
// Video KHÔNG nén phía client (gửi nguyên file thẳng BE).
async function compressImage(file: File): Promise<Blob> {
  const MAX_PX = 1920
  const QUALITY = 0.85
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width > MAX_PX || height > MAX_PX) {
        if (width >= height) {
          height = Math.round((height * MAX_PX) / width)
          width = MAX_PX
        } else {
          width = Math.round((width * MAX_PX) / height)
          height = MAX_PX
        }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('canvas context unavailable'))
      // JPEG không có kênh alpha: vùng trong suốt của PNG/WebP sẽ thành đen nếu không tô nền trước.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob)
          else reject(new Error('canvas toBlob failed'))
        },
        'image/jpeg',
        QUALITY,
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image load failed'))
    }
    img.src = url
  })
}

// RichTextEditor trả HTML; coi là "rỗng" khi bỏ hết thẻ chỉ còn khoảng trắng.
function htmlIsEmpty(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === ''
}

// Thông báo lỗi upload rõ ràng theo nguyên nhân ("thông báo lỗi
// rõ ràng nếu upload thất bại hoặc vượt quá giới hạn"): phân biệt vượt trần
// dung lượng (413), mất kết nối giữa lúc tải (không có
// response), và lỗi nghiệp vụ khác (message BE trả về).
function describeUploadError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.response?.status === 413) {
      return 'Video/ảnh vượt quá giới hạn dung lượng cho phép (tối đa 40MB/video, 48MB/bài)'
    }
    if (!err.response) {
      return 'Mất kết nối trong khi tải lên — vui lòng kiểm tra mạng và thử lại'
    }
    return getApiErrorMessage(err, 'Không đăng được bài')
  }
  return 'Không đăng được bài'
}

export function PostComposer() {
  // Đăng bài = quyền `newsfeed.post`.
  const canPost = usePermissions().can('newsfeed.post')
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLInputElement>(null)
  const [category, setCategory] = useState<NewsfeedCategory | null>(
    NEWSFEED_CATEGORIES[0],
  )
  const [content, setContent] = useState('')
  const [images, setImages] = useState<File[]>([])
  const [videos, setVideos] = useState<File[]>([])
  // Tiến trình upload (0-100) — chỉ có ý nghĩa khi có ảnh/video kèm bài. Bài chỉ có text thì request nhỏ,
  // progress nhảy thẳng 100% — không cần ẩn thanh riêng cho case đó.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  // Mở khung soạn: desktop = thanh mời viết → khung đầy đủ; mobile = nút «Viết bài» → màn hình đầy.
  const [open, setOpen] = useState(false)
  const isDesktop = useIsDesktop()
  const me = useAuthStore((s) => s.user)

  // Blob URLs preview — tạo lại khi danh sách thay đổi, revoke khi cleanup.
  const imagePreviews = useMemo(
    () => images.map((f) => URL.createObjectURL(f)),
    [images],
  )
  const videoPreviews = useMemo(
    () => videos.map((f) => URL.createObjectURL(f)),
    [videos],
  )
  useEffect(() => {
    return () => {
      imagePreviews.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [imagePreviews])
  useEffect(() => {
    return () => {
      videoPreviews.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [videoPreviews])

  function removeImage(idx: number) {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }
  function removeVideo(idx: number) {
    setVideos((prev) => prev.filter((_, i) => i !== idx))
  }

  const contentEmpty = htmlIsEmpty(content)

  const createMutation = useMutation({
    mutationFn: async (): Promise<NewsfeedPost> => {
      if (!category) throw new Error('Vui lòng chọn nhóm chủ đề')
      if (contentEmpty && images.length === 0 && videos.length === 0) {
        throw new Error('Vui lòng nhập nội dung hoặc đính kèm ảnh/video')
      }
      const totalVideoBytes = videos.reduce((sum, v) => sum + v.size, 0)
      if (totalVideoBytes > MAX_TOTAL_VIDEO_BYTES) {
        throw new Error(
          `Tổng dung lượng video vượt quá ${MAX_TOTAL_VIDEO_BYTES / (1024 * 1024)}MB — vui lòng bớt hoặc chia thành nhiều bài`,
        )
      }
      const fd = new FormData()
      fd.append('category', category)
      // Chỉ có media → gửi content rỗng (BE cho phép).
      // Bỏ &nbsp;/khoảng trắng thừa ở cuối do editor sinh.
      fd.append('content', contentEmpty ? '' : content.replace(/(?:&nbsp;|\s)+$/gi, ''))
      // Nén từng ảnh trước khi upload
      let requestBytes = totalVideoBytes
      for (let i = 0; i < images.length; i++) {
        const blob = await compressImage(images[i])
        requestBytes += blob.size
        fd.append('images', blob, `image_${i}.jpg`)
      }
      if (requestBytes > MAX_REQUEST_BYTES) {
        throw new Error(
          `Tổng dung lượng ảnh + video vượt quá ${MAX_REQUEST_BYTES / (1024 * 1024)}MB — vui lòng bớt hoặc chia thành nhiều bài`,
        )
      }
      // Video gửi nguyên file (không nén phía client)
      for (const video of videos) {
        fd.append('videos', video, video.name)
      }
      setUploadProgress(0)
      const res = await apiClient.post<NewsfeedPost>('/newsfeed/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (evt) => {
          if (!evt.total) return
          setUploadProgress(Math.round((evt.loaded / evt.total) * 100))
        },
      })
      return res.data
    },
    onSuccess: () => {
      toast.success('Đã đăng lên bảng tin')
      setContent('')
      setImages([])
      setVideos([])
      if (fileRef.current) fileRef.current.value = ''
      if (videoRef.current) videoRef.current.value = ''
      setOpen(false)
      qc.invalidateQueries({ queryKey: ['newsfeed', 'posts'] })
    },
    onError: (err: unknown) => {
      toast.error(describeUploadError(err))
    },
    onSettled: () => {
      setUploadProgress(null)
    },
  })

  if (!canPost) {
    return (
      <p className="ax-sunken px-4 py-3 text-sm text-ax-ink-2 max-lg:mx-0">
        Bạn không có quyền đăng bài lên bảng tin. Liên hệ quản trị viên để
        được cấp quyền `Đăng bài`.
      </p>
    )
  }

  const hasMedia = images.length > 0 || videos.length > 0
  const publishOff = createMutation.isPending || (contentEmpty && !hasMedia)
  const authorName = me?.full_name ?? ''

  function discard() {
    setContent('')
    setImages([])
    setVideos([])
    setOpen(false)
  }

  const previews = (
    <>
      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {images.map((file, idx) => (
            <div key={`${file.name}-${idx}`} className="relative aspect-square">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imagePreviews[idx]}
                alt={`ảnh ${idx + 1}`}
                className="h-full w-full rounded-ax-field border border-ax-line object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(idx)}
                aria-label="Bỏ tệp này"
                className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white max-sm:-right-1 max-sm:-top-1 max-sm:flex max-sm:size-11 max-sm:items-center max-sm:justify-center max-sm:bg-transparent max-sm:p-0 max-sm:[&>svg]:box-content max-sm:[&>svg]:rounded-full max-sm:[&>svg]:bg-black/60 max-sm:[&>svg]:p-1"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {videos.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {videos.map((file, idx) => (
            <div key={`${file.name}-${idx}`} className="relative aspect-video">
              <video
                src={videoPreviews[idx]}
                className="h-full w-full rounded-ax-field border border-ax-line bg-black object-contain"
                controls
                preload="metadata"
              />
              <button
                type="button"
                onClick={() => removeVideo(idx)}
                aria-label="Bỏ tệp này"
                className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white max-sm:-right-1 max-sm:-top-1 max-sm:flex max-sm:size-11 max-sm:items-center max-sm:justify-center max-sm:bg-transparent max-sm:p-0 max-sm:[&>svg]:box-content max-sm:[&>svg]:rounded-full max-sm:[&>svg]:bg-black/60 max-sm:[&>svg]:p-1"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {uploadProgress !== null && (
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-ax-sunken">
            <div
              className="h-full rounded-full bg-ax-primary transition-[width]"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <p className="text-xs text-ax-ink-2">Đang tải lên... {uploadProgress}%</p>
        </div>
      )}
    </>
  )

  const fileInputs = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          setImages((prev) => [...prev, ...files].slice(0, MAX_IMAGES))
          if (fileRef.current) fileRef.current.value = ''
        }}
      />
      <input
        ref={videoRef}
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
          setVideos((prev) => [...prev, ...ok].slice(0, MAX_VIDEOS))
          if (videoRef.current) videoRef.current.value = ''
        }}
      />
    </>
  )

  const attachButtons = (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ax-ghost"
        size="ax"
        className="max-lg:h-11"
        disabled={images.length >= MAX_IMAGES}
        onClick={() => fileRef.current?.click()}
      >
        <ImagePlus className="size-[18px] text-ax-primary" strokeWidth={1.75} />
        Ảnh
        {images.length > 0 && (
          <span className="text-xs text-ax-ink-2">
            {images.length}/{MAX_IMAGES}
          </span>
        )}
      </Button>
      <Button
        type="button"
        variant="ax-ghost"
        size="ax"
        className="max-lg:h-11"
        disabled={videos.length >= MAX_VIDEOS}
        onClick={() => videoRef.current?.click()}
      >
        <Video className="size-[18px] text-ax-primary" strokeWidth={1.75} />
        Video
        {videos.length > 0 && (
          <span className="text-xs text-ax-ink-2">
            {videos.length}/{MAX_VIDEOS}
          </span>
        )}
      </Button>
    </div>
  )

  // Chọn mục: thứ tự theo thiết kế (Thông báo · Đào tạo · Truyền thông).
  const categoryPicker = (mobile: boolean) => (
    <div role="radiogroup" aria-label="Mục" className="flex flex-wrap items-center gap-2">
      {([...NEWSFEED_CATEGORIES].reverse() as NewsfeedCategory[]).map((c) => {
        const on = category === c
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setCategory(c)}
            className={cn(
              'cursor-pointer rounded-full border-[1.5px] font-semibold transition-colors',
              mobile ? 'h-11 px-4 text-[15px]' : 'h-9 px-3 text-[13px]',
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
  )

  const publishButton = (
    <Button
      type="button"
      variant="ax-primary"
      size="ax"
      className="px-5"
      disabled={publishOff}
      onClick={() => createMutation.mutate()}
    >
      {createMutation.isPending && <Loader2 className="size-4 animate-spin" />}
      Đăng bài
    </Button>
  )

  return (
    <section aria-label="Viết bài" className="flex flex-col">
      {fileInputs}

      {/* DESKTOP: thanh mời viết (khối nhấn) → khung soạn đầy đủ */}
      {isDesktop && !open && (
        <HeroCard className="flex items-center gap-3 !rounded-[14px] !p-4">
          <PersonAvatar kind="staff" size="lg" name={authorName} src={me?.avatar_url} className="shadow-[0_6px_14px_-6px_rgba(13,32,54,.55)]" />
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="h-[46px] flex-1 cursor-pointer rounded-full bg-white px-5 text-left text-[15px] text-ax-ink-2 shadow-[0_1px_2px_rgba(13,32,54,.30),0_8px_18px_-10px_rgba(13,32,54,.5)] transition-colors hover:bg-[#f7f7f5]"
          >
            Viết gì đó cho cả công ty…
          </button>
        </HeroCard>
      )}
      {isDesktop && open && (
        <div className="ax-grad-composer flex flex-col gap-3 rounded-[14px] border border-ax-line p-4 shadow-ax-card">
          <RichTextEditor
            value={content}
            onChange={setContent}
            placeholder="Viết nội dung. Thông báo ca làm, chương trình giảm giá, tài liệu đào tạo…"
            className="min-h-[140px]"
            contentClassName="min-h-[110px]"
          />
          {previews}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              {attachButtons}
              <span aria-hidden className="mx-1.5 h-5 w-px bg-ax-divider" />
              {categoryPicker(false)}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ax-ghost" size="ax" onClick={discard} disabled={createMutation.isPending}>
                Huỷ
              </Button>
              {publishButton}
            </div>
          </div>
        </div>
      )}

      {/* MOBILE: nút nổi «Viết bài» → màn hình soạn đầy */}
      {!isDesktop && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed right-4 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-40 flex h-14 cursor-pointer items-center gap-2 rounded-[28px] px-[22px] pl-[18px] text-base font-bold text-white ax-grad-primary shadow-[var(--ax-shadow-primary),0_10px_24px_-8px_rgba(40,86,128,.5)]"
        >
          <PenLine className="size-5" strokeWidth={2.4} aria-hidden />
          Viết bài
        </button>
      )}
      {!isDesktop && open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Viết bài"
          className="fixed inset-0 z-50 flex flex-col bg-ax-surface text-ax-ink"
        >
          <div className="flex items-center justify-between border-b border-ax-divider px-2 pt-2 pb-1">
            <button
              type="button"
              onClick={discard}
              disabled={createMutation.isPending}
              className="h-11 px-3 text-base text-ax-ink-2"
            >
              Huỷ
            </button>
            <h1 className="text-[17px] font-semibold tracking-[-0.011em]">Viết bài</h1>
            <button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={publishOff}
              className="h-11 px-3.5 text-base font-bold text-ax-primary-hover disabled:text-ax-ink-3"
            >
              {createMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Đăng'}
            </button>
          </div>
          <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3.5">
            <HeroCard className="flex items-center gap-3 !rounded-[18px] !p-4">
              <PersonAvatar kind="staff" size="xl" name={authorName} src={me?.avatar_url} />
              <div className="leading-snug">
                <div className="text-[17px] font-semibold tracking-[-0.011em]">{authorName}</div>
                <div className="text-[13px] text-white/95">Cả công ty đều thấy bài này</div>
              </div>
            </HeroCard>
            <RichTextEditor
              value={content}
              onChange={setContent}
              placeholder="Bạn đang nghĩ gì? Chia sẻ với cả công ty..."
              className="min-h-[200px]"
              contentClassName="min-h-[170px]"
            />
            {previews}
            {attachButtons}
            <h2 className="mt-1 text-[11px] font-semibold uppercase tracking-[.06em] text-ax-ink-2">Mục</h2>
            {categoryPicker(true)}
          </div>
        </div>
      )}
    </section>
  )
}
