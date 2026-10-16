"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Check, Copy, Loader2 } from "lucide-react"
import apiClient from "@/lib/api-client"
import { cn } from "@/lib/utils"

/** Agent người dùng chọn — khớp `CONNECT_AGENTS` ở API (`services/crm/src/setup/connect-prompts.ts`). */
export const AGENT_CHOICES = [
  { key: "chatgpt", label: "ChatGPT", logo: "/brand/ai/chatgpt.svg" },
  { key: "claude", label: "Claude (web / Desktop)", logo: "/brand/ai/claude.svg" },
  { key: "claude_code", label: "Claude Code", logo: "/brand/ai/claude.svg" },
  { key: "antigravity", label: "Antigravity", logo: null },
  { key: "gemini_cli", label: "Gemini CLI", logo: "/brand/ai/gemini.svg" },
  { key: "cursor", label: "Cursor", logo: null },
  { key: "codex", label: "Codex CLI", logo: "/brand/ai/chatgpt.svg" },
  { key: "vscode", label: "VS Code Copilot", logo: null },
  { key: "other", label: "Agent khác", logo: null },
] as const

export type AgentChoice = (typeof AGENT_CHOICES)[number]["key"]

interface ConnectPromptResponse {
  agent: AgentChoice
  mcp_url: string
  prompt: string
}

export function useConnectPrompt(agent: AgentChoice, enabled = true) {
  return useQuery<ConnectPromptResponse>({
    queryKey: ["setup", "connect-prompt", agent],
    queryFn: async () => (await apiClient.get<ConnectPromptResponse>("/setup/connect-prompt", { params: { agent } })).data,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/**
 * Bước 1 onboarding: chọn trợ lý AI đang dùng → chép MỘT prompt đủ ngữ cảnh (địa chỉ thật của hệ thống, cách đăng nhập,
 * cách gắn đúng của agent đó, rule/skill nên tạo, việc đầu tiên cần làm). Dán vào agent là agent tự làm phần còn lại.
 */
export function AgentConnect() {
  const [agent, setAgent] = useState<AgentChoice>("chatgpt")
  const [copied, setCopied] = useState(false)
  const q = useConnectPrompt(agent)
  const label = AGENT_CHOICES.find((a) => a.key === agent)?.label ?? ""

  async function copy() {
    if (!q.data) return
    try {
      await navigator.clipboard.writeText(q.data.prompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="space-y-3" data-testid="agent-connect">
      <p className="text-sm font-medium">Bạn dùng trợ lý AI nào?</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Chọn trợ lý AI">
        {AGENT_CHOICES.map((a) => (
          <button
            key={a.key}
            type="button"
            role="radio"
            aria-checked={agent === a.key}
            onClick={() => { setAgent(a.key); setCopied(false) }}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition max-sm:min-h-11",
              agent === a.key ? "border-primary bg-primary/10 font-medium text-foreground" : "bg-card text-muted-foreground hover:bg-muted",
            )}
          >
            {a.logo && (
              <span className="grid size-5 place-items-center rounded-full border bg-white" aria-hidden>
                {/* eslint-disable-next-line @next/next/no-img-element -- logo tĩnh trong /public */}
                <img src={a.logo} alt="" className="size-3.5 object-contain" />
              </span>
            )}
            {a.label}
          </button>
        ))}
      </div>

      {q.isError ? (
        <p className="text-sm text-amber-700" data-testid="agent-prompt-error">Chưa lấy được hướng dẫn: máy chủ chưa bật kết nối trợ lý AI. Nhờ quản trị viên bật rồi thử lại.</p>
      ) : (
        <div className="space-y-2 rounded-xl border bg-background p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              Bấm <b>Copy prompt</b> rồi dán vào {label}. {label} sẽ tự nối với Trinity, mở trang đăng nhập để bạn bấm Cho phép, rồi hỏi bạn về công ty để dựng hệ thống.
            </p>
            <button
              type="button"
              onClick={copy}
              disabled={!q.data}
              data-testid="agent-prompt-copy"
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-primary-foreground transition max-sm:min-h-11",
                copied ? "bg-emerald-600" : "bg-primary hover:opacity-90",
                !q.data && "opacity-60",
              )}
            >
              {q.isLoading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
              {copied ? "Đã copy" : "Copy prompt"}
            </button>
          </div>
          <span className="sr-only" aria-live="polite">{copied ? `Đã chép prompt cho ${label}` : ""}</span>
          <details className="group">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Xem nội dung sẽ được copy</summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed" data-testid="agent-prompt-text">
              {q.data?.prompt ?? "Đang tải…"}
            </pre>
          </details>
        </div>
      )}
    </div>
  )
}
