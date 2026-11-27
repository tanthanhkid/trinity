"use client"

import { useEffect, useState } from "react"
import { useParams, usePathname } from "next/navigation"

/** `true` khi dựng bằng `pnpm build:export` (next.config.ts đặt biến này); bản `standalone` luôn `false`. */
export const STATIC_EXPORT = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1"

/**
 * Giá trị giữ chỗ trong bản xuất tĩnh: mỗi route động xuất ra MỘT trang với mọi đoạn động là `_`
 * (`generateStaticParams`), Rust trả trang đó cho mọi giá trị (R004, phương án A).
 */
export const ROUTE_PLACEHOLDER = "_"

/**
 * Khớp `pathname` với mẫu như `/contacts/:id`, `/x/:objectKey/v/:viewKey`. Đoạn `:tên` lấy giá trị thật (giữ nguyên
 * dạng mã hoá phần trăm như `usePathname()`); đoạn khác phải trùng chữ. Không khớp ⇒ `null`.
 */
export function matchRouteParams(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean)
  const got = pathname.split("/").filter(Boolean)
  if (want.length !== got.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) out[want[i].slice(1)] = got[i]
    else if (want[i] !== got[i]) return null
  }
  return out
}

/**
 * Tham số của route động, dùng được ở cả hai bản dựng.
 *  - `standalone`: đúng `useParams()` như trước (không đổi hành vi).
 *  - bản xuất tĩnh: HTML là trang giữ chỗ nên `useParams()` chỉ trả `_`; đọc từ `usePathname()` và CHỈ sau khi mount
 *    (đọc lúc vẽ gây lỗi hydrate React #418). Trước khi mount trả `null`: trang hiện khung chờ.
 */
export function useRouteParams<K extends string>(pattern: string): Record<K, string> | null {
  const nextParams = useParams()
  const pathname = usePathname()
  const [mounted, setMounted] = useState(!STATIC_EXPORT)
  useEffect(() => setMounted(true), [])
  if (!STATIC_EXPORT) return nextParams as unknown as Record<K, string>
  if (!mounted) return null
  return matchRouteParams(pattern, pathname) as Record<K, string> | null
}
