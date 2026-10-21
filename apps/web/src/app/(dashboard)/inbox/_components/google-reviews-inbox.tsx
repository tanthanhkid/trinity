"use client"

import { useState } from "react"
import { Loader2, Star } from "lucide-react"
import { toast } from "sonner"
import { getApiErrorMessage } from "@/lib/api-client"
import { formatDateTimeVn } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Composer, ConversationItem, InboxEmpty, InboxFrame, InboxListToolbar, SideSection, StatusPill, ThreadHeader, inboxTimeLabel } from "@/components/inbox/inbox-ui"
import { useGoogleReviews, useReplyGoogleReview, type GoogleReview, type SocialAccount } from "@/hooks/use-social"
import { ErrorState } from "@/components/ui/error-state"

/** Google cho câu trả lời tối đa 4.096 byte; chữ Việt có dấu ~2–3 byte/ký tự ⇒ chặn ở 1.300 ký tự là an toàn. */
const REPLY_MAX = 1300

export function Stars({ n, className }: { n: number | null; className?: string }) {
  if (!n) return <span className={cn("text-xs text-muted-foreground", className)}>Không chấm sao</span>
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-label={`${n} trên 5 sao`} title={`${n}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} aria-hidden className={cn("size-3.5", i <= n ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40")} />
      ))}
    </span>
  )
}

const preview = (r: GoogleReview) => `${r.stars ? "★".repeat(r.stars) + " " : ""}${r.comment ?? "(chỉ chấm sao, không viết bình luận)"}`

function ReviewThread({ review, location, accountId, onBack }: { review: GoogleReview; location: string; accountId: number; onBack: () => void }) {
  const [text, setText] = useState(review.reply?.comment ?? "")
  const reply = useReplyGoogleReview(accountId)
  const send = () => {
    const comment = text.trim()
    if (!comment) return
    reply.mutate(
      { reviewId: review.id, comment },
      {
        onSuccess: () => toast.success(review.reply ? "Đã sửa câu trả lời trên Google" : "Đã trả lời đánh giá trên Google"),
        onError: (err) => toast.error(getApiErrorMessage(err, "Không gửi được câu trả lời")),
      },
    )
  }
  return (
    <>
      <ThreadHeader
        name={review.reviewer}
        avatarUrl={review.reviewer_photo}
        sub={`Đánh giá Google · ${location}`}
        channel="google"
        onBack={onBack}
        aside={<StatusPill tone={review.reply ? "ok" : "warn"}>{review.reply ? "Đã trả lời" : "Chưa trả lời"}</StatusPill>}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="space-y-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Stars n={review.stars} />
            {review.created_at && <span className="text-xs text-muted-foreground">{formatDateTimeVn(review.created_at)}</span>}
          </div>
          <p className="whitespace-pre-wrap text-sm">{review.comment ?? "Khách chỉ chấm sao, không viết bình luận."}</p>
        </div>
        {review.reply && (
          <div className="ml-6 space-y-1 rounded-lg bg-muted/60 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              Câu trả lời của doanh nghiệp{review.reply.updated_at ? ` · ${formatDateTimeVn(review.reply.updated_at)}` : ""}
            </p>
            <p className="whitespace-pre-wrap text-sm">{review.reply.comment}</p>
          </div>
        )}
      </div>
      <Composer
        value={text}
        onChange={setText}
        onSend={send}
        pending={reply.isPending}
        placeholder={review.reply ? "Sửa câu trả lời…" : "Trả lời công khai trên Google…"}
        ariaLabel="Câu trả lời đánh giá"
        maxLength={REPLY_MAX}
        notice={<span>Câu trả lời hiện công khai trên Google Maps và Google Tìm kiếm.</span>}
      />
    </>
  )
}

/**
 * Đánh giá Google Business Profile trong Hộp thư: đọc đánh giá của từng địa điểm đã liên kết (Đăng đa kênh › Kênh),
 * trả lời công khai. Dữ liệu đọc thẳng từ Google mỗi lần mở (không lưu bản sao). Quyền = `social.post`.
 */
export function GoogleReviewsInbox({ accounts, listTop, className }: { accounts: SocialAccount[]; listTop?: React.ReactNode; className?: string }) {
  const [accountId, setAccountId] = useState<number | null>(accounts[0]?.id ?? null)
  const account = accounts.find((a) => a.id === accountId) ?? null
  const q = useGoogleReviews(accountId)
  const [openId, setOpenId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [onlyAwaiting, setOnlyAwaiting] = useState(false)
  const pages = q.data?.pages ?? []
  const all = pages.flatMap((p) => p.reviews)
  const summary = pages[0]
  const needle = search.trim().toLocaleLowerCase("vi")
  const found = all.filter((r) => !needle || `${r.reviewer} ${r.comment ?? ""}`.toLocaleLowerCase("vi").includes(needle))
  const awaitingCount = found.filter((r) => !r.reply).length
  const rows = onlyAwaiting ? found.filter((r) => !r.reply) : found
  const selected = all.find((r) => r.id === openId) ?? null

  return (
    <InboxFrame
      threadOpen={openId !== null}
      listTop={listTop}
      className={className}
      list={
        <>
          {accounts.length > 1 && (
            <div className="border-b border-[var(--border)] p-3 pb-0">
              <Select value={accountId != null ? String(accountId) : null} onValueChange={(v) => { if (v) { setAccountId(Number(v)); setOpenId(null) } }}>
                <SelectTrigger className="w-full" aria-label="Địa điểm Google Business">
                  <SelectValue>{(v) => accounts.find((a) => String(a.id) === v)?.name ?? null}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <InboxListToolbar q={search} onQ={setSearch} awaiting={{ on: onlyAwaiting, count: awaitingCount, onChange: setOnlyAwaiting }} />
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {q.isLoading && <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>}
            {q.isError && <ErrorState compact className="px-2 py-4" title="Không tải được đánh giá Google" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
            {q.isSuccess && rows.length === 0 && (
              <InboxEmpty icon={<Star aria-hidden />}>
                {onlyAwaiting && all.length > 0 ? "Không còn đánh giá nào chờ trả lời." : needle && all.length > 0 ? "Không có đánh giá nào khớp." : "Địa điểm này chưa có đánh giá nào trên Google."}
              </InboxEmpty>
            )}
            <ul className="space-y-0.5">
              {rows.map((r) => (
                <li key={r.id}>
                  <ConversationItem
                    name={r.reviewer}
                    avatarUrl={r.reviewer_photo}
                    preview={preview(r)}
                    time={inboxTimeLabel(r.updated_at ?? r.created_at)}
                    unread={0}
                    active={openId === r.id}
                    channel="google"
                    dot={{ tone: r.reply ? "closed" : "open", label: r.reply ? "Đã trả lời" : "Chưa trả lời" }}
                    onClick={() => setOpenId(r.id)}
                  />
                </li>
              ))}
            </ul>
            {q.hasNextPage && (
              <button type="button" className="mt-2 w-full rounded-md py-2 text-sm text-primary hover:underline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? "Đang tải..." : "Xem thêm đánh giá"}
              </button>
            )}
          </div>
        </>
      }
      thread={
        selected && account ? (
          <ReviewThread key={`${account.id}-${selected.id}`} review={selected} location={account.name} accountId={account.id} onBack={() => setOpenId(null)} />
        ) : (
          <InboxEmpty icon={<Star aria-hidden />} title="Chưa mở đánh giá">Chọn một đánh giá bên trái để đọc và trả lời.</InboxEmpty>
        )
      }
      side={
        summary ? (
          <SideSection
            title={account?.name ?? "Google Business"}
            rows={[
              { label: "Điểm trung bình", value: summary.average != null ? `${summary.average.toFixed(1)} / 5` : "—" },
              { label: "Tổng số đánh giá", value: summary.total.toLocaleString("vi-VN") },
              { label: "Chưa trả lời (đã tải)", value: String(all.filter((r) => !r.reply).length) },
            ]}
          />
        ) : undefined
      }
    />
  )
}
