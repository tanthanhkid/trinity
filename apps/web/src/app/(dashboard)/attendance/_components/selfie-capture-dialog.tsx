"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Camera, Check, Loader2, RefreshCw } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface SelfieCaptureDialogProps {
  open: boolean
  title: string
  /** true khi đang gửi chấm công — disable nút + hiện spinner */
  pending?: boolean
  onClose: () => void
  onCapture: (blob: Blob) => void
}

/**
 * Dialog chụp ảnh selfie BẮT BUỘC khi chấm công vào/ra.
 * Camera lỗi / từ chối quyền → hiện lỗi tiếng Việt, KHÔNG cho chấm công.
 * Cleanup: dừng MediaStream khi đóng/unmount để camera không kẹt sáng.
 */
export function SelfieCaptureDialog({
  open,
  title,
  pending,
  onClose,
  onCapture,
}: SelfieCaptureDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const activeRef = useRef(false)
  const capturedRef = useRef<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const startCamera = useCallback(async () => {
    setError(null)
    setStarting(true)
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Thiết bị/trình duyệt không hỗ trợ camera. Vui lòng dùng trình duyệt khác.")
      setStarting(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      })
      // Dialog đã đóng trong lúc chờ quyền → dừng stream, không gán.
      if (!activeRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      stopStream()
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError("Bạn đã từ chối quyền camera. Vui lòng cấp quyền camera cho trình duyệt để chấm công.")
      } else if (
        name === "NotFoundError" ||
        name === "DevicesNotFoundError" ||
        name === "OverconstrainedError"
      ) {
        setError("Không tìm thấy camera trên thiết bị. Không thể chấm công bằng ảnh selfie.")
      } else {
        setError("Không thể mở camera. Vui lòng kiểm tra quyền truy cập rồi thử lại.")
      }
    } finally {
      setStarting(false)
    }
  }, [stopStream])

  // Mở/đóng camera theo trạng thái dialog.
  useEffect(() => {
    if (!open) return
    activeRef.current = true
    capturedRef.current = null
    setPreviewUrl(null)
    void startCamera()
    return () => {
      activeRef.current = false
      stopStream()
    }
  }, [open, startCamera, stopStream])

  // Revoke objectURL của ảnh preview khi đổi/unmount.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  function handleCapture() {
    const video = videoRef.current
    if (!video || !streamRef.current) return
    const w = video.videoWidth || 480
    const h = video.videoHeight || 640
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.drawImage(video, 0, 0, w, h)
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError("Không thể chụp ảnh. Vui lòng thử lại.")
          return
        }
        capturedRef.current = blob
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return URL.createObjectURL(blob)
        })
        stopStream() // đã có ảnh → tắt camera
      },
      "image/jpeg",
      0.85,
    )
  }

  function handleRetake() {
    capturedRef.current = null
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    void startCamera()
  }

  function handleConfirm() {
    if (capturedRef.current) onCapture(capturedRef.current)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto max-w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {error ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <AlertTriangle className="h-10 w-10 text-amber-500" />
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" onClick={() => void startCamera()}>
              <RefreshCw className="mr-2 h-4 w-4" /> Thử lại
            </Button>
          </div>
        ) : previewUrl ? (
          <div className="flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="Ảnh selfie chấm công"
              className="max-h-[60vh] w-auto rounded-lg border object-contain"
            />
          </div>
        ) : (
          <div className="relative overflow-hidden rounded-lg border bg-black">
            {/* mirror hiển thị cho tự nhiên; ảnh canvas lưu KHÔNG mirror (đúng chiều thật) */}
            <video
              ref={videoRef}
              playsInline
              muted
              className="mx-auto max-h-[55vh] w-full object-contain"
              style={{ transform: "scaleX(-1)" }}
            />
            {starting && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 text-sm text-white">
                <Loader2 className="h-5 w-5 animate-spin" /> Đang mở camera…
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {error ? (
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
          ) : previewUrl ? (
            <>
              <Button variant="outline" onClick={handleRetake} disabled={pending}>
                <RefreshCw className="mr-2 h-4 w-4" /> Chụp lại
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={pending}
              >
                {pending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Check className="mr-2 h-4 w-4" />
                )}
                Xác nhận &amp; chấm công
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Huỷ
              </Button>
              <Button
                onClick={handleCapture}
                disabled={starting}
              >
                <Camera className="mr-2 h-4 w-4" /> Chụp ảnh
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
