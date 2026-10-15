"use client"

/**
 * Ô "Ảnh minh hoạ" của popup Thêm/Sửa sản phẩm: chọn ảnh từ máy để
 * tải lên (kèm xem trước) HOẶC vẫn dán URL như cũ. Giá trị của field luôn là 1
 * chuỗi URL — contract gửi BE không đổi.
 */
import { useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useUploadProductImage } from "@/hooks/products/use-products"

/** Khớp `PRODUCT_IMAGE_MAX_BYTES` của BE (`product-image-upload.helper.ts`). */
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const PRODUCT_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif"

/** Trả thông báo lỗi tiếng Việt nếu file không hợp lệ, `null` nếu hợp lệ. */
export function validateProductImageFile(file: { type: string; size: number }): string | null {
  if (!PRODUCT_IMAGE_ACCEPT.split(",").includes(file.type)) {
    return "Chỉ chấp nhận ảnh JPG, PNG, WebP hoặc GIF"
  }
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
    return `Ảnh quá lớn (${(file.size / 1024 / 1024).toFixed(1)}MB), tối đa ${PRODUCT_IMAGE_MAX_BYTES / 1024 / 1024}MB`
  }
  return null
}

export function ProductImageField({
  value,
  onChange,
}: {
  value: string
  onChange: (url: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const upload = useUploadProductImage()
  const [error, setError] = useState("")

  function handlePick(file: File | undefined) {
    if (!file) return
    const invalid = validateProductImageFile(file)
    if (invalid) {
      setError(invalid)
      return
    }
    setError("")
    upload.mutate(file, {
      onSuccess: (url) => onChange(url),
      onError: (err) => {
        const msg = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message
        const text = Array.isArray(msg) ? msg.join(", ") : typeof msg === "string" ? msg : "Tải ảnh lên thất bại"
        setError(text)
        toast.error(text)
      },
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 max-sm:flex-wrap">
        <Input
          id="p-image"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://... hoặc chọn ảnh từ máy"
          className="max-sm:basis-full"
        />
        <Button
          type="button"
          variant="outline"
          className="flex-none max-sm:w-full"
          disabled={upload.isPending}
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending ? "Đang tải..." : "Chọn ảnh từ máy"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={PRODUCT_IMAGE_ACCEPT}
          className="hidden"
          data-testid="product-image-file"
          onChange={(e) => {
            handlePick(e.target.files?.[0])
            e.target.value = ""
          }}
        />
      </div>
      <p className="min-h-4 text-xs leading-4 text-destructive">{error}</p>
      {value && (
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt="Xem trước ảnh minh hoạ"
            className="h-24 max-w-full rounded-md border object-contain"
            onError={(e) => {
              e.currentTarget.style.display = "none"
            }}
            onLoad={(e) => {
              e.currentTarget.style.display = ""
            }}
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
            Xoá ảnh
          </Button>
        </div>
      )}
    </div>
  )
}
