"use client"

import { Fragment, type ReactNode } from "react"
import Link from "next/link"
import { Loader2, SearchX, TriangleAlert } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { useCustomObjectDef } from "@/hooks/custom-objects/use-custom-objects"
import { getApiErrorMessage } from "@/lib/api-client"
import type { CustomObjectDef } from "@/types/custom-objects"
import { LoadingBlock } from "@/components/ui/loading-block"

/**
 * Nạp định nghĩa tính năng theo khoá trên URL rồi render `children(def)`. 404 (không tồn tại / vai trò của bạn không được
 * thấy / đã tắt) → màn "không tìm thấy" — BE không phân biệt các lý do này để khỏi lộ sự tồn tại.
 */
export function CustomObjectGate({ objectKey, children }: { objectKey: string; children: (def: CustomObjectDef) => ReactNode }) {
  const q = useCustomObjectDef(objectKey)
  if (q.isLoading) return <LoadingBlock className="mx-auto max-w-3xl p-6" count={4} avatar />
  if (q.isError && (q.error as { response?: { status?: number } })?.response?.status !== 404) {
    return (
      <ShellEmptyState
        icon={TriangleAlert}
        title="Không tải được tính năng này"
        description={getApiErrorMessage(q.error, "Vui lòng thử lại sau")}
        action={<Button variant="outline" onClick={() => void q.refetch()}>Thử lại</Button>}
      />
    )
  }
  if (q.isError || !q.data) {
    return (
      <ShellEmptyState
        icon={SearchX}
        title="Không tìm thấy tính năng này"
        description="Tính năng không tồn tại, đã bị tắt, hoặc vai trò của bạn không được phép xem."
        action={<Link href="/dashboard" className={buttonVariants({ variant: "outline" }) + " max-sm:min-h-11"}>Về Tổng quan</Link>}
      />
    )
  }
  // key theo khoá tính năng: chuyển /x/a → /x/b phải làm mới TOÀN BỘ trạng thái màn (sắp xếp/lọc của a không áp sang b).
  return <Fragment key={q.data.key}>{children(q.data)}</Fragment>
}
