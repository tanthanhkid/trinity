'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, Copy, Sparkles } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import type { AiConnection } from '@/app/(dashboard)/settings/_components/integrations/integrations-meta'
import { formatRelativeTimeVn } from '@/lib/nav-time'
import { cn } from '@/lib/utils'
import { AiLogo } from './ai-logo'
import { CONNECT_AI_HREF } from './home-ai-timeline'
import { BOX, HomeBox, HomeEmpty, SMALL_BTN } from './home-box'
import { agoLabel } from './home-utils'

/* ------------------------------------------------------------------ */
/* Cần bạn xem                                                          */
/* ------------------------------------------------------------------ */

export interface ReviewItem {
  key: string
  /** `unread` = chấm đặc (thông báo chưa đọc) · `wait` = vòng nét đứt (đang chờ bạn quyết/làm). */
  dot: 'unread' | 'wait'
  title: string
  sub: string
  href: string | null
  cta: string
}

export function NeedsReviewView({ loading, items, total }: { loading: boolean; items: ReviewItem[]; total: number | null }) {
  return (
    <HomeBox labelledBy="home-need-review" title="Cần bạn xem" aside={total !== null ? total.toLocaleString('vi-VN') : undefined}>
      {loading && items.length === 0 ? (
        <div className="space-y-3 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 rounded-lg" />)}</div>
      ) : items.length === 0 ? (
        <HomeEmpty testId="need-review-empty">Không có gì cần bạn xem lúc này — không có đề xuất AI chờ duyệt, việc quá hạn hay thông báo chưa đọc.</HomeEmpty>
      ) : (
        <ul className="py-1.5" data-testid="need-review">
          {items.map((it) => (
            <li key={it.key} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-start gap-2.5 px-4 py-2.5 hover:bg-[var(--muted)]">
              <span
                aria-hidden
                className={cn(
                  'mt-[6px] size-2.5 rounded-full',
                  it.dot === 'unread' ? 'bg-[var(--ring)]' : 'border-2 border-dashed border-muted-foreground',
                )}
              />
              <div className="min-w-0">
                <p className="break-words text-[14px] font-medium leading-snug text-[var(--foreground)]">{it.title}</p>
                {it.sub && <p className="mt-0.5 line-clamp-2 break-words text-[14px] leading-snug text-muted-foreground">{it.sub}</p>}
              </div>
              {it.href && (
                <Link href={it.href} className={SMALL_BTN} aria-label={`${it.cta}: ${it.title}`}>{it.cta}</Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </HomeBox>
  )
}

/* ------------------------------------------------------------------ */
/* Trợ lý đang kết nối                                                  */
/* ------------------------------------------------------------------ */

export type ConnectionsState = 'loading' | 'disabled' | 'no-permission' | 'error' | 'ready'

const lastUsed = (c: AiConnection) => Date.parse(c.last_used_at ?? c.connected_at ?? '') || 0

export function ConnectedAssistantsView({
  state,
  rows,
  showOwner,
}: {
  state: ConnectionsState
  rows: AiConnection[]
  /** Danh sách cả công ty (ai_admin) ⇒ ghi tên người sở hữu kết nối. */
  showOwner: boolean
}) {
  const sorted = [...rows].sort((a, b) => lastUsed(b) - lastUsed(a))
  return (
    <HomeBox labelledBy="home-connected" title="Trợ lý đang kết nối" aside={state === 'ready' && rows.length > 0 ? rows.length.toLocaleString('vi-VN') : undefined}>
      {state === 'loading' && <div className="space-y-3 p-4">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-8 rounded-lg" />)}</div>}
      {state === 'disabled' && <HomeEmpty testId="connections-disabled">Kết nối AI chưa được bật trên hệ thống này.</HomeEmpty>}
      {state === 'no-permission' && (
        <HomeEmpty testId="connections-no-permission">Bạn chưa được cấp quyền kết nối AI. Nhờ quản trị viên bật quyền “Kết nối AI” cho vai trò của bạn.</HomeEmpty>
      )}
      {state === 'error' && <HomeEmpty>Không tải được danh sách trợ lý. Thử tải lại trang.</HomeEmpty>}
      {state === 'ready' && rows.length === 0 && (
        <HomeEmpty testId="connections-empty" action={<Link href={CONNECT_AI_HREF} className={SMALL_BTN}>Kết nối AI</Link>}>
          Chưa có trợ lý nào kết nối. Nối ChatGPT, Claude hoặc Gemini để AI làm việc trong Trinity theo đúng quyền của bạn.
        </HomeEmpty>
      )}
      {state === 'ready' && sorted.length > 0 && (
        <ul data-testid="connections">
          {sorted.map((c) => {
            const owner = c.user.full_name ?? c.user.email
            const when = c.last_used_at ? agoLabel(formatRelativeTimeVn(c.last_used_at)) : 'Chưa dùng'
            return (
              <li key={c.id} className="flex items-center gap-2.5 border-t border-[var(--border)] px-4 py-2.5 first:border-t-0">
                <AiLogo name={c.client_name} size={26} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--foreground)]" title={showOwner ? `${c.client_name} · ${owner}` : c.client_name}>
                  {c.client_name}{showOwner ? ` · ${owner}` : ''}
                </span>
                <span className="shrink-0 text-[14px] text-muted-foreground">{when}</span>
              </li>
            )
          })}
        </ul>
      )}
    </HomeBox>
  )
}

/* ------------------------------------------------------------------ */
/* Ô "Hỏi AI" gợi ý                                                     */
/* ------------------------------------------------------------------ */

export const ASK_SUGGESTION = 'Hôm nay có khách nào cần gọi lại không?'

/**
 * Trinity không gọi AI từ máy chủ — AI là của người dùng (ChatGPT/Claude/Gemini đã kết nối qua MCP).
 * Nên ô này chỉ GỢI Ý câu hỏi và cho chép để dán vào trợ lý của bạn; không giả làm ô chat.
 */
export function AskAiHint() {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(ASK_SUGGESTION)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* trình duyệt chặn clipboard: câu hỏi vẫn hiện để tự chép */
    }
  }
  return (
    <div className={cn(BOX, 'flex items-center gap-2.5 border-dashed border-[var(--input)] px-4 py-3 text-[14px] text-[var(--color-app-ink-2)] shadow-none')}>
      <Sparkles className="size-4 shrink-0 text-[var(--ring)]" aria-hidden />
      <p className="min-w-0 flex-1">
        Hỏi trợ lý của bạn: <span className="text-[var(--foreground)]">“{ASK_SUGGESTION}”</span>
      </p>
      <button type="button" onClick={copy} className={SMALL_BTN} aria-label="Chép câu hỏi gợi ý">
        {copied ? <Check className="mr-1 size-4" aria-hidden /> : <Copy className="mr-1 size-4" aria-hidden />}
        {copied ? 'Đã chép' : 'Chép'}
      </button>
    </div>
  )
}
