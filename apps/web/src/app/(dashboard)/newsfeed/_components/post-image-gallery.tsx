'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Play, X } from 'lucide-react'
import apiClient from '@/lib/api-client'
import { type NewsfeedMediaType, type NewsfeedPost } from './types'

// Mỗi media item giữ index GỐC trong mảng post.images (endpoint stream dùng
// index này) + loại media để render đúng <img> / <video>.
interface MediaItem {
  index: number
  type: NewsfeedMediaType
}

// Fetch media (ảnh HOẶC video) qua apiClient (JWT interceptor tự đính kèm) →
// blob URL. `enabled` cho phép hoãn tải video nặng tới khi user bấm play.
function usePostMedia(postId: number, index: number, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null)
  const revokeRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    apiClient
      .get(`/newsfeed/${postId}/images/${index}`, { responseType: 'blob' })
      .then((res) => {
        if (cancelled) return
        const blobUrl = URL.createObjectURL(res.data as Blob)
        revokeRef.current = blobUrl
        setUrl(blobUrl)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      if (revokeRef.current) {
        URL.revokeObjectURL(revokeRef.current)
        revokeRef.current = null
      }
    }
  }, [postId, index, enabled])

  return url
}

function PostImageThumb({
  postId,
  index,
  onClick,
  overlay,
}: {
  postId: number
  index: number
  onClick: () => void
  overlay?: string
}) {
  const url = usePostMedia(postId, index, true)
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative h-full w-full overflow-hidden rounded-lg border bg-muted focus-visible:outline-none focus-visible:ring-2"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`ảnh ${index + 1}`} className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full animate-pulse bg-muted" />
      )}
      {overlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xl font-bold text-white">
          {overlay}
        </div>
      )}
    </button>
  )
}

// Video: hiển thị poster "bấm để phát"; chỉ tải blob (có thể 50MB) khi bấm.
// Sau khi tải, <video controls> phát + tua bình thường (blob có sẵn full data).
function PostVideo({ postId, index }: { postId: number; index: number }) {
  const [loadRequested, setLoadRequested] = useState(false)
  const url = usePostMedia(postId, index, loadRequested)

  if (!loadRequested) {
    return (
      <button
        type="button"
        onClick={() => setLoadRequested(true)}
        className="relative flex aspect-video w-full items-center justify-center rounded-xl border bg-black/90 focus-visible:outline-none focus-visible:ring-2"
        aria-label="Phát video"
      >
        <span className="flex flex-col items-center gap-2 text-white">
          <span className="flex size-14 items-center justify-center rounded-full bg-white/20">
            <Play className="size-7 fill-current" />
          </span>
          <span className="text-sm">Bấm để phát video</span>
        </span>
      </button>
    )
  }

  if (!url) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-xl border bg-black/90">
        <Loader2 className="size-8 animate-spin text-white" />
      </div>
    )
  }

  return (
    <video
      src={url}
      controls
      autoPlay
      preload="metadata"
      className="max-h-[600px] w-full rounded-xl border bg-black"
    />
  )
}

// Lightbox toàn màn hình (chỉ dùng cho ẢNH — video phát inline).
function Lightbox({
  postId,
  images,
  initialPos,
  onClose,
}: {
  postId: number
  images: MediaItem[]
  initialPos: number
  onClose: () => void
}) {
  const [pos, setPos] = useState(initialPos)
  const total = images.length
  const url = usePostMedia(postId, images[pos]?.index ?? 0, true)
  const closeRef = useRef<HTMLButtonElement>(null)
  // Vuốt ngang để chuyển ảnh (điện thoại): ngưỡng 50px, chủ yếu theo trục ngang.
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') setPos((c) => Math.max(0, c - 1))
      if (e.key === 'ArrowRight') setPos((c) => Math.min(total - 1, c + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, total])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Xem ảnh"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
      onTouchStart={(e) => {
        const t = e.touches[0]
        touchStart.current = { x: t.clientX, y: t.clientY }
      }}
      onTouchEnd={(e) => {
        const st = touchStart.current
        touchStart.current = null
        if (!st) return
        const t = e.changedTouches[0]
        const dx = t.clientX - st.x
        const dy = t.clientY - st.y
        if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return
        setPos((c) => (dx < 0 ? Math.min(total - 1, c + 1) : Math.max(0, c - 1)))
      }}
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Đóng"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 max-sm:top-[max(1rem,env(safe-area-inset-top))] max-sm:flex max-sm:size-12 max-sm:items-center max-sm:justify-center max-sm:p-0"
      >
        <X className="size-5" />
      </button>

      {total > 1 && (
        <>
          <button
            type="button"
            disabled={pos === 0}
            aria-label="Ảnh trước"
            onClick={(e) => { e.stopPropagation(); setPos((c) => c - 1) }}
            className="absolute left-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-30 max-sm:flex max-sm:size-12 max-sm:items-center max-sm:justify-center max-sm:p-0"
          >
            <ChevronLeft className="size-5" aria-hidden />
          </button>
          <button
            type="button"
            disabled={pos === total - 1}
            aria-label="Ảnh sau"
            onClick={(e) => { e.stopPropagation(); setPos((c) => c + 1) }}
            className="absolute right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-30 max-sm:flex max-sm:size-12 max-sm:items-center max-sm:justify-center max-sm:p-0"
          >
            <ChevronRight className="size-5" />
          </button>
          <div className="absolute bottom-4 text-sm max-sm:bottom-[max(1rem,env(safe-area-inset-bottom))] text-white/70">
            {pos + 1} / {total}
          </div>
        </>
      )}

      <div
        className="max-h-[90vh] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={`ảnh ${pos + 1}`}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
          />
        ) : (
          <div className="flex h-64 w-64 items-center justify-center">
            <Loader2 className="size-8 animate-spin text-white" />
          </div>
        )}
      </div>
    </div>
  )
}

export function PostImageGallery({ post }: { post: NewsfeedPost }) {
  const [lightboxPos, setLightboxPos] = useState<number | null>(null)

  // Bài mới: dùng images[] (kèm media_type). Bài cũ (legacy): images=[] nhưng
  // image_url có giá trị → 1 ảnh index 0 (BE streamImage fallback image_url).
  const items: MediaItem[] = useMemo(() => {
    if (post.images.length > 0) {
      return post.images.map((img, i) => ({
        index: i,
        type: (img.media_type as NewsfeedMediaType | undefined) ?? 'image',
      }))
    }
    if (post.image_url) return [{ index: 0, type: 'image' as const }]
    return []
  }, [post.images, post.image_url])

  const videoItems = useMemo(() => items.filter((it) => it.type === 'video'), [items])
  const imageItems = useMemo(() => items.filter((it) => it.type === 'image'), [items])

  if (items.length === 0) return null

  const imgCount = imageItems.length
  const SHOW = Math.min(imgCount, 4)
  const extra = imgCount > 4 ? imgCount - 3 : 0

  return (
    <div className="space-y-2">
      {videoItems.map((v) => (
        <PostVideo key={v.index} postId={post.id} index={v.index} />
      ))}

      {imgCount > 0 && (
        <div
          className={`grid gap-1 overflow-hidden rounded-xl ${
            imgCount === 1
              ? 'grid-cols-1'
              : imgCount === 2
                ? 'grid-cols-2'
                : 'grid-cols-3'
          }`}
          style={{ aspectRatio: imgCount === 1 ? 'auto' : '16/9' }}
        >
          {Array.from({ length: SHOW }).map((_, i) => {
            const isLast = i === SHOW - 1 && extra > 0
            return (
              <div
                key={imageItems[i].index}
                className={imgCount === 1 ? 'max-h-[600px]' : 'h-full min-h-[100px]'}
              >
                <PostImageThumb
                  postId={post.id}
                  index={imageItems[i].index}
                  onClick={() => setLightboxPos(i)}
                  overlay={isLast ? `+${extra}` : undefined}
                />
              </div>
            )
          })}
        </div>
      )}

      {lightboxPos !== null && (
        <Lightbox
          postId={post.id}
          images={imageItems}
          initialPos={lightboxPos}
          onClose={() => setLightboxPos(null)}
        />
      )}
    </div>
  )
}
