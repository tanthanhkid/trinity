import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { LeadScoreBadge } from "@/components/lead-score-badge"
import { LeadScoreCard } from "@/app/(dashboard)/contacts/[id]/_components/lead-score-card"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { buildContactFilterParams } from "@/hooks/use-contacts"

describe("LeadScoreBadge", () => {
  it("hiện điểm + nhãn tiếng Việt", () => {
    render(<LeadScoreBadge score={82} label="hot" />)
    expect(screen.getByText("82 · Nóng")).toBeTruthy()
  })
  it("chưa chấm → dấu gạch", () => {
    render(<LeadScoreBadge score={null} label={null} />)
    expect(screen.getByText("—")).toBeTruthy()
  })
})

describe("LeadScoreCard", () => {
  const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>)
  it("chưa chấm → không render gì", () => {
    const { container } = wrap(<LeadScoreCard contactId="1" score={null} label={null} reasons={null} scoredAt={null} />)
    expect(container.querySelector("[data-testid=lead-score-card]")).toBeNull()
  })
  it("hiện từng lý do với điểm/tối đa", () => {
    wrap(<LeadScoreCard contactId="1" score={58} label="warm" reasons={[{ key: "recency", label: "Độ mới liên hệ", points: 25, max: 25 }]} scoredAt={null} />)
    expect(screen.getByText("Độ mới liên hệ")).toBeTruthy()
    expect(screen.getByText("25/25")).toBeTruthy()
    expect(screen.getByText("58 · Ấm")).toBeTruthy()
  })
})

describe("buildContactFilterParams", () => {
  it("leadLabel → lead_label; 'all' bị bỏ", () => {
    expect(buildContactFilterParams({ leadLabel: "unscored" }).lead_label).toBe("unscored")
    expect(buildContactFilterParams({ leadLabel: "all" }).lead_label).toBeUndefined()
  })
})
