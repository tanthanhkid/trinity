'use client'

/* Thẻ chỉ số: ô icon + nhãn ở HÀNG TRÊN, trị số lớn, nhãn biến động, và MỘT
 * HÌNH VẼ Ở CHÂN THẺ — nguyên tắc thiết kế: "chỉ số nào cũng đi kèm hình,
 * không có ô số trần". `computeDelta`/`SMALL_BASE_THRESHOLD`/field data GIỮ
 * NGUYÊN nghiệp vụ. Màu chỉ dùng token `--color-app-*` (KHÔNG hex mới) — 8
 * token nền-only (xem `__tests__/app-shell/contrast.test.ts`) dùng làm NỀN ô
 * icon, chữ/số vẫn đi qua `--color-app-navy`/`--color-app-ink-2`/trắng.
 */

import type { ElementType } from 'react'
import { Users, ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { ShellMiniBars } from '@/components/app-shell/charts/mini-bars'
import { ShellSpark } from '@/components/app-shell/charts/spark'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export interface KpiDelta {
  trend: 'up' | 'down' | 'flat'
  label: string
}

const SMALL_BASE_THRESHOLD = 5
const MAX_ABS_PCT = 999

/** Byte-identical với bản v1 — hàm THUẦN, không có lý do lệch giữa 2 luồng. */
export function computeDelta(current: number, previous: number): KpiDelta | null {
  const safeCurrent = Number.isFinite(current) ? current : 0
  const safePrev = Number.isFinite(previous) ? previous : 0
  if (safeCurrent === 0 && safePrev === 0) return null
  if (safePrev === 0) {
    return { trend: 'up', label: 'Mới' }
  }
  if (safeCurrent === safePrev) {
    return { trend: 'flat', label: '0%' }
  }
  const diff = safeCurrent - safePrev
  const trend: 'up' | 'down' = diff > 0 ? 'up' : 'down'
  const arrow = diff > 0 ? '+' : '-'
  const absDiff = Math.abs(diff)
  if (safePrev < SMALL_BASE_THRESHOLD) {
    return { trend, label: `${arrow}${absDiff}` }
  }
  const pct = Math.round((absDiff / safePrev) * 100)
  const label = pct > MAX_ABS_PCT ? `${arrow}>${MAX_ABS_PCT}%` : `${arrow}${pct}%`
  return { trend, label }
}

/**
 * Tông màu ô icon — CHỈ dùng token nền `--color-app-*` (không hex mới). Mirror
 * tập tông đã dùng ở bản v1 (violet/orange/sky/amber/indigo/blue/green/
 * emerald) nhưng quy về 6 token nền sẵn có của v2 — 2 tông trùng nhau
 * (orange→amber, indigo/emerald→primary) do bảng màu v2 không có đủ 8 sắc
 * riêng biệt; đây là quyết định thẩm mỹ chấp nhận được (không lệch NGHIỆP VỤ).
 */
export type KpiTone = 'violet' | 'sky' | 'amber' | 'blue' | 'green' | 'primary' | 'coral'

const TONE_BG: Record<KpiTone, string> = {
  violet: 'bg-[var(--color-app-violet)]',
  sky: 'bg-[var(--color-app-sky)]',
  amber: 'bg-[var(--color-app-amber)]',
  blue: 'bg-[var(--color-app-blue)]',
  green: 'bg-[var(--color-app-green)]',
  primary: 'bg-[var(--color-app-primary)]',
  coral: 'bg-[var(--color-app-coral)]',
}

/** Nền thẻ pha nhẹ theo tông — chỉ là nền, chữ vẫn navy/ink-2 trên thẻ gần trắng. */
const TONE_CARD: Record<KpiTone, string> = {
  violet: 'bg-gradient-to-br from-[var(--color-app-violet-soft)] to-[var(--card)] to-60%',
  sky: 'bg-gradient-to-br from-[var(--color-app-sky-soft)] to-[var(--card)] to-60%',
  amber: 'bg-gradient-to-br from-[var(--color-app-amber-soft)] to-[var(--card)] to-60%',
  blue: 'bg-gradient-to-br from-[var(--color-app-blue-soft)] to-[var(--card)] to-60%',
  green: 'bg-gradient-to-br from-[var(--color-app-green-soft)] to-[var(--card)] to-60%',
  primary: 'bg-gradient-to-br from-[var(--color-app-primary-soft)] to-[var(--card)] to-60%',
  coral: 'bg-gradient-to-br from-[var(--color-app-red-soft)] to-[var(--card)] to-60%',
}

export interface KpiCardProps {
  icon: ElementType
  title: string
  value: string
  subtitle?: string
  tooltip: string
  /** Tông ô icon + màu cột "hôm nay" — mặc định `primary` (teal của theme). */
  tone?: KpiTone
  currentValue?: number
  previousValue?: number
  compareLabel?: string
  /** Đơn vị đọc kèm nhãn biến động ("khách", "cơ hội"…) — `.ct-d` của theme. */
  unit?: string
  /** Chuỗi giá trị THẬT do caller cấp (vd 6 tháng) → vẽ đường xu hướng. Không truyền = 2 cột hôm qua/hôm nay. */
  sparkValues?: number[]
  /**
   * `false` = KHÔNG vẽ cặp cột "hôm qua/hôm nay" (thẻ so theo THÁNG hoặc chỉ số
   * tồn kho thì cặp cột đó sai nhãn) — khai tường minh, mặc định `true`.
 */
  plot?: boolean
  /** Câu thay cho "chưa phát sinh" khi không có biến động để hiện. */
  hint?: string
}

/**
 * Màu tô cột "hôm nay" của `ShellMiniBars`.
 *
 * 🔴 KHÔNG dùng thẳng token tông của ô icon. Tông icon là màu NỀN có chữ trắng
 * đè lên nên được phép sáng; còn cột biểu đồ nằm trên thẻ TRẮNG và phải đạt
 * chuẩn ĐỒ HOẠ 3:1 (WCAG 1.4.11) — đo ra 3 tông trượt: amber **2,17** ·
 * coral **2,54** · sky **2,70**.
 *
 * Nay ánh xạ sang **bảng màu DANH MỤC của kit** (`--color-app-chart-1..6`, bộ đã
 * qua `validate_palette.js` của dataviz) — đúng vai trò: đây là màu TÔ của hình,
 * không phải màu nền giao diện. Đo trên thẻ trắng: 3,29–5,33, đạt cả 7 tông.
 *
 * ⚠️ TUYỆT ĐỐI KHÔNG dùng `--color-app-chart-good/-warn/-bad` ở đây dù chúng đậm
 * hơn: đó là màu TRẠNG THÁI, dành riêng, không bao giờ làm màu series (luật ghi
 * ngay trong `app-tokens.css`).
 */
const TONE_FILL: Record<KpiTone, string> = {
  violet: "var(--color-app-chart-4)",
  sky: "var(--color-app-chart-3)",
  amber: "var(--color-app-chart-2)",
  blue: "var(--color-app-chart-3)",
  green: "var(--color-app-chart-5)",
  primary: "var(--color-app-chart-1)",
  coral: "var(--color-app-chart-6)",
}

/**
 * Thẻ chỉ số kiểu `.card.ctile` — hàng trên (ô icon + nhãn), trị số lớn, nhãn
 * biến động, hình vẽ ở chân thẻ.
 *
 * 🔴 Nhãn KHÔNG dùng `uppercase` dù theme khai `text-transform:uppercase` ở
 * `.ct-l` (nhãn tiếng Việt mất dấu thanh ở một số font/OS). Giữ
 * `letter-spacing` + `font-semibold` để vẫn ra đúng tầng phân cấp.
 */
export function KpiCard({
  icon: Icon,
  title,
  value,
  subtitle,
  tooltip,
  tone = "primary",
  currentValue,
  previousValue,
  compareLabel = "so hôm qua",
  unit,
  sparkValues,
  plot = true,
  hint,
}: KpiCardProps) {
  const series = sparkValues
  const hasPair = currentValue !== undefined && previousValue !== undefined
  const delta = hasPair ? computeDelta(currentValue, previousValue) : null
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <div className={cn("relative flex min-h-[160px] cursor-default flex-col overflow-hidden rounded-[var(--radius)] px-3.5 pt-[14px] shadow-[var(--shadow-card)] transition-shadow hover:shadow-[var(--shadow-pop)]", TONE_CARD[tone])} />
          }
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,.35),inset_0_-2px_4px_rgba(0,0,0,.14)]",
                TONE_BG[tone],
              )}
            >
              <Icon className="size-[18px]" strokeWidth={2.1} />
            </span>
            <p className="truncate text-sm font-semibold leading-tight text-[var(--color-app-navy)]">
              {title}
            </p>
          </div>

          <div className="mt-2 truncate text-[28px] font-bold leading-[1.2] tracking-[-0.02em] text-[var(--color-app-navy)] tabular-nums">
            {value}
          </div>

          <div className="mt-[3px] flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-[var(--color-app-ink-2)]">
            {delta ? (
              <DeltaBadge delta={delta} compareLabel={compareLabel} unit={unit} />
            ) : (
              /* 🔴 `computeDelta` trả `null` CHỈ khi hôm nay VÀ hôm qua đều 0.
                 Bản trước in thẳng `compareLabel` ⇒ thẻ hiện đúng chữ "so hôm
                 qua" trơ trọi, không số, không nghĩa — nhìn thấy ngay khi mở
                 màn Tổng quan. Nói thẳng điều đang
                 xảy ra thay vì để lại một mệnh đề cụt. */
              <span className="flex items-center gap-1 whitespace-nowrap text-[var(--color-app-ink-2)]">
                <Minus className="size-3 shrink-0" />
                {hint ?? `chưa phát sinh${unit ? ` · ${unit}` : ""}`}
              </span>
            )}
            {subtitle && (
              <span className="flex items-center gap-1 whitespace-nowrap">
                <Users className="size-3 shrink-0" />
                {subtitle}
              </span>
            )}
          </div>

          {/* `.ct-plot` — bám sát chân thẻ và tràn hết bề ngang (bù padding
              14px của thẻ) đúng như `margin:auto -14px 0` của theme. */}
          {/* Có chuỗi THẬT → vẽ đường xu hướng; không có → 2 cột "hôm qua/hôm nay" (số THẬT, KHÔNG nội suy từ 2 số — xem `mini-bars.tsx`). */}
          {series && series.length > 0 ? (
            <ShellSpark
              values={series}
              stroke={TONE_FILL[tone]}
              className="-mx-3.5 mt-auto px-3.5"
            />
          ) : (
            hasPair && plot && (
              <ShellMiniBars
                today={currentValue}
                yesterday={previousValue}
                fill={TONE_FILL[tone]}
                className="-mx-3.5 mt-auto px-3.5"
              />
            )
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[220px] text-center text-xs">
          {tooltip}
          {hasPair && (
            <span className="mt-1 block text-muted-foreground">
              {compareLabel.includes("tháng") ? "Tháng này" : "Hôm nay"}:{" "}
              {currentValue.toLocaleString("vi-VN")} ·{" "}
              {compareLabel.includes("tháng") ? "Tháng trước" : "Hôm qua"}:{" "}
              {previousValue.toLocaleString("vi-VN")}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function DeltaBadge({
  delta,
  compareLabel = "so hôm qua",
  unit,
}: {
  delta: KpiDelta
  compareLabel?: string
  unit?: string
}) {
  // `.trend.up/.down/.flat` của theme: xanh / đỏ / xám. Dùng token đã ĐO thay
  // cho bậc palette — `--color-app-primary-ink` 6,41:1 và
  // `--color-app-tag-red-ink` 5,91:1 trên nền thẻ trắng.
  const palette =
    delta.trend === "up"
      ? "text-[var(--color-app-primary-ink)]"
      : delta.trend === "down"
        ? "text-[var(--color-app-tag-red-ink)]"
        : "text-[var(--color-app-ink-2)]"
  const Icon =
    delta.trend === "up"
      ? ArrowUpRight
      : delta.trend === "down"
        ? ArrowDownRight
        : Minus
  return (
    /* 🔴 `whitespace-nowrap` chỉ đặt cho phần SỐ. Đặt cho cả khối (bản đầu) làm
       nhãn "so hôm qua · <đơn vị>" tràn khỏi thẻ và bị `overflow-hidden` CẮT
       NGANG CHỮ ở lưới 2 cột trên điện thoại trên màn hình 400px: thẻ có nhãn dài
       hiện "so hôm qua · cuộ". Nhãn phải được xuống dòng, `min-w-0` để flex
       cho phép co. */
    <span className={cn("flex min-w-0 flex-wrap items-center gap-x-1 text-sm font-bold", palette)}>
      <Icon className="size-3 shrink-0" />
      <span className="whitespace-nowrap tabular-nums">{delta.label}</span>
      <span className="min-w-0 font-normal text-[var(--color-app-ink-2)]">
        {compareLabel}
        {unit ? ` · ${unit}` : ""}
      </span>
    </span>
  )
}

export function KpiCardSkeleton() {
  return (
    <div className="flex min-h-[150px] flex-col rounded-2xl bg-[var(--card)] px-3.5 pt-3.5 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2">
        <Skeleton className="size-[26px] shrink-0 rounded-lg" />
        <Skeleton className="h-2.5 w-24" />
      </div>
      <Skeleton className="mt-[7px] h-6 w-20" />
      <Skeleton className="mt-[3px] h-2.5 w-28" />
      {/* Khung xương phải có ĐỦ chỗ của hình vẽ — thiếu là thẻ nhảy chiều cao
          khi dữ liệu về (thiết kế nói rõ: "khung xương đúng bố cục thẻ"). */}
      <Skeleton className="-mx-3.5 mt-auto h-14 rounded-none" />
    </div>
  )
}
