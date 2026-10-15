import type { Metadata } from "next"
import { Storefront } from "./storefront"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Cửa hàng", robots: { index: true, follow: true } }

export default async function StorePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <Storefront slug={slug} />
}
