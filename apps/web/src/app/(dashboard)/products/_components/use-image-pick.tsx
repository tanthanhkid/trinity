"use client"

/** Chọn / chụp ảnh sản phẩm: kiểm file, tải lên (`POST /products/upload-image`), trả URL qua `onUrl`. */
import { useRef, useState } from "react"
import { toast } from "sonner"
import { useUploadProductImage } from "@/hooks/products/use-products"
import { errorMessage } from "@/lib/error-messages"
import { PRODUCT_IMAGE_ACCEPT, validateProductImageFile } from "./product-image-field"

export function useImagePick(onUrl: (url: string) => void, opts: { capture?: boolean; testId?: string } = {}) {
  const ref = useRef<HTMLInputElement>(null)
  const upload = useUploadProductImage()
  const [error, setError] = useState("")

  function handle(file: File | undefined) {
    if (!file) return
    const invalid = validateProductImageFile(file)
    if (invalid) {
      setError(invalid)
      toast.error(invalid)
      return
    }
    setError("")
    upload.mutate(file, {
      onSuccess: onUrl,
      onError: (err) => {
        const text = errorMessage(err, "Chưa tải ảnh lên được")
        setError(text)
        toast.error(text)
      },
    })
  }

  const input = (
    <input
      ref={ref}
      type="file"
      accept={PRODUCT_IMAGE_ACCEPT}
      {...(opts.capture ? { capture: "environment" as const } : {})}
      className="hidden"
      data-testid={opts.testId ?? "product-image-file"}
      onChange={(e) => {
        handle(e.target.files?.[0])
        e.target.value = ""
      }}
    />
  )
  return { input, open: () => ref.current?.click(), uploading: upload.isPending, error }
}
