import type { Metadata } from "next"
import { StoreRoute } from "./store-route"

export const metadata: Metadata = { title: "Cửa hàng", robots: { index: true, follow: true } }

/** Bản xuất tĩnh: một trang giữ chỗ `_` (R004); `standalone` vẫn dựng theo yêu cầu cho mọi slug. */
export function generateStaticParams() {
  return [{ slug: "_" }]
}

export default async function StorePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <StoreRoute slug={slug} />
}
