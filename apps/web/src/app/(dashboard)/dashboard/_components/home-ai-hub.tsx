'use client'

/* Đầu trang Tổng quan kiểu "AI Native CRM": trợ lý AI nào đang làm việc cho công ty + kênh nào đã nối và hôm nay có gì mới.
 * Chưa nối AI thì cả khối trái thành lời mời kết nối. Không dùng chữ "MCP" — với người dùng đây là "trợ lý AI". */

import { useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { ArrowRight, CreditCard, Plug, Plus, ShoppingBag, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { ORG_FEATURES, type OrgFeatureKey } from '@trinity/rbac'
import { Skeleton } from '@/components/ui/skeleton'
import { BrandLogo } from '@/components/ui/connection-row'
import { isBrandKey } from '@/lib/brand-logos'
import type { AiConnection } from '@/app/(dashboard)/settings/_components/integrations/integrations-meta'
import { useOrgFeatures, useUpdateOrgFeatures } from '@/hooks/use-org-features'
import { formatRelativeTimeVn } from '@/lib/nav-time'
import { usePermissions } from '@/lib/rbac'
import { cn } from '@/lib/utils'
import { AiLogo } from './ai-logo'
import { CONNECT_AI_HREF } from './home-ai-timeline'
import { BOX, HomeBox, HomeEmpty, SMALL_BTN } from './home-box'
import type { ConnectionsState } from './home-side'
import { agoLabel } from './home-utils'
import type { ChannelState, HomeChannel, HomeChannels } from './use-home-data'

const nf = (n: number) => n.toLocaleString('vi-VN')
const lastUsed = (c: AiConnection) => Date.parse(c.last_used_at ?? c.connected_at ?? '') || 0
/** Dùng trong 15 phút gần nhất ⇒ coi là "đang làm việc". */
const ACTIVE_MS = 15 * 60 * 1000

/* ------------------------------------------------------------------ */
/* Trợ lý AI                                                            */
/* ------------------------------------------------------------------ */

export function AiAssistantsHub({
  state,
  rows,
  showOwner,
  doneToday,
  now,
}: {
  state: ConnectionsState
  rows: AiConnection[]
  showOwner: boolean
  /** Số việc AI làm hôm nay (null = chưa biết / tính năng tắt). */
  doneToday: string | null
  now: number | null
}) {
  if (state === 'ready' && rows.length === 0) return <ConnectAiInvite />
  const sorted = [...rows].sort((a, b) => lastUsed(b) - lastUsed(a))
  const activeNow = now === null ? 0 : sorted.filter((c) => now - lastUsed(c) < ACTIVE_MS && c.last_used_at).length
  return (
    <HomeBox
      labelledBy="home-ai-hub"
      title="Trợ lý AI đang làm việc"
      icon={<Sparkles className="size-4 text-[var(--ring)]" aria-hidden />}
      aside={state === 'ready' ? `${nf(rows.length)} đã kết nối` : undefined}
    >
      {state === 'loading' && <div className="space-y-3 p-4">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>}
      {state === 'disabled' && <HomeEmpty testId="hub-ai-disabled">Kết nối trợ lý AI chưa được bật trên hệ thống này.</HomeEmpty>}
      {state === 'no-permission' && (
        <HomeEmpty testId="hub-ai-no-permission">Bạn chưa được cấp quyền kết nối trợ lý AI. Nhờ quản trị viên bật quyền “Kết nối AI” cho vai trò của bạn.</HomeEmpty>
      )}
      {state === 'error' && <HomeEmpty>Không tải được danh sách trợ lý. Thử tải lại trang.</HomeEmpty>}
      {state === 'ready' && sorted.length > 0 && (
        <>
          <div className="flex items-center gap-3 px-4 pt-4">
            <div className="flex -space-x-2">
              {sorted.slice(0, 4).map((c) => <AiLogo key={c.id} name={c.client_name} size={36} className="ring-2 ring-[var(--card)]" />)}
            </div>
            <p className="min-w-0 text-[14px] text-[var(--color-app-ink-2)]">
              {doneToday !== null ? <>Hôm nay AI đã làm <strong className="text-[var(--foreground)]">{doneToday}</strong></> : 'Trợ lý AI làm việc trong Trinity theo đúng quyền của từng người.'}
              {activeNow > 0 && <> · <span className="text-emerald-600 dark:text-emerald-400">{nf(activeNow)} đang hoạt động</span></>}
            </p>
          </div>
          <ul className="mt-2" data-testid="hub-ai-list">
            {sorted.slice(0, 5).map((c) => {
              const owner = c.user.full_name ?? c.user.email
              const active = now !== null && !!c.last_used_at && now - lastUsed(c) < ACTIVE_MS
              return (
                <li key={c.id} className="flex items-center gap-2.5 border-t border-[var(--border)] px-4 py-2.5 first:border-t-0">
                  <AiLogo name={c.client_name} size={26} />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--foreground)]" title={showOwner ? `${c.client_name} · ${owner}` : c.client_name}>
                    {c.client_name}{showOwner ? <span className="text-muted-foreground"> · {owner}</span> : null}
                  </span>
                  <span className={cn('flex shrink-0 items-center gap-1.5 text-[14px]', active ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                    {active && <span aria-hidden className="size-2 rounded-full bg-emerald-500" />}
                    {c.last_used_at ? (active ? 'Đang hoạt động' : agoLabel(formatRelativeTimeVn(c.last_used_at))) : 'Chưa dùng'}
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="flex flex-wrap gap-2 border-t border-[var(--border)] px-4 py-3">
            <Link href="/ai-actions" className={SMALL_BTN}>Xem AI đã làm gì</Link>
            <Link href={CONNECT_AI_HREF} className={SMALL_BTN}><Plus className="mr-1 size-4" aria-hidden />Kết nối thêm</Link>
          </div>
        </>
      )}
    </HomeBox>
  )
}

/** Chưa nối trợ lý nào: lời mời nổi bật nhất trang — Trinity là CRM điều khiển bằng trợ lý AI. */
export function ConnectAiInvite() {
  const steps = [
    'Mở Kết nối trợ lý AI, chép địa chỉ kết nối của công ty bạn.',
    'Dán vào ChatGPT, Claude hoặc Gemini (mục kết nối ứng dụng).',
    'Đăng nhập Trinity và cho phép. Xong: nhắn AI là làm.',
  ]
  return (
    <section
      aria-labelledby="home-ai-invite"
      data-testid="hub-ai-invite"
      className={cn(BOX, 'relative overflow-hidden border-[var(--ring)]/40 bg-gradient-to-br from-[var(--accent)] via-[var(--card)] to-[var(--card)] p-5 sm:p-6')}
    >
      <div className="flex items-center gap-2">
        {(['ChatGPT', 'Claude', 'Gemini'] as const).map((n) => <AiLogo key={n} name={n} size={40} />)}
      </div>
      <h2 id="home-ai-invite" className="mt-4 text-[20px] font-semibold leading-tight text-[var(--foreground)]">Kết nối trợ lý AI để điều khiển Trinity</h2>
      <p className="mt-1.5 max-w-prose text-[15px] text-[var(--color-app-ink-2)]">
        Trinity là CRM làm việc qua trợ lý AI bạn đang dùng. Nối một lần, rồi chỉ cần nhắn:
        <span className="text-[var(--foreground)]"> “Thêm khách Lan, 0901…, quan tâm gói A”</span>, AI tự ghi vào đây theo đúng quyền của bạn.
      </p>
      <ol className="mt-4 grid gap-2 sm:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s} className="flex gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 text-[14px] text-[var(--color-app-ink-2)]">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--ring)] text-[13px] font-semibold text-white">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <Link
        href={CONNECT_AI_HREF}
        className="mt-4 inline-flex h-10 items-center gap-1.5 rounded-lg bg-[var(--ring)] px-4 text-[15px] font-semibold text-white shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11"
      >
        Kết nối trợ lý AI <ArrowRight className="size-4" aria-hidden />
      </Link>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Kênh đã kết nối                                                      */
/* ------------------------------------------------------------------ */

/** Chấm trạng thái: khác nhau cả HÌNH (không chỉ màu) để người mù màu vẫn phân biệt — WCAG 1.4.1 / 1.4.11.
 *  ok = chấm đặc · attention = chấm có dấu "!" · off = chấm rỗng (chỉ viền). Sắc -600 cho đủ tương phản trên nền thẻ sáng. */
function ChannelDot({ state }: { state: ChannelState }) {
  const base = 'absolute -right-0.5 -bottom-0.5 grid size-3 place-items-center rounded-full ring-2 ring-[var(--card)]'
  if (state === 'off') return <span aria-hidden className={cn(base, 'border border-muted-foreground/70 bg-[var(--card)]')} />
  if (state === 'attention') return <span aria-hidden className={cn(base, 'bg-amber-600 text-[8px] font-bold leading-none text-white')}>!</span>
  return <span aria-hidden className={cn(base, 'bg-emerald-600')} />
}

/** Chữ cho trình đọc màn hình — chấm trạng thái không chỉ dựa vào màu. */
const STATE_LABEL: Record<ChannelState, string> = {
  ok: 'Đang chạy',
  attention: 'Cần xử lý',
  off: 'Đã tắt',
}

/** Dấu nhận diện kênh: logo chính thức của hãng; trang bán hàng (của chính Trinity) và kênh lạ dùng biểu tượng chung. */
export function ChannelMark({ c }: { c: Pick<HomeChannel, 'kind' | 'network'> }) {
  if (isBrandKey(c.network)) return <BrandLogo brand={c.network} size={32} className="rounded-lg" />
  const Icon = c.kind === 'payment' ? CreditCard : c.kind === 'store' ? ShoppingBag : Plug
  return <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--muted)] text-[var(--foreground)]" aria-hidden><Icon className="size-4" /></span>
}

const POST_NETWORK_LABELS: Record<string, string> = { facebook: 'Fanpage', youtube: 'kênh YouTube', tiktok: 'kênh TikTok' }
const STATE_RANK: Record<ChannelState, number> = { ok: 0, off: 1, attention: 2 }

/**
 * Kênh đăng bài gộp theo mạng thành MỘT dòng ("Đăng bài · 6 Fanpage"): công ty nối nhiều Page để đăng thì danh sách
 * vẫn gọn, và Page vừa nhận tin vừa đăng bài không hiện như hai kênh giống hệt nhau. Trạng thái = trạng thái xấu nhất.
 */
export function groupPostingChannels(list: HomeChannel[]): HomeChannel[] {
  const out: HomeChannel[] = []
  const groups = new Map<string, HomeChannel[]>()
  for (const c of list) {
    if (c.kind !== 'social') { out.push(c); continue }
    groups.set(c.network, [...(groups.get(c.network) ?? []), c])
  }
  for (const [network, items] of groups) {
    if (items.length === 1) { out.push(items[0]); continue }
    const worst = items.reduce((a, b) => (STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a))
    const bad = items.filter((c) => c.state === 'attention').length
    const label = POST_NETWORK_LABELS[network] ?? `kênh ${network}`
    out.push({
      key: `social:${network}`, kind: 'social', network, href: items[0].href,
      name: `Đăng bài · ${items.length.toLocaleString('vi-VN')} ${label}`,
      state: worst.state,
      note: bad ? `${bad.toLocaleString('vi-VN')} kênh cần liên kết lại` : items.map((c) => c.name).join(', '),
      today: { label: 'bài đã đăng', value: items.reduce((n, c) => n + (c.today?.value ?? 0), 0) },
    })
  }
  const order = ['facebook_page', 'zalo_oa', 'social', 'payment', 'store', 'commerce']
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
}

export function ChannelsHub({ loading, error, data }: { loading: boolean; error: boolean; data: HomeChannels | undefined }) {
  const channels = groupPostingChannels(data?.channels ?? [])
  const available = data?.available ?? []
  const okCount = channels.filter((c) => c.state === 'ok').length
  return (
    <HomeBox
      labelledBy="home-channels"
      title="Kênh đã kết nối"
      icon={<Plug className="size-4 text-[var(--ring)]" aria-hidden />}
      aside={channels.length ? `${nf(okCount)}/${nf(channels.length)} đang chạy` : undefined}
    >
      {loading && <div className="space-y-3 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>}
      {!loading && error && <HomeEmpty>Không tải được danh sách kênh. Thử tải lại trang.</HomeEmpty>}
      {!loading && !error && channels.length === 0 && available.length === 0 && (
        <HomeEmpty
          testId="channels-empty"
          action={<Link href="/settings?tab=features" className={SMALL_BTN}>Bật tính năng kênh</Link>}
        >
          Chưa bật kênh nào. Bật Fanpage, Zalo OA, đăng đa kênh hoặc thanh toán ở Cài đặt › Tính năng để khách và đơn tự đổ về đây.
        </HomeEmpty>
      )}
      {!loading && !error && channels.length > 0 && (
        <ul data-testid="channels">
          {channels.slice(0, 7).map((c) => (
            <li key={c.key} className="border-t border-[var(--border)] first:border-t-0">
              <Link href={c.href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]">
                <span className="relative shrink-0" data-state={c.state}>
                  <ChannelMark c={c} />
                  <ChannelDot state={c.state} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-[var(--foreground)]">
                    {c.name}<span className="sr-only"> — {STATE_LABEL[c.state]}</span>
                  </span>
                  <span className="block truncate text-[13px] text-muted-foreground">{c.note}</span>
                </span>
                {c.today && (
                  <span className="shrink-0 text-right">
                    <span className={cn('block text-[16px] font-semibold tabular-nums', c.today.value > 0 ? 'text-[var(--foreground)]' : 'text-muted-foreground')}>{nf(c.today.value)}</span>
                    <span className="block text-[12px] text-muted-foreground">{c.today.label}</span>
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {!loading && !error && available.length > 0 && (
        <div className={cn('flex flex-wrap gap-2 px-4 py-3', channels.length > 0 && 'border-t border-[var(--border)]')} data-testid="channels-available">
          {available.map((a) => (
            <Link key={a.kind} href={a.href} className={cn(SMALL_BTN, 'border-dashed')}>
              <Plus className="mr-1 size-4" aria-hidden />Nối {a.label}
            </Link>
          ))}
        </div>
      )}
    </HomeBox>
  )
}

/* ------------------------------------------------------------------ */
/* Gợi ý bật thêm tính năng (người mới)                                 */
/* ------------------------------------------------------------------ */

/** Tính năng hay dùng nhất để gợi ý, theo thứ tự ưu tiên. */
export const SUGGESTED_FEATURES: readonly OrgFeatureKey[] = ['facebook_page', 'zalo_oa', 'social_posting', 'payments', 'online_store', 'products']
const DISMISS_KEY = 'trinity.home.feature-suggest.dismissed'
const noopSubscribe = () => () => {}
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function FeatureSuggestions() {
  const { can } = usePermissions()
  const { features, isLoading, locked = {} } = useOrgFeatures()
  const update = useUpdateOrgFeatures()
  const stored = useSyncExternalStore(noopSubscribe, readDismissed, () => true)
  const [hidden, setHidden] = useState(false)
  if (!can('settings.features') || isLoading || stored || hidden) return null
  const off = SUGGESTED_FEATURES.filter((k) => !features[k] && !locked[k]).slice(0, 4)
  if (off.length === 0) return null
  const dismiss = () => {
    setHidden(true)
    try {
      window.localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* trình duyệt chặn lưu: chỉ ẩn trong lần xem này */
    }
  }
  return (
    <section aria-labelledby="home-feature-suggest" className={cn(BOX, 'p-4')} data-testid="feature-suggest">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="home-feature-suggest" className="text-[15px] font-semibold text-[var(--foreground)]">Bật thêm tính năng</h2>
          <p className="mt-0.5 text-[14px] text-muted-foreground">Trinity mở ra gọn với bộ cơ bản. Bật thêm khi cần, menu sẽ hiện mục tương ứng. Có thể nhờ trợ lý AI bật giúp.</p>
        </div>
        <button type="button" onClick={dismiss} className="rounded-md p-1 text-muted-foreground hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] max-sm:min-h-11 max-sm:min-w-11" aria-label="Ẩn gợi ý">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {off.map((k) => (
          <li key={k} className="flex items-center gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-[var(--foreground)]">{ORG_FEATURES[k].label}</p>
              <p className="line-clamp-1 text-[13px] text-muted-foreground">{ORG_FEATURES[k].description}</p>
            </div>
            <button
              type="button"
              className={SMALL_BTN}
              disabled={update.isPending}
              onClick={() => update.mutate({ [k]: true }, {
                onSuccess: () => toast.success(`Đã bật “${ORG_FEATURES[k].label}”`),
                onError: () => toast.error('Không bật được, thử lại sau'),
              })}
            >
              Bật
            </button>
          </li>
        ))}
      </ul>
      <Link href="/settings?tab=features" className="mt-3 inline-flex items-center gap-1 rounded text-[14px] text-[var(--ring)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
        Xem tất cả tính năng <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </section>
  )
}
