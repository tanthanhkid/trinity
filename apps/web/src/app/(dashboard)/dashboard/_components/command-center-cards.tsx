'use client'

/* Bốn khối dữ liệu của "Trung tâm điều hành": dải chỉ số, phễu, nhiệt theo giờ, xếp hạng. Chỉ nhận props (không tự gọi API)
 * để test được; trạng thái tải/rỗng nằm trong từng khối. Màu chỉ dùng token sẵn có (chart-*, tag-*), có sáng/tối. */

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { formatNumber } from '@/lib/format'
import { HomeBox, HomeEmpty } from './home-box'
import type { CommandCenterData } from './use-command-center'
import {
  formatMoneyTr,
  funnelWidths,
  heatLevel,
  HEAT_DAYS,
  initialOf,
  peakLabel,
  stepRate,
  formatPct,
  type Delta,
} from './command-center-utils'

/* ---------------- Dải chỉ số ---------------- */

export interface KpiItem {
  key: string
  label: string
  /** Màu chấm nhãn (token chart). */
  dot: string
  value: string
  title?: string
  delta?: Delta
  note?: string
  tone?: 'ok' | 'warn' | 'bad' | 'muted'
}

const DELTA_CLS = { up: 'text-[var(--color-app-tag-green-ink)]', down: 'text-[var(--color-app-tag-red-ink)]', flat: 'text-muted-foreground' }
const VALUE_CLS = { ok: '', warn: 'text-[var(--color-app-tag-amber-ink)]', bad: 'text-[var(--color-app-tag-red-ink)]', muted: '' }

export function KpiStrip({ items, loading }: { items: KpiItem[]; loading?: boolean }) {
  const cols = items.length >= 6 ? 'lg:grid-cols-6' : items.length === 2 ? 'lg:grid-cols-2' : 'lg:grid-cols-3'
  return (
    <section
      aria-label="Chỉ số chính"
      data-testid="kpi-strip"
      className={cn('grid grid-cols-2 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)] sm:grid-cols-3', cols)}
    >
      {items.map((k) => (
        <div key={k.key} title={k.title} className="min-w-0 border-b border-r border-[var(--border)] px-3.5 py-2.5 transition-colors last:border-r-0 hover:bg-[var(--muted)] lg:border-b-0">
          <p className="flex items-center gap-1.5 truncate text-[14px] leading-4 text-muted-foreground">
            <i aria-hidden className="block size-[7px] shrink-0 rounded-[2px]" style={{ background: k.dot }} />
            {k.label}
          </p>
          <p className={cn('mt-0.5 truncate text-[22px] font-bold leading-[30px] tracking-[-0.02em] tabular-nums text-[var(--foreground)] xl:text-[24px]', VALUE_CLS[k.tone ?? 'ok'])}>
            {loading ? <Skeleton className="mt-1 h-6 w-20" /> : k.value}
          </p>
          {!loading && (k.delta?.text || k.note) && (
            <p className="truncate text-[14px] font-semibold leading-snug">
              {k.delta?.text && <span className={DELTA_CLS[k.delta.dir]}>{k.delta.text}</span>}
              {k.delta?.text && k.note ? <span className="font-medium text-muted-foreground"> · </span> : null}
              {k.note && <span className="font-medium text-muted-foreground">{k.note}</span>}
            </p>
          )}
        </div>
      ))}
    </section>
  )
}

/* ---------------- Phễu ---------------- */

const STAGE_META: Record<string, { label: string; color: string }> = {
  customers: { label: 'Khách mới', color: 'var(--color-app-primary)' },
  opportunities: { label: 'Có cơ hội', color: 'var(--color-app-chart-1)' },
  won: { label: 'Thắng', color: 'var(--color-app-chart-5)' },
}

export function FunnelCard({ data, loading, error, aside }: { data: CommandCenterData | undefined; loading: boolean; error: boolean; aside: string }) {
  const stages = data?.funnel.stages ?? []
  const widths = funnelWidths(stages.map((s) => s.count))
  const empty = stages.every((s) => s.count === 0)
  const [c, o, w] = stages.map((s) => s.count)
  const toOpp = stepRate(c ?? 0, o ?? 0)
  const toWon = stepRate(o ?? 0, w ?? 0)
  return (
    <HomeBox labelledBy="cc-funnel" title="Phễu bán hàng" aside={aside}>
      {loading ? (
        <div className="space-y-3 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
      ) : error ? (
        <HomeEmpty>Không tải được phễu bán hàng. Thử tải lại trang.</HomeEmpty>
      ) : empty ? (
        <HomeEmpty testId="funnel-empty">Chưa có khách mới hay cơ hội nào trong kỳ này. Khi có, phễu sẽ hiện ở đây.</HomeEmpty>
      ) : (
        <div className="grid gap-1.5 px-3.5 pb-3.5 pt-3" data-testid="funnel">
          {stages.map((s, i) => (
            <div key={s.key} className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2.5">
              <div className="text-right text-[14px] leading-4 text-[var(--color-app-ink-2)]">
                <b className="block text-[15px] tabular-nums text-[var(--foreground)]">{formatNumber(s.count)}</b>
                {STAGE_META[s.key]?.label}
              </div>
              <div className="h-10">
                <i
                  aria-hidden
                  className="mx-auto block h-full rounded-md"
                  style={{ width: `${widths[i]}%`, background: STAGE_META[s.key]?.color }}
                />
              </div>
            </div>
          ))}
          <div className="mt-1.5 flex flex-wrap gap-2 border-t border-dashed border-[var(--border)] pt-2.5 text-[14px]">
            {toOpp !== null && <span className="rounded-full bg-[var(--color-app-tag-teal-bg)] px-2 py-0.5 font-medium text-[var(--color-app-tag-teal-ink)]">{formatPct(toOpp)} có cơ hội</span>}
            {toWon !== null && <span className="rounded-full bg-[var(--color-app-tag-green-bg)] px-2 py-0.5 font-medium text-[var(--color-app-tag-green-ink)]">{formatPct(toWon)} chốt</span>}
            {data && data.funnel.stages[2].value ? (
              <span className="rounded-full bg-[var(--color-app-tag-blue-bg)] px-2 py-0.5 font-medium text-[var(--color-app-tag-blue-ink)]">
                {formatMoneyTr(data.funnel.stages[2].value ?? 0)} đã thắng
              </span>
            ) : null}
          </div>
        </div>
      )}
    </HomeBox>
  )
}

/* ---------------- Nhiệt theo giờ ---------------- */

export function HeatmapCard({ data, loading, error }: { data: CommandCenterData | undefined; loading: boolean; error: boolean }) {
  const h = data?.heatmap
  return (
    <HomeBox labelledBy="cc-heat" title="Mật độ hoạt động theo giờ" aside="7 ngày gần nhất">
      {loading ? (
        <div className="p-4"><Skeleton className="h-[200px] rounded-lg" /></div>
      ) : error ? (
        <HomeEmpty>Không tải được mật độ hoạt động. Thử tải lại trang.</HomeEmpty>
      ) : !h || h.total === 0 ? (
        <HomeEmpty testId="heatmap-empty">Chưa có hoạt động nào trong 7 ngày qua (tương tác, việc hoàn thành, tin nhắn).</HomeEmpty>
      ) : (
        <div className="px-3.5 pb-3 pt-2.5" data-testid="heatmap">
          <div className="grid grid-cols-[30px_repeat(24,minmax(0,1fr))] items-center gap-1" role="img" aria-label={`Bản đồ nhiệt hoạt động theo giờ, ${formatNumber(h.total)} hoạt động trong 7 ngày`}>
            <span />
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i} className="overflow-visible whitespace-nowrap text-center text-[11px] leading-3 text-muted-foreground">{i % 3 === 0 ? i : ''}</span>
            ))}
            {h.cells.map((row, d) => (
              <HeatRow key={d} label={HEAT_DAYS[d]} row={row} max={h.max} />
            ))}
          </div>
          <div className="mt-3.5 flex flex-wrap items-center gap-2 text-[14px] text-muted-foreground">
            <span>Ít</span>
            <span aria-hidden className="h-2 w-[90px] rounded-full" style={{ background: 'linear-gradient(90deg, var(--muted), var(--color-app-chart-1))' }} />
            <span>Nhiều</span>
            {h.peak_hours.length > 0 && <b className="w-full font-semibold text-[var(--foreground)]">{peakLabel(h.peak_hours)}</b>}
          </div>
        </div>
      )}
    </HomeBox>
  )
}

function HeatRow({ label, row, max }: { label: string; row: number[]; max: number }) {
  return (
    <>
      <span className="text-[12px] leading-[14px] text-muted-foreground">{label}</span>
      {row.map((v, hr) => (
        <span
          key={hr}
          title={`${label} ${String(hr).padStart(2, '0')}:00 · ${formatNumber(v)} hoạt động`}
          className="h-[30px] rounded-[4px] bg-[var(--muted)]"
          style={v > 0 ? { background: `color-mix(in srgb, var(--color-app-chart-1) ${heatLevel(v, max)}%, var(--muted))` } : undefined}
        />
      ))}
    </>
  )
}

/* ---------------- Xếp hạng ---------------- */

const MEDAL = ['bg-[var(--color-app-tag-amber-bg)] text-[var(--color-app-tag-amber-ink)]', 'bg-[var(--color-app-tag-slate-bg)] text-[var(--color-app-tag-slate-ink)]', 'bg-[var(--color-app-tag-pink-bg)] text-[var(--color-app-tag-pink-ink)]']

export function LeaderboardCard({ data, loading, error, aside, limit = 6 }: { data: CommandCenterData | undefined; loading: boolean; error: boolean; aside: string; limit?: number }) {
  const rows = (data?.leaderboard ?? []).slice(0, limit)
  const top = Math.max(1, ...rows.map((r) => r.won_value))
  return (
    <HomeBox labelledBy="cc-rank" title="Xếp hạng nhân viên" aside={`doanh thu ${aside}`}>
      {loading ? (
        <div className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 rounded-lg" />)}</div>
      ) : error ? (
        <HomeEmpty>Không tải được xếp hạng. Thử tải lại trang.</HomeEmpty>
      ) : rows.length === 0 ? (
        <HomeEmpty testId="leaderboard-empty">Chưa có thương vụ thắng hay việc hoàn thành nào trong kỳ này.</HomeEmpty>
      ) : (
        <ol className="py-1.5" data-testid="leaderboard">
          {rows.map((r, i) => (
            <li key={r.user_id} className="grid grid-cols-[22px_30px_minmax(0,1fr)_72px_84px] items-center gap-2.5 px-3.5 py-2">
              <span className={cn('grid size-[22px] place-items-center rounded-full text-[12px] font-bold', MEDAL[i] ?? 'text-muted-foreground')}>{i + 1}</span>
              <span aria-hidden className="grid size-[30px] place-items-center rounded-full bg-[var(--color-app-primary-soft)] text-[13px] font-semibold text-[var(--color-app-primary-ink)]">{initialOf(r.full_name)}</span>
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium text-[var(--foreground)]">{r.full_name}</span>
                <span className="block truncate text-[13px] text-muted-foreground">{formatNumber(r.won_count)} thắng · {formatNumber(r.tasks_done)} việc xong</span>
              </span>
              <span aria-hidden className="h-2 overflow-hidden rounded-full bg-[var(--muted)]">
                <i className="block h-full rounded-full" style={{ width: `${Math.max(4, (r.won_value / top) * 100)}%`, background: 'var(--color-app-primary)' }} />
              </span>
              <span className="text-right text-[14px] font-semibold tabular-nums text-[var(--foreground)]">{formatMoneyTr(r.won_value)}</span>
            </li>
          ))}
        </ol>
      )}
    </HomeBox>
  )
}
