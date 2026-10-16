'use client'

import { ShellChartCard } from '@/components/app-shell/charts/chart-card'
import { ShellDonut } from '@/components/app-shell/charts/donut'
import { CHART_PALETTE } from '@/components/app-shell/charts/chart-data'
import { CHART_STATUS } from '@/components/app-shell/charts/chart-colors'
import type { DashboardOverviewData } from './use-dashboard-overview'

const nf = (n: number) => n.toLocaleString('vi-VN')

/** Rút gọn TRỤC/nhãn cột (tỷ/triệu); bảng "Bảng" vẫn in số đầy đủ. */
export function formatMoneyAxis(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tỷ`
  if (v >= 1e6) return `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr`
  return nf(v)
}

export function DealStatusChart({ data, className }: { data: DashboardOverviewData; className?: string }) {
  const s = data.deal_status
  const total = s.open + s.won + s.lost
  return (
    <ShellChartCard
      className={className}
      title="Cơ hội theo trạng thái"
      subtitle={`Trên tổng ${nf(total)} thương vụ`}
      table={{
        columns: ['Trạng thái', 'Thương vụ'],
        rows: total > 0 ? [['Đang mở', nf(s.open)], ['Đã thắng', nf(s.won)], ['Đã thua', nf(s.lost)]] : [],
      }}
      empty="Chưa có thương vụ nào"
    >
      <ShellDonut
        items={[
          { label: 'Đang mở', value: s.open, color: CHART_PALETTE[0] },
          { label: 'Đã thắng', value: s.won, color: CHART_STATUS.good },
          { label: 'Đã thua', value: s.lost, color: CHART_STATUS.bad },
        ]}
        centerValue={nf(total)}
        centerLabel="thương vụ"
      />
    </ShellChartCard>
  )
}
