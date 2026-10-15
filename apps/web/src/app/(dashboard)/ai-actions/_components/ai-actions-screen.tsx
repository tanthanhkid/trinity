"use client"

import { Fragment, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle, Bot, Loader2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { inboxDayLabel } from "@/components/inbox/inbox-ui"
import { todayVn, vnDateKey } from "@/lib/format"
import { cn } from "@/lib/utils"
import { BOX } from "@/app/(dashboard)/dashboard/_components/home-box"
import { useAiAction, useAiActionSettings, useAiActions, useAiActionsPendingCount } from "@/hooks/ai-actions/use-ai-actions"
import { isAiActionsDisabled } from "@/lib/ai-actions"
import { AiActionCard } from "./ai-action-card"
import { AiActionDialog } from "./ai-action-dialog"

type Tab = "pending" | "done"

function parseId(v: string | null): number | null {
  const n = v && /^\d{1,10}$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 2_147_483_647 ? n : null
}

/**
 * Hoạt động AI: lịch sử thao tác AI đã thực hiện (của MÌNH). Mục "Chờ duyệt" + nút Duyệt/Từ chối CHỈ hiện khi quản trị bật
 * "Yêu cầu duyệt thay đổi do AI" (hoặc còn đề xuất cũ đang chờ). Mở thẳng một mục bằng `?id=` (link trong thông báo / từ AI).
 * FE chỉ hiển thị — BE kiểm quyền, kiểm chủ nháp, kiểm hạn, chạy thao tác thật.
 */
export function AiActionsScreen() {
  const search = useSearchParams()
  const router = useRouter()
  const idParam = parseId(search.get("id"))
  const settings = useAiActionSettings()
  const pendingCount = useAiActionsPendingCount().data ?? 0
  // Chờ duyệt chỉ hiện khi bật chế độ duyệt, hoặc còn đề xuất cũ chưa xử lý. Chờ cài đặt tải xong mới chọn tab mặc định (tránh nháy).
  const settingsReady = settings.isSuccess || settings.isError
  const showPending = settings.data?.require_approval === true || pendingCount > 0
  const [pickedTab, setTab] = useState<Tab | null>(null)
  const tab: Tab = pickedTab ?? (showPending ? "pending" : "done")
  // Đề xuất mở từ danh sách (`localId`) ƯU TIÊN; không thì theo `?id=` (điều hướng mềm từ thông báo đổi `idParam` mà không remount).
  const [localId, setLocalId] = useState<number | null>(null)
  const openId = localId ?? idParam
  const setOpenId = setLocalId
  const list = useAiActions(tab, settingsReady)
  const one = useAiAction(openId)
  const rows = list.data?.pages.flatMap((p) => p.data) ?? []
  const opened = openId === null ? null : (rows.find((r) => r.id === openId) ?? one.data ?? null)
  const fresh = one.data && opened && one.data.id === opened.id ? one.data : opened

  const header = (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-foreground">Hoạt động AI</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">
        {settings.data?.require_approval === true
          ? "ChatGPT/Claude chỉ tạo đề xuất. Chỉ khi bạn bấm Duyệt, hệ thống mới thực hiện — theo đúng quyền của bạn."
          : "Các thay đổi ChatGPT/Claude đã thực hiện thay bạn, theo đúng quyền của bạn: ai làm gì, lúc nào, kết quả ra sao."}
      </p>
    </div>
  )

  if (list.isError && isAiActionsDisabled(list.error)) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={Bot} message="Tính năng Kết nối AI chưa được bật trên hệ thống này." />
      </div>
    )
  }

  const tabBtn = (t: Tab) =>
    cn(
      "h-9 shrink-0 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition max-sm:h-11",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
      tab === t ? "bg-[var(--muted)] text-foreground" : "text-muted-foreground hover:bg-[var(--muted)] hover:text-foreground",
    )
  const today = todayVn()
  const days = rows.map((r) => vnDateKey(r.created_at))

  return (
    <div className="space-y-4">
      {header}

      <section aria-label="Hoạt động của AI" className={cn(BOX, "overflow-hidden")}>
        <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2.5 sm:px-4">
          {showPending ? (
            <div className="flex items-center gap-1" role="group" aria-label="Lọc hoạt động">
              <button type="button" className={tabBtn("pending")} aria-pressed={tab === "pending"} onClick={() => setTab("pending")}>
                Chờ duyệt
                {pendingCount > 0 && (
                  <span aria-hidden className="ml-1.5 rounded-full bg-[var(--color-app-tag-amber-bg)] px-1.5 text-sm tabular-nums text-[var(--color-app-tag-amber-ink)]">{pendingCount}</span>
                )}
              </button>
              <button type="button" className={tabBtn("done")} aria-pressed={tab === "done"} onClick={() => setTab("done")}>Tất cả</button>
            </div>
          ) : (
            <h2 className="flex items-center gap-2 px-1 text-[15px] font-semibold text-foreground">
              <Sparkles className="size-4 text-[var(--ring)]" aria-hidden /> Lịch sử thao tác của AI
            </h2>
          )}
          {list.isSuccess && rows.length > 0 && (
            <span className="ml-auto text-sm text-muted-foreground">{rows.length.toLocaleString("vi-VN")}{list.hasNextPage ? "+" : ""} mục</span>
          )}
        </header>

        {list.isLoading && (
          <div className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
        )}
        {list.isError && !isAiActionsDisabled(list.error) && (
          <p className="flex items-center gap-2 px-4 py-4 text-sm text-[var(--color-app-tag-red-ink)]" role="alert"><AlertTriangle className="size-4" /> Không tải được hoạt động của AI. Vui lòng thử lại.</p>
        )}
        {list.isSuccess && rows.length === 0 && (
          <EmptyState icon={Bot} message={tab === "pending" ? "Không có thay đổi nào đang chờ bạn duyệt." : "Chưa có hoạt động nào của AI."} />
        )}

        {rows.length > 0 && (
          <ol className="py-1.5">
            {rows.map((a, i) => {
              const day = days[i]
              const sep = day && day !== (days.slice(0, i).reverse().find(Boolean) ?? "")
              return (
                <Fragment key={a.id}>
                  {sep && <li aria-hidden className="px-4 pb-1 pt-3 text-sm font-medium text-muted-foreground">{inboxDayLabel(day, today)}</li>}
                  <AiActionCard action={a} onOpen={() => setOpenId(a.id)} />
                </Fragment>
              )
            })}
          </ol>
        )}
        {list.hasNextPage && (
          <div className="flex justify-center border-t border-[var(--border)] p-3">
            <Button variant="outline" className="text-sm max-sm:h-11" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden />} Xem thêm
            </Button>
          </div>
        )}
      </section>

      {openId !== null && one.isError && !opened && (
        <p className={cn(BOX, "px-4 py-4 text-sm text-[var(--color-app-tag-red-ink)]")} role="alert">Không tìm thấy mục #{openId} (có thể không phải của bạn).</p>
      )}
      {fresh && <AiActionDialog key={fresh.id} action={fresh} onClose={() => { setLocalId(null); if (idParam !== null) router.replace("/ai-actions") }} />}
    </div>
  )
}
