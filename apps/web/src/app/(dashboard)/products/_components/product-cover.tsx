"use client"

/**
 * Ảnh minh hoạ sản phẩm — card + drawer đọc `product.image_url`.
 * Trước đây 2 nơi này KHÔNG render `image_url` dù đã lưu đúng ở DB/form.
 * Dùng `<img>` thường (như ô xem trước ở form): URL có thể là `/uploads/...`
 * (proxy nội bộ) hoặc URL ngoài — `next/image` sẽ bắt khai `remotePatterns`.
 * Ảnh lỗi/chưa có → khối chữ cái đầu theo màu sản phẩm (không để trống trơn).
 */
import { useState } from "react"
import { cn } from "@/lib/utils"
import type { Product } from "@/types/product"

export function ProductCover({
  product,
  className,
}: {
  product: Pick<Product, "image_url" | "name" | "brand" | "color">
  className?: string
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const url = product.image_url?.trim() || null
  const showImage = !!url && failedUrl !== url

  return (
    <div
      className={cn("relative overflow-hidden bg-[var(--color-app-surface-2)]", className)}
      data-testid="product-cover"
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={`Ảnh minh hoạ ${product.name}`}
          loading="lazy"
          className="size-full object-cover"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span
          // Không có màu riêng ⇒ nền xám nhạt + chữ xám (giao diện mới), thay khối xanh đặc cũ.
          className={cn(
            "grid size-full place-items-center text-3xl font-semibold",
            product.color ? "text-white" : "bg-[var(--muted)] text-muted-foreground",
          )}
          style={product.color ? { backgroundColor: product.color } : undefined}
          aria-hidden
        >
          {(product.brand ?? product.name).slice(0, 2).toUpperCase()}
        </span>
      )}
    </div>
  )
}
