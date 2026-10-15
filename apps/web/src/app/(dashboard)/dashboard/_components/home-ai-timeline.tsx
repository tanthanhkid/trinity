'use client'

import Link from 'next/link'
import { Sparkles } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import type { AiAction } from '@/lib/ai-actions'
import { formatTimeVn } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AiLogo } from './ai-logo'
import { GHOST_BTN, HomeBox, HomeEmpty, SMALL_BTN } from './home-box'
import { canUndoAiAction } from './home-utils'

/** Màn Kết nối sẵn có: Cài đặt › Kết nối & AI › Kết nối AI. */
export const CONNECT_AI_HREF = '/settings?tab=integrations&muc=ai'

export type TimelineState = 'loading' | 'disabled' | 'error' | 'ready'

const MAX_ROWS = 8

function TimelineRow({ a, userName }: { a: AiAction; userName: string }) {
  const failed = a.status === 'failed'
  return (
    <li className="grid grid-cols-[44px_28px_minmax(0,1fr)_auto] items-start gap-2.5 px-4 py-2.5 hover:bg-[var(--muted)] sm:grid-cols-[52px_28px_minmax(0,1fr)_auto]">
      <time dateTime={a.created_at} className="pt-1 text-[14px] tabular-nums text-muted-foreground">{formatTimeVn(a.created_at)}</time>
      <AiLogo name={a.client_name} />
      <div className="min-w-0">
        {/* summary/client_name là văn bản do AI soạn ⇒ chỉ text node. */}
        <p className="break-words text-[14px] font-medium leading-snug text-[var(--foreground)]">{a.summary}</p>
        <p className="mt-0.5 break-words text-[14px] leading-snug text-muted-foreground">
          {a.client_name ?? 'Ứng dụng AI'}{userName ? ` của ${userName}` : ''} · {a.tool_label}
          {failed && <span className="font-medium text-[var(--color-app-tag-red-ink)]"> · Không thực hiện được</span>}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {canUndoAiAction(a) && (
          <button type="button" className={GHOST_BTN}>Hoàn tác</button>
        )}
        <Link href={`/ai-actions?id=${a.id}`} className={GHOST_BTN} aria-label={`Xem chi tiết: ${a.summary}`}>
          Xem
        </Link>
      </div>
    </li>
  )
}

/**
 * "AI đã làm gì hôm nay" — dòng thời gian từ nhật ký Hoạt động AI THẬT (`GET /integrations/ai-actions`, của chính mình).
 * Không có nút Hoàn tác: BE chưa có thao tác hoàn tác (xem `canUndoAiAction`). "Xem" mở đúng mục ở màn Hoạt động AI.
 */
export function AiTimelineView({
  state,
  rows,
  userName,
  canConnect,
  hasConnections,
  className,
}: {
  state: TimelineState
  rows: AiAction[]
  userName: string
  /** Có quyền tự kết nối AI (`integrations.ai_connect`/`ai_admin`) ⇒ trạng thái trống dẫn tới màn Kết nối. */
  canConnect: boolean
  hasConnections: boolean
  className?: string
}) {
  const shown = rows.slice(0, MAX_ROWS)
  return (
    <HomeBox
      labelledBy="home-ai-today"
      className={className}
      title="AI đã làm gì hôm nay"
      icon={<Sparkles className="size-4 text-[var(--ring)]" aria-hidden />}
      aside={
        state === 'ready' || state === 'loading' ? (
          <Link href="/ai-actions" className="rounded px-1 hover:text-[var(--foreground)] hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
            {rows.length > 0 ? `Tất cả · ${rows.length.toLocaleString('vi-VN')} hôm nay` : 'Tất cả'}
          </Link>
        ) : undefined
      }
    >
      {state === 'loading' && (
        <div className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
      )}
      {state === 'disabled' && (
        <HomeEmpty testId="ai-timeline-disabled">Kết nối AI chưa được bật trên hệ thống này, nên chưa có việc nào do AI làm.</HomeEmpty>
      )}
      {state === 'error' && <HomeEmpty>Không tải được hoạt động của AI. Thử tải lại trang.</HomeEmpty>}
      {state === 'ready' && rows.length === 0 && (
        <HomeEmpty
          testId="ai-timeline-empty"
          action={
            canConnect && !hasConnections ? (
              <Link href={CONNECT_AI_HREF} className={SMALL_BTN}>Kết nối AI</Link>
            ) : undefined
          }
        >
          {hasConnections
            ? 'Hôm nay trợ lý của bạn chưa làm việc nào. Khi ChatGPT, Claude hay Gemini thêm khách, ghi chú hay tạo công việc thay bạn, từng việc sẽ hiện ở đây.'
            : canConnect
              ? 'Chưa có trợ lý AI nào làm việc cho bạn. Kết nối ChatGPT, Claude hoặc Gemini — mọi việc AI làm sẽ hiện ở đây, theo đúng quyền của bạn.'
              : 'Hôm nay chưa có việc nào do AI làm cho bạn.'}
        </HomeEmpty>
      )}
      {state === 'ready' && shown.length > 0 && (
        <ul className={cn('py-1.5')} data-testid="ai-timeline">
          {shown.map((a) => <TimelineRow key={a.id} a={a} userName={userName} />)}
        </ul>
      )}
    </HomeBox>
  )
}
