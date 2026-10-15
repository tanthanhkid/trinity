"use client"

import { use, useEffect } from "react"
import { useQuery, useInfiniteQuery } from "@tanstack/react-query"
import { Button, buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Phone, ArrowRight, MessageSquare, Mail, Loader2, ShieldOff, AlertCircle, RefreshCcw } from "lucide-react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import axios from "axios"
import apiClient from "@/lib/api-client"
import { formatPhone, formatTimeVn, todayVn, vnDateKey } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ShellAvatar } from "@/components/app-shell/avatar"
import { inboxDayLabel } from "@/components/inbox/inbox-ui"
import { BOX } from "@/app/(dashboard)/dashboard/_components/home-box"
import { StagePill } from "@/app/(dashboard)/contacts/_components/contact-row"
import { useAuth } from "@/hooks/use-auth"
import { Forbidden, usePermissions } from "@/lib/rbac"
import { useMarkContactViewed } from "@/hooks/use-mark-contact-viewed"
import { ZaloPhoneLink } from "@/components/zalo-phone-link"
import { ZaloActions } from "@/components/zalo-actions"
import { ContactInfoForm, type ContactData } from "./_components/contact-info-form"
import { ReassignContactSaleButton } from "./_components/reassign-contact-sale"
import { LeadScoreCard, type LeadReason } from "./_components/lead-score-card"
import type { LeadLabel } from "@/components/lead-score-badge"
import { ContactKanbanTab } from "@/components/kanban/contact-kanban-tab"
import { RecordCode } from "@/components/custom-objects/record-code"
import { MentionedIn } from "@/components/refs/mentioned-in"
import { MentionText } from "@/components/refs/mention-text"

interface ContactDetail extends ContactData {
  /** Mã chung KH001… — gắn thẻ @ ở màn khác. */
  code?: string | null
  stage?: string
  stage_source?: string
  /** Mã bền của giai đoạn (màu chấm theo mã, không theo nhãn). */
  stage_option?: { id: number; value: string; label: string } | null
  /** Điểm lead — null = chưa chấm. */
  lead_score?: number | null
  lead_label?: LeadLabel | null
  lead_score_reasons?: LeadReason[] | null
  lead_scored_at?: string | null
  /** Thời điểm khởi tạo danh bạ, hiển thị kèm giờ:phút:giây ở chi tiết. */
  created_at?: string | null
  assigned_user?: { full_name: string; email?: string | null } | null
  team?: { name: string } | null
  creator?: {
    id: number
    full_name: string
    email: string
  } | null
  activities?: Array<{
    id: number
    action: string
    details: Record<string, unknown> | null
    created_by: number | null
    created_at: string
  }>
}
interface Activity { id: number; action: string; details: Record<string, unknown> | null; created_at: string }
interface ActivitiesPage { data: Activity[]; next_cursor: string | null }

const activityIcon: Record<string, typeof Phone> = {
  call: Phone, stage_change: ArrowRight, note: MessageSquare, email: Mail,
}
function activityText(a: Activity): string {
  const desc = a.details && typeof a.details === "object"
    ? (a.details as { description?: unknown }).description
    : undefined
  return typeof desc === "string" && desc.length > 0 ? desc : a.action
}

/** Tab trong trang — cùng kiểu tab nhanh của màn Khách hàng (nền xám khi chọn, không gạch chân). */
const TAB =
  "h-9 flex-none rounded-lg px-3 text-sm after:hidden data-active:bg-[var(--muted)] data-active:text-foreground hover:bg-[var(--muted)] max-sm:h-11 dark:data-active:bg-[var(--muted)]"

/**
 * Lịch sử thao tác dạng dòng thời gian như Trang chủ: vạch ngày · giờ · biểu tượng · nội dung.
 * Ghi chú vẫn qua `MentionText` (gắn thẻ @), còn lại là text node.
 */
function ActivityTimeline({ items }: { items: Activity[] }) {
  const today = todayVn()
  const days = items.map((a) => vnDateKey(a.created_at))
  return (
    <ol className="py-1.5">
      {items.map((a, i) => {
        const Icon = activityIcon[a.action] ?? MessageSquare
        const day = days[i]
        // Vạch ngày khi khác ngày của mục đứng trước (bỏ qua mục không có ngày hợp lệ).
        const sep = day && day !== (days.slice(0, i).reverse().find(Boolean) ?? "")
        return (
          <li key={a.id}>
            {sep && (
              <p className="px-4 pb-1 pt-3 text-sm font-medium text-muted-foreground">{inboxDayLabel(day, today)}</p>
            )}
            <div className="grid grid-cols-[44px_28px_minmax(0,1fr)] items-start gap-2.5 px-4 py-2.5 hover:bg-[var(--muted)] sm:grid-cols-[52px_28px_minmax(0,1fr)]">
              <time dateTime={a.created_at} className="pt-1 text-sm tabular-nums text-muted-foreground">{formatTimeVn(a.created_at)}</time>
              <span className="grid size-7 place-items-center rounded-full border border-[var(--border)] bg-[var(--card)]">
                <Icon className="size-3.5 text-muted-foreground" aria-hidden />
              </span>
              <p className="min-w-0 break-words pt-0.5 text-sm font-medium leading-snug text-foreground">
                {a.action === "note" ? <MentionText text={activityText(a)} /> : activityText(a)}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function ContactDetailError({
  id,
  status,
  onRetry,
}: {
  id: string
  status?: number
  onRetry: () => void
}) {
  if (status === 403) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <ShieldOff className="h-12 w-12 text-muted-foreground" />
        <div>
          <p className="text-lg font-semibold">Không có quyền truy cập</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Bạn không có quyền xem khách hàng này. Vui lòng liên hệ quản trị viên.
          </p>
        </div>
        <Link href="/contacts" className={buttonVariants({ variant: "outline" })}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Quay lại khách hàng
        </Link>
      </div>
    )
  }
  if (status === 404) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <div>
          <p className="text-lg font-semibold">Không tìm thấy khách hàng</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Khách hàng #{id} đã bị xoá hoặc không tồn tại.
          </p>
        </div>
        <Link href="/contacts" className={buttonVariants({ variant: "outline" })}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Quay lại khách hàng
        </Link>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <AlertCircle className="h-12 w-12 text-destructive" />
      <div>
        <p className="text-lg font-semibold">Lỗi tải dữ liệu</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Đã xảy ra lỗi khi tải thông tin khách hàng. Vui lòng thử lại.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="default" onClick={onRetry}>
          <RefreshCcw className="mr-2 h-4 w-4" /> Thử lại
        </Button>
        <Link href="/contacts" className={buttonVariants({ variant: "outline" })}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Quay lại khách hàng
        </Link>
      </div>
    </div>
  )
}

/**
 * Cổng quyền vào chi tiết khách hàng (`contacts.view`): chờ `/auth/me` xong rồi xét
 * `contacts.view`; thiếu quyền → `<Forbidden />`. BE vẫn là tuyến chặn thật
 * (khách ngoài phạm vi → 404).
 */
export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { isLoading } = useAuth()
  const { can } = usePermissions()
  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />
  if (!can("contacts.view")) return <Forbidden message="Cần quyền Xem khách hàng." />
  return <ContactDetailContent params={params} />
}

function ContactDetailContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const { data: contact, isLoading, isError, error: contactError, refetch: refetchContact } = useQuery<ContactDetail, unknown>({
    queryKey: ["contact", id],
    queryFn: async () => (await apiClient.get<ContactDetail>(`/contacts/${id}`)).data,
  })

  // "Khách gần đây" ở sidebar — ghi nhận 1 lần mỗi khi id đổi.
  // `markViewed.mutate` ổn định giữa các render (React Query) nên bỏ qua deps
  // an toàn (KHÔNG cần useRef — không phải callback prop truyền từ ngoài vào).
  const markViewed = useMarkContactViewed()
  useEffect(() => {
    const numericId = Number(id)
    if (Number.isFinite(numericId) && numericId > 0) {
      markViewed.mutate(numericId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const activitiesQuery = useInfiniteQuery<ActivitiesPage, Error>({
    queryKey: ["contact-activities", id],
    queryFn: async ({ pageParam }) => {
      const p: Record<string, string> = { limit: "20" }
      if (pageParam) p.cursor = String(pageParam)
      return (await apiClient.get<ActivitiesPage>(`/contacts/${id}/activities`, { params: p })).data
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })

  const allActivities = activitiesQuery.data?.pages.flatMap((p) => p.data) ?? []

  if (isLoading) return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-64" /><Skeleton className="h-6 w-32" /><Skeleton className="h-96 w-full" />
    </div>
  )

  if (isError) {
    const status = axios.isAxiosError(contactError)
      ? contactError.response?.status
      : undefined
    return <ContactDetailError id={id} status={status} onRetry={refetchContact} />
  }

  if (!contact) return (
    <ContactDetailError id={id} status={404} onRetry={refetchContact} />
  )

  const stagePill = {
    stage: contact.stage ?? "Mới",
    stage_source: contact.stage_source === "stage" ? ("stage" as const) : ("default" as const),
    stage_option: contact.stage_option ?? null,
  }

  return (
    <div className="space-y-4">
      {/* Thanh tiêu đề gọn (breadcrumb đã nằm ở topbar): quay lại · avatar · tên + mã + giai đoạn · SĐT · hành động. */}
      <section aria-label="Thông tin chính" className={cn(BOX, "flex flex-wrap items-start gap-3 p-3 sm:items-center sm:gap-4 sm:p-4")}>
        <Link
          href="/contacts"
          aria-label="Quay lại khách hàng"
          title="Quay lại khách hàng"
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--input)] text-muted-foreground transition hover:bg-[var(--muted)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] max-sm:size-11"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <ShellAvatar name={contact.full_name || contact.phone} size="lg" className="!rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="min-w-0 break-words text-[22px] font-semibold leading-tight tracking-tight text-foreground">
              {contact.full_name || formatPhone(contact.phone)}
            </h1>
            <RecordCode code={contact.code} className="text-sm" />
            <StagePill c={stagePill} />
          </div>
          {/* SĐT hiển thị ĐÚNG chuỗi BE trả (BE che theo `contacts.phone_full`) —
              FE KHÔNG tự che theo vai trò. */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
            <ZaloPhoneLink phone={contact.phone} className="text-muted-foreground max-sm:inline-flex max-sm:min-h-11 max-sm:items-center" />
            {contact.assigned_user?.full_name && <span>Phụ trách: {contact.assigned_user.full_name}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
          <ZaloActions phone={contact.phone} />
          <ReassignContactSaleButton
            contactId={id}
            contactName={contact.full_name}
            assignedTo={contact.assigned_to}
            assigneeName={contact.assigned_user?.full_name ?? null}
          />
        </div>
      </section>

      <LeadScoreCard
        contactId={id}
        score={contact.lead_score}
        label={contact.lead_label}
        reasons={contact.lead_score_reasons}
        scoredAt={contact.lead_scored_at}
      />

      <Tabs defaultValue="info" className="gap-3">
        <TabsList variant="line" className="h-auto gap-1 p-0">
          <TabsTrigger value="info" className={TAB}>Thông tin</TabsTrigger>
          <TabsTrigger value="history" className={TAB}>Lịch sử thao tác</TabsTrigger>
          <TabsTrigger value="kanban" className={TAB}>Công việc</TabsTrigger>
        </TabsList>

        <TabsContent value="info">
          <ContactInfoForm
            contact={contact}
            assigneeName={contact.assigned_user?.full_name ?? null}
            assigneeEmail={contact.assigned_user?.email ?? null}
            creatorName={contact.creator?.full_name ?? null}
            createdAt={contact.created_at ?? null}
          />
        </TabsContent>

        <TabsContent value="history">
          <section aria-labelledby="contact-history" className={BOX}>
            <header className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
              <h2 id="contact-history" className="text-[15px] font-semibold text-foreground">Lịch sử thao tác</h2>
              {allActivities.length > 0 && (
                <span className="ml-auto text-sm text-muted-foreground">{allActivities.length.toLocaleString("vi-VN")}{activitiesQuery.hasNextPage ? "+" : ""} mục</span>
              )}
            </header>
            {activitiesQuery.isLoading ? (
              <div className="space-y-3 p-4">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
              </div>
            ) : allActivities.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">Chưa có hoạt động nào</p>
            ) : (
              <>
                <ActivityTimeline items={allActivities} />
                {activitiesQuery.hasNextPage && (
                  <div className="border-t border-[var(--border)] p-3 text-center">
                    <Button variant="outline" size="sm" className="text-sm max-sm:h-11 max-sm:w-full" onClick={() => activitiesQuery.fetchNextPage()} disabled={activitiesQuery.isFetchingNextPage}>
                      {activitiesQuery.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Xem thêm
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        </TabsContent>

        <TabsContent value="kanban">
          <ContactKanbanTab contactId={Number(id)} contactName={contact.full_name} />
        </TabsContent>
      </Tabs>
      <MentionedIn type="contact" id={Number(id)} />
    </div>
  )
}
