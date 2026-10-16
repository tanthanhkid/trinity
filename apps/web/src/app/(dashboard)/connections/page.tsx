"use client"

import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsIntegrations } from "@/app/(dashboard)/settings/_components/settings-integrations"

/**
 * Kết nối (menu chính): trợ lý AI, kênh khách, thanh toán, bán hàng, dữ liệu & tự động, nhật ký — gom một chỗ, nhóm theo loại.
 * Trang Cài đặt cũ (`/settings?tab=integrations…`, cả tham số quay về từ OAuth) chuyển hướng về đây.
 */
export default function ConnectionsPage() {
  return (
    <div className="mx-auto w-full max-w-[1120px] space-y-5 pt-2 md:pt-5">
      <div>
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight">Kết nối</h1>
        <p className="mt-1 text-sm text-muted-foreground">Trợ lý AI, Fanpage, Zalo OA, thanh toán, phần mềm bán hàng và các kết nối dữ liệu của công ty.</p>
      </div>
      <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
        <SettingsIntegrations />
      </Suspense>
    </div>
  )
}
