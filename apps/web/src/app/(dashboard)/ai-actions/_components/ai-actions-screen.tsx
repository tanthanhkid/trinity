"use client"

import { Fragment, useState, useSyncExternalStore } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle, Bot, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { inboxDayLabel } from "@/components/inbox/inbox-ui"
import { todayVn, vnDateKey } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAiAction, useAiActionSettings, useAiActions, useAiActionsPendingCount } from "@/hooks/ai-actions/use-ai-actions"
import { isAiActionsDisabled, type AiAction } from "@/lib/ai-actions"
import { AiActionCard, AiActionRow } from "./ai-action-card"
import { AiActionDetailPanel, AiActionDetailScreen } from "./ai-action-detail"

type Tab = "pending" | "done"

function parseId(v: string | null): number | null {
  const n = v && /^\d{1,10}$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 2_147_483_647 ? n : null
}

/** Desktop = từ 1024px (hai bố cục KHÁC nhau, không co giãn một bố cục). Chưa biết (SSR) ⇒ điện thoại. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== "function") return () => {}
      const mql = window.matchMedia("(min-width: 1024px)")
      mql.addEventListener("change", cb)
      return () => mql.removeEventListener("change", cb)
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 1024px)").matches : window.innerWidth >= 1024),
    () => false,
  )
}

/**
 * Hoạt động AI: lịch sử thao tác AI đã thực hiện (của MÌNH). Mục "Chờ duyệt" + nút Duyệt/Từ chối CHỈ hiện khi quản trị bật
 * "Yêu cầu duyệt thay đổi do AI" (hoặc còn đề xuất cũ đang chờ). Mở thẳng một mục bằng `?id=` (link trong thông báo / từ AI).
 * FE chỉ hiển thị — BE kiểm quyền, kiểm chủ nháp, kiểm hạn, chạy thao tác thật.
 *
 * Giao diện «Ánh xanh»: desktop = danh sách trái + chi tiết phải (khối nhấn xanh ở đầu chi tiết);
 * điện thoại = đầu trang là khối nhấn có bộ lọc, danh sách thẻ, bấm một thẻ mở chi tiết toàn màn.
 */
export function AiActionsScreen() {
  const search = useSearchParams()
  const router = useRouter()
  const desktop = useIsDesktop()
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
  const list = useAiActions(tab, settingsReady)
  const rows = list.data?.pages.flatMap((p) => p.data) ?? []
  // Desktop luôn có một mục đang xem (mặc định mục đầu danh sách); điện thoại chỉ mở khi người dùng chọn / có `?id=`.
  const openId = localId ?? idParam ?? (desktop ? (rows[0]?.id ?? null) : null)
  const one = useAiAction(openId)
  const opened = openId === null ? null : (rows.find((r) => r.id === openId) ?? one.data ?? null)
  const fresh: AiAction | null = one.data && opened && one.data.id === opened.id ? one.data : opened
  const explicit = localId ?? idParam
  const closeDetail = () => { setLocalId(null); if (idParam !== null) router.replace("/ai-actions") }

  const subtitle = settings.data?.require_approval === true
    ? "ChatGPT và Claude chỉ đề xuất. Chỉ khi bạn bấm Duyệt, hệ thống mới thực hiện, theo đúng quyền của bạn."
    : "Các thay đổi ChatGPT và Claude đã thực hiện thay bạn, theo đúng quyền của bạn: ai làm gì, lúc nào, kết quả ra sao."
  const subtitleMobile = settings.data?.require_approval === true ? "AI chỉ đề xuất. Bạn duyệt thì hệ thống mới làm." : "Những gì AI đã làm thay bạn, theo đúng quyền của bạn."

  if (list.isError && isAiActionsDisabled(list.error)) {
    return (
      <div className="space-y-4">
        <h1 className="ax-text-title">Hoạt động AI</h1>
        <EmptyState variant="ax" icon={Bot} message="Tính năng Kết nối AI chưa được bật trên hệ thống này." />
      </div>
    )
  }

  const pendingBadge = pendingCount > 0 ? pendingCount.toLocaleString("vi-VN") : null
  const tabs = showPending && (
    <div
      role="group"
      aria-label="Lọc hoạt động"
      className={cn(
        "flex gap-1 p-1",
        desktop ? "rounded-[10px] bg-[var(--ax-line)]/60" : "grid grid-cols-2 rounded-xl bg-[rgba(13,32,54,.36)] p-[3px] shadow-[inset_0_0_0_1px_rgba(255,255,255,.16)]",
      )}
    >
      {(["pending", "done"] as const).map((t) => {
        const on = tab === t
        return (
          <button
            key={t}
            type="button"
            aria-pressed={on}
            onClick={() => { setTab(t); setLocalId(null) }}
            className={cn(
              "flex items-center justify-center gap-2 font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
              desktop ? "h-9 rounded-md px-3.5 text-sm" : "h-11 rounded-[9px] text-[15px]",
              on ? (desktop ? "bg-ax-surface text-ax-ink shadow-ax-card" : "bg-white text-ax-primary-ink") : desktop ? "text-ax-ink-2 hover:text-ax-ink" : "text-white",
            )}
          >
            {t === "pending" ? "Chờ duyệt" : "Tất cả"}
            {t === "pending" && pendingBadge && (desktop
              ? <span aria-hidden className="rounded-full bg-ax-warn-soft px-2 py-px text-[12px] font-bold text-ax-warn">{pendingBadge}</span>
              : <span aria-hidden>· {pendingBadge}</span>)}
          </button>
        )
      })}
    </div>
  )

  const today = todayVn()
  const days = rows.map((r) => vnDateKey(r.created_at))
  const daySep = (i: number) => {
    const day = days[i]
    return day && day !== (days.slice(0, i).reverse().find(Boolean) ?? "") ? inboxDayLabel(day, today) : null
  }

  const body = (
    <>
      {list.isLoading && <div className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-ax-card" />)}</div>}
      {list.isError && !isAiActionsDisabled(list.error) && (
        <p className="flex items-center gap-2 px-4 py-4 text-sm text-[var(--ax-danger-ink)]" role="alert"><AlertTriangle className="size-4" /> Không tải được hoạt động của AI. Vui lòng thử lại.</p>
      )}
      {list.isSuccess && rows.length === 0 && (
        <EmptyState
          variant="ax"
          icon={Bot}
          className={desktop ? "m-3" : "mx-4 my-12"}
          title={tab === "pending" ? "Không còn gì chờ bạn duyệt" : "Chưa có hoạt động nào của AI"}
          message={tab === "pending" ? "AI đề xuất thay đổi mới thì sẽ hiện ở đây." : "Khi ChatGPT hoặc Claude làm gì thay bạn, lịch sử sẽ hiện ở đây."}
        />
      )}
    </>
  )
  const more = list.hasNextPage && (
    <div className="flex justify-center border-t border-ax-divider p-3">
      <Button variant="ax-secondary" size="ax" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
        {list.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden />} Xem thêm
      </Button>
    </div>
  )
  const notFound = openId !== null && explicit !== null && one.isError && !opened && (
    <p className="ax-card px-4 py-4 text-sm text-[var(--ax-danger-ink)]" role="alert">Không tìm thấy mục #{openId} (có thể không phải của bạn).</p>
  )

  if (desktop) {
    return (
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="ax-text-title">Hoạt động AI</h1>
            <p className="mt-1 max-w-[640px] text-sm text-ax-ink-2">{subtitle}</p>
          </div>
          {tabs}
        </div>
        <div className="flex flex-wrap items-start gap-4">
          <section aria-label="Hoạt động của AI" className="ax-card min-w-0 flex-[1_1_400px] overflow-hidden lg:max-w-[520px]">
            {list.isSuccess && rows.length > 0 && (
              <p className="border-b border-ax-divider px-[18px] py-2 text-[13px] text-ax-ink-3">{rows.length.toLocaleString("vi-VN")}{list.hasNextPage ? "+" : ""} mục</p>
            )}
            {body}
            {rows.length > 0 && (
              <ol>
                {rows.map((a, i) => {
                  const sep = daySep(i)
                  return (
                    <Fragment key={a.id}>
                      {sep && <li aria-hidden className="ax-text-group border-t border-ax-divider px-[18px] pb-1 pt-3 first:border-t-0">{sep}</li>}
                      <AiActionRow action={a} current={a.id === openId} onOpen={() => setLocalId(a.id)} />
                    </Fragment>
                  )
                })}
              </ol>
            )}
            {more}
          </section>
          <div className="min-w-0 flex-[999_1_560px]">
            {notFound}
            {fresh ? (
              <AiActionDetailPanel key={fresh.id} action={fresh} />
            ) : !notFound && (
              <p className="ax-card ax-grad-empty px-7 py-20 text-center text-[15px] text-ax-ink-2">Chọn một mục bên trái để xem AI định làm gì.</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="-mx-4 -mt-4 pb-6 sm:-mx-5 sm:-mt-5">
      <header className="ax-grad-hero sticky top-0 z-10 border-b border-[var(--ax-hero-border)] px-4 pb-4 pt-[18px] text-white shadow-[var(--ax-shadow-hero)]">
        <h1 className="text-[28px] font-bold leading-[1.1] tracking-[-0.02em]">Hoạt động AI</h1>
        <p className={cn("mt-1.5 text-sm leading-snug text-[var(--ax-on-hero-ink-2)]", showPending && "mb-3.5")}>{subtitleMobile}</p>
        {tabs}
      </header>
      {body}
      {rows.length > 0 && (
        <ol className="flex flex-col gap-2.5 px-4 py-3">
          {rows.map((a, i) => {
            const sep = daySep(i)
            return (
              <Fragment key={a.id}>
                {sep && <li aria-hidden className="ax-text-group px-1 pt-2">{sep}</li>}
                <AiActionCard action={a} onOpen={() => setLocalId(a.id)} />
              </Fragment>
            )
          })}
        </ol>
      )}
      {more}
      {notFound && <div className="px-4">{notFound}</div>}
      {fresh && explicit !== null && <AiActionDetailScreen key={fresh.id} action={fresh} onBack={closeDetail} />}
    </div>
  )
}
