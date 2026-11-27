/**
 * Trung tâm điều hành (#607): logic thuần, các khối dữ liệu (tải / rỗng / có số) và dải cảnh báo Fanpage Facebook.
 */
import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

import {
  deltaOf, formatMoneyTr, formatPct, funnelWidths, heatLevel, peakLabel, periodRange, stepRate,
} from "@/app/(dashboard)/dashboard/_components/command-center-utils"
import { FacebookNudge, FACEBOOK_CONNECT_HREF } from "@/app/(dashboard)/dashboard/_components/facebook-nudge"
import { FunnelCard, HeatmapCard, KpiStrip, LeaderboardCard } from "@/app/(dashboard)/dashboard/_components/command-center-cards"
import type { CommandCenterData } from "@/app/(dashboard)/dashboard/_components/use-command-center"

const data = (over: Partial<CommandCenterData> = {}): CommandCenterData => ({
  scope_label: "Toàn công ty",
  funnel: {
    stages: [
      { key: "customers", count: 100, value: null },
      { key: "opportunities", count: 40, value: 9_000_000 },
      { key: "won", count: 10, value: 5_000_000 },
    ],
    by_status: { open: { count: 20, value: 1 }, won: { count: 10, value: 5_000_000 }, lost: { count: 10, value: 1 } },
  },
  heatmap: {
    cells: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 0 && h === 9 ? 5 : 0))),
    max: 5, total: 5, peak_hours: [9], timezone: "Asia/Ho_Chi_Minh",
  },
  leaderboard: [
    { user_id: 1, full_name: "Lê Hoa", won_count: 3, won_value: 184_200_000, tasks_done: 4 },
    { user_id: 2, full_name: "An", won_count: 1, won_value: 50_000_000, tasks_done: 0 },
  ],
  win_rate: { won: 10, lost: 10, rate: 50, previous: { won: 0, lost: 0, rate: null } },
  ...over,
})

describe("logic thuần", () => {
  it("kỳ chọn theo giờ VN", () => {
    expect(periodRange("today", "2026-11-27")).toEqual({ from: "2026-11-27", to: "2026-11-27" })
    expect(periodRange("7d", "2026-11-03")).toEqual({ from: "2026-10-28", to: "2026-11-03" })
    expect(periodRange("month", "2026-11-27")).toEqual({ from: "2026-11-01", to: "2026-11-27" })
  })
  it("tiền gọn không bao giờ mất chữ số đầu", () => {
    expect(formatMoneyTr(482_600_000)).toBe("482,6 tr")
    expect(formatMoneyTr(40_000_000)).toBe("40 tr")
    expect(formatMoneyTr(1_250_000_000)).toBe("1,3 tỷ")
    expect(formatMoneyTr(500_000)).toMatch(/^500\.000 ₫$/)
  })
  it("so kỳ trước: ▲▼, phần trăm chỉ khi kỳ trước > 0", () => {
    expect(deltaOf(123, 100)).toEqual({ dir: "up", text: "▲ 23% · +23" })
    expect(deltaOf(8, 0)).toEqual({ dir: "up", text: "▲ +8" })
    expect(deltaOf(5, 10).text).toBe("▼ 50% · −5")
    expect(deltaOf(0, 0)).toEqual({ dir: "flat", text: null })
    expect(formatPct(50)).toBe("50,0%")
  })
  it("phễu, nhiệt, cao điểm", () => {
    expect(funnelWidths([100, 40, 0, 1])).toEqual([100, 40, 0, 4])
    expect(stepRate(0, 5)).toBeNull()
    expect(stepRate(200, 50)).toBe(25)
    expect(heatLevel(0, 5)).toBe(0)
    expect(heatLevel(5, 5)).toBe(100)
    expect(peakLabel([10, 15])).toBe("Cao điểm: 10:00–11:00 và 15:00–16:00")
    expect(peakLabel([])).toBe("")
  })
})

describe("KpiStrip", () => {
  it("hiện số thật dạng chữ thường (không số lăn) kèm ▲", () => {
    render(<KpiStrip items={[{ key: "c", label: "Khách hàng", dot: "red", value: "1.284", delta: deltaOf(8, 0), note: "mới tháng này" }]} />)
    const strip = screen.getByTestId("kpi-strip")
    expect(within(strip).getByText("1.284")).toBeTruthy()
    expect(strip.textContent).toMatch(/▲ \+8/)
    expect(strip.textContent).toMatch(/mới tháng này/)
  })
})

describe("các khối dữ liệu", () => {
  it("có số: phễu, nhiệt, xếp hạng", () => {
    render(<><FunnelCard data={data()} loading={false} error={false} aside="7 ngày" /><HeatmapCard data={data()} loading={false} error={false} /><LeaderboardCard data={data()} loading={false} error={false} aside="7 ngày" /></>)
    expect(screen.getByTestId("funnel").textContent).toMatch(/100.*Khách mới.*40.*Có cơ hội.*10.*Thắng/)
    expect(screen.getByTestId("funnel").textContent).toMatch(/40,0% có cơ hội/)
    expect(screen.getByTestId("heatmap").textContent).toMatch(/Cao điểm: 09:00–10:00/)
    expect(within(screen.getByTestId("leaderboard")).getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByTestId("leaderboard").textContent).toMatch(/184,2 tr/)
  })
  it("rỗng và tải", () => {
    const empty = data({
      funnel: { stages: [{ key: "customers", count: 0, value: null }, { key: "opportunities", count: 0, value: 0 }, { key: "won", count: 0, value: 0 }], by_status: data().funnel.by_status },
      heatmap: { cells: [], max: 0, total: 0, peak_hours: [], timezone: "x" },
      leaderboard: [],
    })
    const { container, rerender } = render(<><FunnelCard data={empty} loading={false} error={false} aside="" /><HeatmapCard data={empty} loading={false} error={false} /><LeaderboardCard data={empty} loading={false} error={false} aside="" /></>)
    expect(screen.getByTestId("funnel-empty")).toBeTruthy()
    expect(screen.getByTestId("heatmap-empty")).toBeTruthy()
    expect(screen.getByTestId("leaderboard-empty")).toBeTruthy()
    rerender(<><FunnelCard data={undefined} loading error={false} aside="" /><HeatmapCard data={undefined} loading error={false} /><LeaderboardCard data={undefined} loading error={false} aside="" /></>)
    expect(container.querySelector('[data-testid="funnel"]')).toBeNull()
    expect(container.querySelectorAll('[class*="animate-pulse"], [data-slot="skeleton"]').length).toBeGreaterThan(0)
  })
})

describe("FacebookNudge", () => {
  it("chưa nối + có quyền ⇒ hiện, nêu hậu quả, nút tới mục Facebook", () => {
    render(<FacebookNudge unconnected canManage />)
    const box = screen.getByTestId("facebook-nudge")
    expect(box.textContent).toMatch(/Tin nhắn và bình luận từ Fanpage chưa về/)
    expect(screen.getByTestId("facebook-nudge-cta")).toHaveAttribute("href", FACEBOOK_CONNECT_HREF)
    expect(FACEBOOK_CONNECT_HREF).toBe("/connections?muc=facebook")
  })
  it("đã nối ⇒ ẩn", () => {
    const { container } = render(<FacebookNudge unconnected={false} canManage />)
    expect(container.firstChild).toBeNull()
  })
  it("không quyền ⇒ câu nhắc báo quản trị viên, không nút", () => {
    render(<FacebookNudge unconnected canManage={false} />)
    expect(screen.getByTestId("facebook-nudge").textContent).toMatch(/báo quản trị viên/)
    expect(screen.queryByTestId("facebook-nudge-cta")).toBeNull()
  })
})
