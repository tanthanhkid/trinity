"use client"

import Link from "next/link"
import { useEffect } from "react"
import { ArrowRight, CheckCircle2, CircleDashed, Loader2, PlugZap, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { CopyButton } from "@/app/(dashboard)/settings/_components/integrations/secret-reveal-dialog"
import { useAiActionsPendingCount } from "@/hooks/ai-actions/use-ai-actions"
import { formatDateTimeVn } from "@/lib/format"
import { usePermissions } from "@/lib/rbac"
import { useCompleteSetup, useSetupStatus } from "@/hooks/use-setup-status"
import { useMarkOnboardingSeen, useOnboarding } from "@/hooks/use-onboarding"
import { cn } from "@/lib/utils"
import { ConnectSteps } from "./connect-steps"
import { OnboardingChecklist } from "./onboarding-checklist"
import { OnboardingIntro } from "./onboarding-intro"
import { SETUP_PROMPTS } from "./setup-prompts"

const STATUS_TEXT = {
  chua_dung: { badge: "Hệ thống còn trống", body: "Hệ thống đang trống. Làm lần lượt các bước bên dưới: nối trợ lý AI của bạn, rồi kể cho AI công ty bạn làm gì. AI hỏi vài câu và dựng danh sách, màn hình, menu ngay sau khi bạn đồng ý." },
  dang_dung: { badge: "Đang dựng", body: "Menu và màn hình đã có. Nhờ trợ lý AI đưa dữ liệu từ Google Sheet hoặc Excel bạn đang dùng vào. Xong thì bấm Hoàn tất (hoặc nói với AI là đã dựng xong)." },
  da_dung: { badge: "Công ty đã có quy trình", body: "Mỗi ngày: mở Tổng quan xem việc hôm nay, hoặc hỏi trợ lý AI \"hôm nay có gì mới\". Muốn thêm hay đổi gì, cứ nói với AI. AI chỉ làm được trong phạm vi quyền của bạn, và mọi việc AI làm đều ghi lại ở mục Hoạt động AI để bạn xem lại. Dữ liệu chỉ người trong công ty bạn xem được, theo quyền từng người." },
} as const

export function BatDauScreen() {
  const { data, status, isLoading } = useSetupStatus()
  const pending = useAiActionsPendingCount(!!data?.mcp_url).data ?? 0
  const complete = useCompleteSetup()
  const { can } = usePermissions()
  const isAdmin = can("integrations.ai_admin")
  const onboarding = useOnboarding()
  const markSeen = useMarkOnboardingSeen()
  const unseen = onboarding.data && !onboarding.data.seen
  useEffect(() => {
    if (unseen && markSeen.isIdle) markSeen.mutate()
  }, [unseen, markSeen])
  if (isLoading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải…</div>
  const t = STATUS_TEXT[status]
  const canBuild = data?.can_build ?? false

  return (
    <div className="mx-auto max-w-3xl space-y-5 py-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-foreground">Chào mừng bạn đến với Trinity</h1>
          <Badge variant={status === "da_dung" ? "secondary" : "outline"} data-testid="setup-status">{t.badge}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Trinity là nơi công ty bạn làm việc cùng trợ lý AI: bạn nói việc cần làm bằng lời, Trinity lưu lại và sắp xếp gọn để cả công ty cùng theo dõi.
          Trang này giới thiệu nhanh Trinity có gì và việc nên làm tiếp. Mở lại bất cứ lúc nào ở mục <strong>Bắt đầu</strong> trên menu.
        </p>
      </div>

      <OnboardingIntro />

      <OnboardingChecklist progress={onboarding.data} />
      <p className="text-sm text-muted-foreground">{t.body}</p>

      {!canBuild && status !== "da_dung" && (
        <Card><CardContent className="py-4 text-sm">Hệ thống đang chờ quản trị viên dựng quy trình. Khi xong, menu sẽ tự hiện.</CardContent></Card>
      )}

      <Card id="ket-noi-ai" className="scroll-mt-20">
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <PlugZap className="size-4 text-primary" aria-hidden />
            <p className="text-sm font-semibold">Kết nối Trinity với trợ lý AI của bạn</p>
            {data?.ai_connected ? (
              <span className="inline-flex items-center gap-1 text-sm text-emerald-700" data-testid="ai-connected"><CheckCircle2 className="size-4" /> AI của bạn đang hoạt động</span>
            ) : data?.ai_granted ? (
              <span className="flex w-full items-start gap-1.5 text-sm text-amber-700" data-testid="ai-idle">
                <CircleDashed className="mt-0.5 size-4 shrink-0" />
                <span>
                  Đã cấp quyền cho AI nhưng chưa thấy hoạt động{data.ai_last_active_at ? ` từ ${formatDateTimeVn(data.ai_last_active_at)}` : ""}.
                  Nếu bạn đã ngắt kết nối bên AI, hãy <Link href="/settings" className="underline">thu hồi quyền ở Cài đặt</Link> rồi kết nối lại.
                </span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-sm text-muted-foreground" data-testid="ai-not-connected"><CircleDashed className="size-4" /> Bạn chưa kết nối AI{data?.ai_connected_anyone ? " (đã có người khác trong công ty kết nối)" : ""}</span>
            )}
          </div>
          {data?.mcp_url ? (
            <p className="text-sm text-muted-foreground">Đây là địa chỉ Trinity của công ty bạn. Bấm Sao chép, rồi bấm tên trợ lý AI bạn đang dùng bên dưới để xem từng bước dán địa chỉ này vào đâu. Trong ngoặc là gói của trợ lý AI dùng được việc này.</p>
          ) : null}
          {data?.mcp_url ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all" data-testid="connect-url">{data.mcp_url}</code>
              <CopyButton value={data.mcp_url} label="địa chỉ kết nối" />
            </div>
          ) : (
            isAdmin ? (
            <p className="text-sm text-amber-700" data-testid="mcp-off-admin">
              Kết nối AI chưa được bật trên máy chủ. Đặt biến môi trường <code className="rounded bg-muted px-1">INTEGRATIONS_MCP_ENABLED=true</code> và{" "}
              <code className="rounded bg-muted px-1">INTEGRATIONS_SECRET_KEY</code> (tạo bằng <code className="rounded bg-muted px-1">openssl rand -base64 32</code>), rồi <strong>deploy lại / khởi động lại</strong> để có hiệu lực.
              Nếu không chạy trên Vercel, cần thêm <code className="rounded bg-muted px-1">INTEGRATIONS_PUBLIC_BASE_URL</code> (địa chỉ công khai của hệ thống).
            </p>
          ) : (
            <p className="text-sm text-amber-700" data-testid="mcp-off-user">Tính năng Kết nối AI chưa được bật cho công ty bạn. Hãy nhờ quản trị viên Trinity bật tính năng này.</p>
          )
          )}
          <ConnectSteps />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex items-center gap-2"><Sparkles className="size-4 text-primary" aria-hidden /><p className="text-sm font-semibold">Câu mẫu: chép rồi dán vào khung chat với trợ lý AI</p></div>
          <p className="text-sm text-muted-foreground">Dùng sau khi đã kết nối trợ lý AI ở phần trên. Chưa kết nối thì AI chưa làm được gì trên Trinity.</p>
          {SETUP_PROMPTS.map((p) => (
            <div key={p.key} className="space-y-1 rounded-xl border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{p.title}</p>
                <CopyButton value={p.text} label={p.title} />
              </div>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{p.text}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        {status !== "chua_dung" && (
          <Link href="/dashboard" className={cn(buttonVariants({ variant: "outline" }))}>
            Vào trang Tổng quan <ArrowRight aria-hidden />
          </Link>
        )}
        <Link href="/ai-actions" className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline">
          {pending > 0 ? `Có ${pending} thay đổi của AI đang chờ bạn duyệt` : "Xem hoạt động của AI"}
        </Link>
        {status === "dang_dung" && canBuild && (
          <Button type="button" disabled={complete.isPending} onClick={() => complete.mutate(undefined, { onSuccess: () => toast.success("Đã hoàn tất dựng quy trình") })}>
            {complete.isPending && <Loader2 className="animate-spin" aria-hidden />} Hoàn tất dựng
          </Button>
        )}
      </div>
    </div>
  )
}
