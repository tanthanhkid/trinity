"use client"

import { useEffect, useRef, useState } from "react"
import { useQuery, useInfiniteQuery } from "@tanstack/react-query"
import { Button, buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Phone, ArrowRight, MessageSquare, Mail, Loader2, ShieldOff, AlertCircle, RefreshCcw, ChevronLeft, History } from "lucide-react"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { ArrowLeft } from "lucide-react"
import axios from "axios"
import apiClient from "@/lib/api-client"
import { formatTimeVn, todayVn, vnDateKey } from "@/lib/format"
import { cn } from "@/lib/utils"
import { inboxDayLabel } from "@/components/inbox/inbox-ui"
import { useAuth } from "@/hooks/use-auth"
import { useRouteParams } from "@/lib/route-params"
import { useMediaQuery } from "@/lib/use-popover-container"
import { Can, Forbidden, usePermissions } from "@/lib/rbac"
import { useMarkContactViewed } from "@/hooks/use-mark-contact-viewed"
import { StickyActionBar } from "@/components/ui/sticky-action-bar"
import { EmptyState } from "@/components/ui/empty-state"
import { ContactInfoForm, type ContactData } from "./_components/contact-info-form"
import { ReassignContactSaleButton } from "./_components/reassign-contact-sale"
import { LeadScoreCard, type LeadReason } from "./_components/lead-score-card"
import { ContactHero, callPhone, openZalo } from "./_components/contact-hero"
import { StagePicker } from "./_components/stage-picker"
import { ReminderCard } from "./_components/reminder-card"
import { ContactInfoPanel, INLINE_FIELDS, fieldDisplay, missingCount } from "./_components/info-panel"
import { MissingInfoScreen } from "./_components/missing-info-sheet"
import { QuickNoteCard } from "./_components/quick-note-card"
import { useContactMessengerHref } from "./_components/use-contact-messenger"
import { genderLabel } from "@/lib/contact-gender"
import type { LeadLabel } from "@/components/lead-score-badge"
import { ContactKanbanTab } from "@/components/kanban/contact-kanban-tab"
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

/**
 * Lịch sử thao tác dạng dòng thời gian: vạch ngày · giờ · biểu tượng · nội dung (ghi chú vẫn qua `MentionText`, gắn thẻ @).
 * Hàng hover `--ax-hover`, vạch chia `--ax-divider`.
 */
function ActivityTimeline({ items }: { items: Activity[] }) {
  const today = todayVn()
  const days = items.map((a) => vnDateKey(a.created_at))
  return (
    <ol>
      {items.map((a, i) => {
        const Icon = activityIcon[a.action] ?? MessageSquare
        const day = days[i]
        // Vạch ngày khi khác ngày của mục đứng trước (bỏ qua mục không có ngày hợp lệ).
        const sep = day && day !== (days.slice(0, i).reverse().find(Boolean) ?? "")
        return (
          <li key={a.id}>
            {sep && (
              <p className="px-1 pb-1 pt-3 text-sm font-medium text-ax-ink-2">{inboxDayLabel(day, today)}</p>
            )}
            <div className="grid grid-cols-[48px_28px_minmax(0,1fr)] items-start gap-2.5 border-t border-ax-divider px-1 py-3 transition-colors hover:bg-ax-hover sm:grid-cols-[56px_28px_minmax(0,1fr)]">
              <time dateTime={a.created_at} className="ax-amount pt-0.5 text-[13px] text-ax-ink-3">{formatTimeVn(a.created_at)}</time>
              <span className="grid size-7 place-items-center rounded-full bg-ax-sunken">
                <Icon className="size-3.5 text-ax-ink-2" aria-hidden />
              </span>
              <p className="min-w-0 break-words pt-0.5 text-sm leading-normal text-ax-ink">
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
export default function ContactDetailPage() {
  const route = useRouteParams<"id">("/contacts/:id")
  const { isLoading } = useAuth()
  const { can } = usePermissions()
  if (isLoading || !route) return <Skeleton className="h-64 rounded-2xl" />
  if (!can("contacts.view")) return <Forbidden message="Cần quyền Xem khách hàng." />
  return <ContactDetailContent id={route.id} />
}

function ContactDetailContent({ id }: { id: string }) {
  const [showFull, setShowFull] = useState(false)
  const [showMissing, setShowMissing] = useState(false)
  const desktop = useMediaQuery("(min-width: 1024px)")
  // Nút chat ở thanh đáy điện thoại (desktop: hàng nút trên khối nhấn tự hỏi).
  const messengerHref = useContactMessengerHref(desktop ? undefined : id)
  const fullFormRef = useRef<HTMLElement>(null)
  // «Sửa» / «Chỉnh sửa đầy đủ» mở form ở cuối cột ⇒ cuộn tới để người dùng thấy ngay.
  useEffect(() => {
    if (showFull) fullFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [showFull])

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

  const fullForm = (
    <section ref={fullFormRef} aria-label="Chỉnh sửa đầy đủ" className="flex scroll-mt-4 flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-[-0.011em]">Chỉnh sửa đầy đủ</h2>
        <Button variant="ax-ghost" size="ax-sm" onClick={() => setShowFull(false)}>Đóng</Button>
      </div>
      <ContactInfoForm
        autoEdit
        contact={contact}
        assigneeName={contact.assigned_user?.full_name ?? null}
        assigneeEmail={contact.assigned_user?.email ?? null}
        creatorName={contact.creator?.full_name ?? null}
        createdAt={contact.created_at ?? null}
      />
    </section>
  )

  const history = (
    <section aria-labelledby="contact-history" className="ax-card px-5 py-[18px] max-sm:px-4">
      <div className="mb-1.5 flex items-center gap-2.5">
        <h2 id="contact-history" className="text-sm font-bold tracking-[-0.011em] max-sm:text-[15px]">Lịch sử</h2>
        {allActivities.length > 0 && (
          <span className="ml-auto text-sm text-ax-ink-3">{allActivities.length.toLocaleString("vi-VN")}{activitiesQuery.hasNextPage ? "+" : ""} mục</span>
        )}
      </div>
      {activitiesQuery.isLoading ? (
        <div className="space-y-3 py-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
        </div>
      ) : allActivities.length === 0 ? (
        <EmptyState variant="ax" icon={History} title="Chưa có hoạt động nào" message="Mọi thay đổi và ghi chú của khách sẽ hiện ở đây." />
      ) : (
        <>
          <ActivityTimeline items={allActivities} />
          {activitiesQuery.hasNextPage && (
            <div className="border-t border-ax-divider pt-3 text-center">
              <Button variant="ax-secondary" size="ax" className="max-sm:w-full" onClick={() => activitiesQuery.fetchNextPage()} disabled={activitiesQuery.isFetchingNextPage}>
                {activitiesQuery.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Xem thêm
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )

  const tasks = (
    <section aria-labelledby="contact-tasks" className="flex flex-col gap-2">
      <h2 id="contact-tasks" className="text-sm font-bold tracking-[-0.011em] max-sm:text-[15px]">Công việc</h2>
      <ContactKanbanTab contactId={Number(id)} contactName={contact.full_name} />
    </section>
  )

  const leadScore = (
    <LeadScoreCard
      contactId={id}
      score={contact.lead_score}
      label={contact.lead_label}
      reasons={contact.lead_score_reasons}
      scoredAt={contact.lead_scored_at}
    />
  )

  const assignee = contact.assigned_user?.full_name ?? null

  if (desktop) {
    return (
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
        <nav aria-label="Vị trí" className="flex items-center gap-2 text-[13px] text-ax-ink-2">
          <Link href="/contacts" className="hover:text-ax-ink hover:underline">Khách hàng</Link>
          <span aria-hidden>/</span>
          <span className="text-ax-ink">{contact.full_name || contact.phone}</span>
        </nav>
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-[280px] max-w-[340px] flex-[1_1_300px] flex-col gap-4">
            <ContactHero contactId={id} name={contact.full_name} phone={contact.phone} code={contact.code} avatarUrl={contact.avatar_url} sourceLabel={contact.source?.label} withActions />
            <section aria-labelledby="contact-stage" className="ax-card px-5 py-[18px]">
              <h2 id="contact-stage" className="mb-2.5 text-sm font-bold tracking-[-0.011em]">Giai đoạn</h2>
              <StagePicker contact={contact} layout="list" />
            </section>
            <ReminderCard contact={contact} />
            {leadScore}
          </div>
          <div className="flex min-w-0 flex-[3_1_420px] flex-col gap-4">
            <Can perm="contacts.update"><QuickNoteCard contactId={id} variant="desktop" /></Can>
            {history}
            {tasks}
            {showFull && fullForm}
            <MentionedIn type="contact" id={Number(id)} />
          </div>
          <div className="flex min-w-[280px] max-w-[360px] flex-[2_1_300px] flex-col gap-3">
            <ContactInfoPanel
              contact={contact}
              assigneeName={assignee}
              assigneeEmail={contact.assigned_user?.email ?? null}
              creatorName={contact.creator?.full_name ?? null}
              createdAt={contact.created_at ?? null}
              onOpenFullForm={() => setShowFull(true)}
            />
            <ReassignContactSaleButton
              contactId={id}
              contactName={contact.full_name}
              assignedTo={contact.assigned_to}
              assigneeName={assignee}
            />
          </div>
        </div>
      </div>
    )
  }

  // Điện thoại (< 1024px): bố cục RIÊNG theo khach-mobile — quay lại · khối nhấn · chip giai đoạn · Ghi nhanh · tóm tắt ·
  // Lịch sử · thanh Gọi/Zalo/Messenger dính đáy. Khối thiết kế không vẽ (Hẹn gọi lại, Công việc, chuyển phụ trách, điểm lead…) giữ
  // chức năng, xếp sau Lịch sử.
  const summary = INLINE_FIELDS
    .map((f) => ({ label: f.label, value: fieldDisplay(f.key, contact) }))
    .filter((r) => r.value !== "")
  if (contact.source?.label) summary.push({ label: "Nguồn", value: contact.source.label })
  if (assignee) summary.push({ label: "Phụ trách", value: assignee })
  const gender = genderLabel(contact.gender)
  if (gender) summary.push({ label: "Giới tính", value: gender })
  if (contact.contact_status?.label) summary.push({ label: "Trạng thái chi tiết", value: contact.contact_status.label })
  const missing = missingCount(contact)
  const hasPhone = contact.phone.trim().length > 0

  return (
    <div className="-mx-1 flex flex-col gap-3.5">
      <div className="flex items-center justify-between">
        <Link href="/contacts" aria-label="Quay lại Khách hàng" className="flex h-11 items-center gap-0.5 rounded-ax-field pr-3 text-base text-ax-primary-ink outline-none focus-visible:shadow-[var(--ax-focus-ring)]">
          <ChevronLeft className="size-5" aria-hidden /> Khách hàng
        </Link>
        <Can perm="contacts.update">
          <button type="button" onClick={() => setShowFull(true)} className="h-11 rounded-ax-field px-3.5 text-base font-semibold text-ax-primary-ink outline-none focus-visible:shadow-[var(--ax-focus-ring)]">
            Sửa
          </button>
        </Can>
      </div>
      <ContactHero contactId={id} name={contact.full_name} phone={contact.phone} code={contact.code} avatarUrl={contact.avatar_url} sourceLabel={contact.source?.label} />
      <div className="-mx-1"><StagePicker contact={contact} layout="chips" /></div>
      <Can perm="contacts.update"><QuickNoteCard contactId={id} variant="mobile" /></Can>
      <section aria-label="Thông tin" className="ax-card px-4 py-1.5">
        {summary.map((r, i) => (
          <div key={r.label} className={cn("flex min-h-12 items-center justify-between gap-4", i > 0 && "border-t border-ax-divider")}>
            <span className="text-[15px] text-ax-ink-2">{r.label}</span>
            <span className="ax-amount text-right text-[15px] break-words">{r.value}</span>
          </div>
        ))}
        {missing > 0 && (
          <Can perm="contacts.update">
            <button
              type="button"
              onClick={() => setShowMissing(true)}
              className={cn("min-h-12 w-full text-left text-[15px] font-semibold text-ax-primary outline-none focus-visible:shadow-[var(--ax-focus-ring)]", summary.length > 0 && "border-t border-ax-divider")}
            >
              Bổ sung {missing} thông tin còn thiếu
            </button>
          </Can>
        )}
      </section>
      {history}
      <ReminderCard contact={contact} />
      {tasks}
      {/* Chuyển người phụ trách (tự ẩn khi thiếu `contacts.transfer`) — giữ chức năng của bản cũ trên điện thoại. */}
      <ReassignContactSaleButton
        contactId={id}
        contactName={contact.full_name}
        assignedTo={contact.assigned_to}
        assigneeName={assignee}
      />
      {leadScore}
      {showFull && fullForm}
      <MentionedIn type="contact" id={Number(id)} />
      <MissingInfoScreen contact={contact} open={showMissing} onOpenChange={setShowMissing} />
      {(hasPhone || messengerHref) && (
        <StickyActionBar layout="mobile" className={cn("grid", hasPhone ? (messengerHref ? "grid-cols-[2fr_1fr_auto]" : "grid-cols-[2fr_1fr]") : "grid-cols-1")}>
          {hasPhone && (
            <>
              <Button variant="ax-primary" size="ax-lg" className="text-[17px] font-bold" onClick={() => callPhone(contact.phone)}>
                <Phone className="size-5" aria-hidden /> Gọi
              </Button>
              <Button variant="ax-secondary" size="ax-lg" className="text-base" onClick={() => openZalo(contact.phone)}>Zalo</Button>
            </>
          )}
          {messengerHref && (
            <Link
              href={messengerHref}
              aria-label="Nhắn Messenger"
              className={cn(buttonVariants({ variant: "ax-secondary", size: "ax-lg" }), hasPhone ? "aspect-square px-0" : "text-base")}
            >
              <MessageSquare className="size-5" aria-hidden />
              {!hasPhone && "Messenger"}
            </Link>
          )}
        </StickyActionBar>
      )}
    </div>
  )
}
