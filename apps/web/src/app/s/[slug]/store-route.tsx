"use client"

import { useEffect, useState } from "react"
import { STATIC_EXPORT, ROUTE_PLACEHOLDER, useRouteParams } from "@/lib/route-params"
import { Storefront } from "./storefront"

/**
 * Slug cửa hàng, dùng được ở cả hai bản dựng.
 *  - `standalone`: từ `params` của máy chủ như trước.
 *  - bản xuất tĩnh: đoạn `/s/<slug>` đọc từ đường dẫn sau khi mount. Qua tên miền phụ (URL là `/`) đường dẫn không có slug:
 *    Rust phục vụ trang `s/_` và chèn `<meta name="store-slug" content="<slug>">` vào HTML; đọc thẻ này lúc vẽ gây lỗi hydrate
 *    nên cũng chỉ đọc sau mount (R004).
 */
export function StoreRoute({ slug }: { slug: string }) {
  const route = useRouteParams<"slug">("/s/:slug")
  const [meta, setMeta] = useState<string | null>(null)
  useEffect(() => {
    if (!STATIC_EXPORT) return
    setMeta(document.querySelector('meta[name="store-slug"]')?.getAttribute("content")?.trim() || "")
  }, [])
  if (!STATIC_EXPORT) return <Storefront slug={slug} />
  const fromPath = route?.slug && route.slug !== ROUTE_PLACEHOLDER ? decodeURIComponent(route.slug) : ""
  const resolved = fromPath || meta
  if (!resolved) return null
  return <Storefront slug={resolved} />
}
