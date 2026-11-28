"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsIntegrations, sectionFromParams } from "@/app/(dashboard)/settings/_components/settings-integrations"

/** Tiêu đề trang tổng; mục Fanpage Facebook tự có breadcrumb + tiêu đề riêng theo thiết kế «Ánh xanh». */
function ConnectionsHeader() {
  const params = useSearchParams()
  if (sectionFromParams(new URLSearchParams(params.toString())) === "facebook") return null
  return (
    <div>
      <h1 className="ax-text-title">Kết nối</h1>
      <p className="mt-1 text-sm text-ax-ink-2">Trợ lý AI, Fanpage, Zalo OA, thanh toán và các kết nối dữ liệu của công ty.</p>
    </div>
  )
}

/**
 * Kết nối (menu chính): trợ lý AI, kênh khách, thanh toán, bán hàng, dữ liệu & tự động, nhật ký — gom một chỗ, nhóm theo loại.
 * Trang Cài đặt cũ (`/settings?tab=integrations…`, cả tham số quay về từ OAuth) chuyển hướng về đây.
 */
export default function ConnectionsPage() {
  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-5">
      <Suspense fallback={null}>
        <ConnectionsHeader />
      </Suspense>
      <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
        <SettingsIntegrations />
      </Suspense>
    </div>
  )
}
