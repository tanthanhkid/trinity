'use client'

import { useState } from 'react'
import { ShellChartCard } from '@/components/app-shell/charts/chart-card'
import { ShellArea } from '@/components/app-shell/charts/area'
import { CHART_PALETTE } from '@/components/app-shell/charts/chart-data'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import { formatMoneyAxis } from './dashboard-overview-charts'
import type { DashboardOverviewData } from './use-dashboard-overview'
import { formatNumber } from '@/lib/format'

type TabKey = 'customers' | 'opportunities' | 'revenue'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'customers', label: 'Khách hàng' },
  { key: 'opportunities', label: 'Cơ hội' },
  { key: 'revenue', label: 'Doanh thu' },
]

const nf = formatNumber

/**
 * "Biểu đồ tổng quan": 1 thẻ, 3 tab (Khách hàng · Cơ hội · Doanh
 * thu) vẽ đường/vùng 6 tháng từ CHÍNH các chuỗi `dashboard-overview` đã có —
 * không endpoint mới. Không có tab "Công việc": BE không trả chuỗi theo tháng
 * cho công việc, không bịa số. Nút "Bảng" của thẻ vẫn cho đọc số chính xác.
 */
export function OverviewTabbedChart({ data }: { data: DashboardOverviewData }) {
  const [tab, setTab] = useState<TabKey>('customers')
  const revenue = data.revenue_by_month.map((v) => v ?? 0)
  const cfg = {
    customers: { name: 'Khách hàng mới', values: data.customers_by_month, fmt: nf, empty: 'Chưa có khách hàng mới trong 6 tháng qua' },
    opportunities: { name: 'Cơ hội mới', values: data.opportunities_by_month, fmt: nf, empty: 'Chưa có cơ hội mới trong 6 tháng qua' },
    revenue: { name: 'Doanh thu (₫)', values: revenue, fmt: formatMoneyAxis, empty: 'Chưa có thương vụ thắng nào trong 6 tháng qua' },
  }[tab]
  const hasData = cfg.values.some((v) => v > 0)
  const rows = data.months.map((m, i) => [
    m,
    tab === 'revenue' ? (data.revenue_by_month[i] === null ? '—' : formatCurrency(data.revenue_by_month[i] as number)) : nf(cfg.values[i] ?? 0),
  ])
  return (
    <ShellChartCard
      className="min-h-[300px] lg:col-span-2"
      title="Biểu đồ tổng quan"
      subtitle="6 tháng gần nhất"
      table={{ columns: ['Tháng', cfg.name], rows }}
      chartNotice={hasData ? undefined : cfg.empty}
      tools={
        <div role="tablist" aria-label="Chỉ số biểu đồ" className="flex flex-wrap gap-1 max-sm:max-w-full max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:[scrollbar-width:none]">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'rounded-full px-3 py-1 max-sm:min-h-11 max-sm:shrink-0 max-sm:px-4 text-[14px] font-medium transition-colors',
                tab === t.key
                  ? 'bg-primary/10 text-primary'
                  : 'text-[var(--color-app-ink-2)] hover:bg-[var(--color-app-surface-3)]',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      <ShellArea
        categories={data.months}
        series={[{ name: cfg.name, values: cfg.values, color: CHART_PALETTE[0] }]}
        formatValue={cfg.fmt}
        height={220}
      />
    </ShellChartCard>
  )
}
