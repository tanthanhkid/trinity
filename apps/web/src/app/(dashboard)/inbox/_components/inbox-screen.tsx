"use client"

import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Inbox, Settings2 } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { useAuth } from "@/hooks/use-auth"
import { useOrgFeatures } from "@/hooks/use-org-features"
import { usePermissions } from "@/lib/rbac"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button-variants"
import { ZaloOaInbox } from "@/app/(dashboard)/settings/_components/integrations/zalo-oa/zalo-oa-inbox"
import { FacebookInbox } from "@/app/(dashboard)/settings/_components/integrations/facebook-inbox"
import { useSocialAccounts } from "@/hooks/use-social"
import { can } from "@trinity/rbac"
import { AllInbox } from "./all-inbox"
import { GoogleReviewsInbox } from "./google-reviews-inbox"
import { InteractionsView, type Interaction } from "./interactions-view"
import { INBOX_TAB_LABEL, INBOX_TAB_PARAM, inboxChannels, inboxTabs, pickInboxTab, type InboxTab } from "./inbox-access"

/** Khung 3 cột chiếm gần hết chiều cao màn hình (trừ topbar + tiêu đề). */
const FRAME = "h-[calc(100dvh-11.25rem)] max-h-none min-h-[480px] md:h-[calc(100dvh-10.75rem)]" // +1.25rem: pt-5 của <main> (#29)

/** Tab kênh ở đầu cột danh sách — cùng kiểu tab nhanh của màn Khách hàng. */
function ChannelTabs({ tabs, active, onPick }: { tabs: readonly InboxTab[]; active: InboxTab; onPick: (t: InboxTab) => void }) {
  if (tabs.length < 2) return null
  return (
    <div className="border-b border-[var(--border)] px-3 pt-2 pb-2">
      <div role="tablist" aria-label="Kênh" className="flex items-center gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={active === t}
            onClick={() => onPick(t)}
            className={cn(
              "relative h-9 shrink-0 whitespace-nowrap rounded-md px-2.5 text-sm font-medium transition-colors duration-150 ease-out max-sm:h-11",
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20",
              "after:absolute after:inset-x-2 after:-bottom-2 after:h-0.5 after:rounded-full after:transition-opacity after:duration-150",
              active === t ? "text-foreground after:bg-foreground after:opacity-100" : "text-muted-foreground after:opacity-0 hover:text-foreground",
            )}
          >
            {INBOX_TAB_LABEL[t]}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Hộp thư — mục riêng trên sidebar (trước đây chỉ nằm trong Cài đặt > Kết nối & AI, đường cũ vẫn giữ).
 * Kênh hiện theo ĐÚNG quyền + công tắc của hai hộp thư sẵn có (`inboxChannels`); không API mới.
 * Tab "Tất cả" gộp hai kênh ở phía client; tab Zalo / Facebook dùng nguyên màn hộp thư của từng kênh.
 */
export function InboxScreen() {
  const { isLoading } = useAuth()
  const { grants, canAny } = usePermissions()
  const { features } = useOrgFeatures()
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const canSocial = can(grants, "social.post") && !(features && features.social_posting === false)
  const social = useSocialAccounts(canSocial)
  const googleAccounts = (social.data ?? []).filter((a) => a.network === "google_business" && a.status === "active")
  const tabs = inboxTabs(inboxChannels(grants, features, { hasGoogle: googleAccounts.length > 0 }))
  const active = pickInboxTab(params.get("kenh"), tabs)
  const canSettings = canAny("integrations.webhooks", "contacts.update")

  const pick = (t: InboxTab) => router.replace(`${pathname}?kenh=${INBOX_TAB_PARAM[t]}`, { scroll: false })
  const openId = Number(params.get("hoi_thoai")) || null
  const openConversation = (i: Interaction) => {
    const id = i.ref.conversation_id ?? i.ref.thread_id
    router.push(`${pathname}?kenh=${i.channel === "zalo" ? "zalo" : "facebook"}${id ? `&hoi_thoai=${id}` : ""}`, { scroll: false })
  }

  if (isLoading) return <Skeleton className="h-96 rounded-[var(--radius)]" />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-foreground">Tương tác</h1>
          <p className="text-[13px] text-muted-foreground">Bình luận Fanpage, tin nhắn Messenger và Zalo OA{googleAccounts.length > 0 ? ", đánh giá Google" : ""} ở một chỗ, trả lời ngay tại đây.</p>
        </div>
        {canSettings && active !== null && (
          <Link href="/connections" className={cn(buttonVariants({ variant: "outline" }), "ml-auto max-sm:h-11")}>
            <Settings2 className="size-4" aria-hidden />
            Kết nối kênh
          </Link>
        )}
      </div>

      {active === null ? (
        <EmptyState icon={Inbox} message={canSocial ? "Chưa có kênh nào để hiện ở đây. Liên kết địa điểm Google Business ở Đăng đa kênh › Kênh để đọc và trả lời đánh giá Google." : "Bạn chưa có quyền xem hộp thư Zalo OA hay Messenger."} />
      ) : active === "interactions" ? (
        <InteractionsView key="interactions" tabs={<ChannelTabs tabs={tabs} active={active} onPick={pick} />} onOpenConversation={openConversation} />
      ) : active === "all" ? (
        <AllInbox key="all" className={FRAME} listTop={<ChannelTabs tabs={tabs} active={active} onPick={pick} />} />
      ) : active === "google" ? (
        <GoogleReviewsInbox key="google" accounts={googleAccounts} className={FRAME} listTop={<ChannelTabs tabs={tabs} active={active} onPick={pick} />} />
      ) : active === "zalo" ? (
        <ZaloOaInbox key={`zalo-${openId ?? ""}`} initialOpenId={openId} className={FRAME} listTop={<ChannelTabs tabs={tabs} active={active} onPick={pick} />} />
      ) : (
        <FacebookInbox key={`facebook-${openId ?? ""}`} initialOpenId={openId} className={FRAME} listTop={<ChannelTabs tabs={tabs} active={active} onPick={pick} />} />
      )}
    </div>
  )
}
