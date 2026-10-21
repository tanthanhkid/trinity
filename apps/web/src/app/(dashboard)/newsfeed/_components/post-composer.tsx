'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImagePlus, Loader2, Send, Video, X } from 'lucide-react'
import { toast } from 'sonner'
import axios from 'axios'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { MobileActionBar } from '@/components/app-shell/mobile-action-bar'
import { cn } from '@/lib/utils'
import { RichTextEditor } from '@/components/ui/rich-text-editor'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePermissions } from '@/lib/rbac'
import apiClient, { getApiErrorMessage } from '@/lib/api-client'
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

interface VideoUploadGrant {
  key: string
  upload_url: string
  headers: Record<string, string>
}

/**
 * Vercel chặn body function >4,5MB: video được PUT thẳng lên Blob bằng token ký từ BE.
 * Trả `null` khi môi trường không hỗ trợ (BE 400 → luồng multipart cũ qua BE vẫn dùng).
 */
async function uploadVideosDirect(
  files: File[],
  onProgress: (pct: number) => void,
): Promise<string[] | null> {
  const keys: string[] = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    let grant: VideoUploadGrant
    try {
      const res = await apiClient.post<VideoUploadGrant>('/newsfeed/video-upload-token', {
        file_name: file.name,
        size: file.size,
      })
      grant = res.data
    } catch (err) {
      if (i === 0 && axios.isAxiosError(err) && err.response?.status === 400) return null
      throw err
    }
    // axios trần (KHÔNG apiClient) — không gửi JWT của CRM sang Blob.
    await axios.put(grant.upload_url, file, {
      headers: grant.headers,
      onUploadProgress: (evt) => {
        if (!evt.total) return
        onProgress(Math.round(((i + evt.loaded / evt.total) / files.length) * 100))
      },
    })
    keys.push(grant.key)
  }
  return keys
}

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
  // thanh đáy chỉ hiện trên điện thoại khi đang soạn (focus/có nội dung).
  const [focused, setFocused] = useState(false)

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
      setUploadProgress(0)
      const directKeys = videos.length > 0 ? await uploadVideosDirect(videos, setUploadProgress) : []
      // `directKeys === null` → môi trường không hỗ trợ upload trực tiếp → gửi video qua multipart.
      const multipartVideos = directKeys === null ? videos : []
      const totalVideoBytes = multipartVideos.reduce((sum, v) => sum + v.size, 0)
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
      for (const video of multipartVideos) {
        fd.append('videos', video, video.name)
      }
      if (directKeys && directKeys.length > 0) fd.append('video_keys', directKeys.join(','))
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
      toast.success('Đã đăng bài')
      setContent('')
      setImages([])
      setVideos([])
      if (fileRef.current) fileRef.current.value = ''
      if (videoRef.current) videoRef.current.value = ''
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
      <Card className="rounded-2xl">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Bạn không có quyền đăng bài lên bảng tin. Liên hệ quản trị viên để
          được cấp quyền `Đăng bài`.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card
      className="rounded-2xl"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="w-full sm:w-56">
            <Select
              value={category ?? undefined}
              onValueChange={(v) => setCategory((v as NewsfeedCategory) ?? null)}
            >
              <SelectTrigger>
                {/* Base-UI BỎ QUA prop `placeholder` khi <SelectValue> có
                    children là HÀM (nhánh placeholder là `else if` đứng sau
                    nhánh function) ⇒ chưa chọn gì thì trigger render TRỐNG
                    TRƠN. Nút 224×44px chỉ hiện mũi ▼.
                    Phải tự trả nhãn gợi ý TRONG hàm. */}
                <SelectValue>
                  {(v) =>
                    typeof v === 'string' && v ? (
                      CATEGORY_LABEL[v as NewsfeedCategory]
                    ) : (
                      <span className="text-muted-foreground">Chọn nhóm chủ đề</span>
                    )
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {NEWSFEED_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <RichTextEditor
          value={content}
          onChange={setContent}
          placeholder="Bạn đang nghĩ gì? Chia sẻ với cả công ty..."
          className="min-h-[140px] max-sm:min-h-[96px]"
          contentClassName="min-h-[110px] max-sm:min-h-[64px]"
        />

        {images.length > 0 && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {images.map((file, idx) => (
              <div key={idx} className="relative aspect-square">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imagePreviews[idx]}
                  alt={`ảnh ${idx + 1}`}
                  className="h-full w-full rounded-lg border object-cover"
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
              <div key={idx} className="relative aspect-video">
                <video
                  src={videoPreviews[idx]}
                  className="h-full w-full rounded-lg border bg-black object-contain"
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
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Đang tải lên... {uploadProgress}%
            </p>
          </div>
        )}

        <div
          className={cn(
            !(focused || !contentEmpty || images.length > 0 || videos.length > 0 || createMutation.isPending) &&
              'max-sm:hidden',
          )}
        >
        <MobileActionBar className="flex-wrap items-center justify-between max-sm:flex-nowrap">
          <div className="flex items-center gap-1">
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
            <Button
              type="button"
              variant="ghost"
              disabled={images.length >= MAX_IMAGES}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="size-4" />
              Ảnh
              {images.length > 0 && (
                <span className="ml-1 text-xs text-muted-foreground">
                  {images.length}/{MAX_IMAGES}
                </span>
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={videos.length >= MAX_VIDEOS}
              onClick={() => videoRef.current?.click()}
            >
              <Video className="size-4" />
              Video
              {videos.length > 0 && (
                <span className="ml-1 text-xs text-muted-foreground">
                  {videos.length}/{MAX_VIDEOS}
                </span>
              )}
            </Button>
          </div>
          <Button
            type="button"
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Đăng bài
          </Button>
        </MobileActionBar>
        </div>
      </CardContent>
    </Card>
  )
}
