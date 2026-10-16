import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const get = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => get(...a) } }))

import { AgentConnect, AGENT_CHOICES } from "@/components/onboarding-wizard/agent-connect"

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><AgentConnect /></QueryClientProvider>)
}

describe("AgentConnect — bước 1 onboarding", () => {
  beforeEach(() => {
    get.mockReset()
    get.mockImplementation(async (_url: string, opts: { params: { agent: string } }) => ({
      data: { agent: opts.params.agent, mcp_url: "https://x/api/v1/mcp", prompt: `PROMPT ${opts.params.agent} — dùng MCP server` },
    }))
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } })
  })

  it("đủ 9 lựa chọn; đổi agent thì tải đúng prompt của agent đó", async () => {
    renderIt()
    expect(screen.getAllByRole("radio")).toHaveLength(AGENT_CHOICES.length)
    fireEvent.click(screen.getByRole("radio", { name: /Antigravity/ }))
    await waitFor(() => expect(screen.getByTestId("agent-prompt-text").textContent).toContain("PROMPT antigravity"))
    expect(get).toHaveBeenCalledWith("/setup/connect-prompt", { params: { agent: "antigravity" } })
  })

  it("Copy prompt chép đúng nội dung và báo 'Đã copy'", async () => {
    renderIt()
    await waitFor(() => expect(screen.getByTestId("agent-prompt-text").textContent).toContain("PROMPT chatgpt"))
    fireEvent.click(screen.getByTestId("agent-prompt-copy"))
    await waitFor(() => expect(screen.getByTestId("agent-prompt-copy").textContent).toContain("Đã copy"))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("PROMPT chatgpt — dùng MCP server")
  })

  it("chữ trên giao diện (ngoài nội dung prompt) không có 'MCP'", async () => {
    const { container } = renderIt()
    await waitFor(() => expect(screen.getByTestId("agent-prompt-text").textContent).toContain("PROMPT"))
    const clone = container.cloneNode(true) as HTMLElement
    clone.querySelector("[data-testid=agent-prompt-text]")?.remove()
    expect(clone.textContent).not.toMatch(/MCP/)
  })

  it("máy chủ chưa bật kết nối AI ⇒ báo rõ, không nút copy hỏng", async () => {
    get.mockRejectedValue(Object.assign(new Error("404"), { response: { status: 404 } }))
    renderIt()
    expect(await screen.findByTestId("agent-prompt-error")).toBeTruthy()
  })
})
