"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import type { ComponentProps, FocusEvent, MouseEvent } from "react"

/**
 * `<Link>` không prefetch hàng loạt: mặc định Next tải trước RSC/HTML của MỌI link trong khung nhìn
 * (menu có ~20 mục ⇒ ~22 request mỗi trang). Ở đây chỉ prefetch khi rê chuột / focus bàn phím vào mục,
 * nên chuyển menu vẫn nhanh mà trang lạnh không bị gánh.
 */
export function HoverLink({ href, onMouseEnter, onFocus, prefetch: _ignored, ...rest }: ComponentProps<typeof Link>) {
  // Test/Storybook không có App Router: useRouter ném lỗi ⇒ bỏ prefetch, link vẫn chạy.
  let router: ReturnType<typeof useRouter> | null = null
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    router = useRouter()
  } catch {
    router = null
  }
  const warm = () => {
    if (typeof href !== "string" || !href.startsWith("/")) return
    try {
      router?.prefetch(href)
    } catch {
      /* prefetch chỉ là tối ưu */
    }
  }
  return (
    <Link
      href={href}
      prefetch={false}
      onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) => {
        warm()
        onMouseEnter?.(e)
      }}
      onFocus={(e: FocusEvent<HTMLAnchorElement>) => {
        warm()
        onFocus?.(e)
      }}
      {...rest}
    />
  )
}
