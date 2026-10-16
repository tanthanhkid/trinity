"use client"

import Link from "next/link"
import { CheckCircle2, Circle, Copy } from "lucide-react"
import { toast } from "sonner"
import type { OrgFeatureKey, Permission } from "@trinity/rbac"
import { Button, buttonVariants } from "@/components/ui/button"
import { useOrgFeatures } from "@/hooks/use-org-features"
import type { OnboardingProgress } from "@/hooks/use-onboarding"
import { usePermissions } from "@/lib/rbac"
import { cn } from "@/lib/utils"
import { SETUP_PROMPTS } from "./setup-prompts"

type Action =
  | { kind: "link"; href: string; label: string; permission?: Permission; feature?: OrgFeatureKey }
  | { kind: "copy"; prompt: string; label: string }

interface Step {
  key: string
  title: string
  body: string
  done: (p: OnboardingProgress) => boolean
  /** Bước tính chung cả công ty — có thể đồng nghiệp đã làm, nên nói rõ khi hiện dấu xong. */
  shared?: boolean
  /** Ai làm được bước này — thiếu quyền thì báo nhờ quản trị viên thay vì đưa nút dẫn tới lỗi. */
  permission?: Permission
  feature?: OrgFeatureKey
  actions: readonly Action[]
}

const promptText = (key: string) => SETUP_PROMPTS.find((p) => p.key === key)?.text ?? ""

const STEPS: readonly Step[] = [
  {
    key: "ai",
    title: "Kết nối trợ lý AI của bạn",
    body: "Nối ChatGPT, Claude hoặc Gemini với Trinity, mất khoảng hai phút. Từ đó bạn ra lệnh cho Trinity ngay trong khung chat quen thuộc.",
    done: (p) => p.ai_connected,
    actions: [{ kind: "link", href: "#ket-noi-ai", label: "Xem cách kết nối" }],
  },
  {
    key: "build",
    title: "Dựng quy trình đầu tiên",
    body: "Làm sau bước 1. Chép câu mẫu, dán vào khung chat với trợ lý AI. AI hỏi bạn vài câu về cách công ty đang làm rồi dựng danh sách, màn hình và các bước xử lý cho bạn.",
    done: (p) => p.workspace_built,
    shared: true,
    permission: "custom_objects.manage",
    actions: [{ kind: "copy", prompt: promptText("build"), label: "Chép câu mẫu" }],
  },
  {
    key: "data",
    title: "Đưa dữ liệu đang có vào",
    body: "Đang theo dõi khách bằng Google Sheet hay Excel? Gửi file cho trợ lý AI, AI xếp từng cột vào đúng chỗ rồi nhập giúp bạn. Cũng có thể thêm khách tay. Dữ liệu chỉ người trong công ty bạn xem được.",
    done: (p) => p.has_data,
    shared: true,
    actions: [
      { kind: "copy", prompt: promptText("import"), label: "Chép câu mẫu" },
      { kind: "link", href: "/contacts", label: "Thêm khách tay", permission: "contacts.create", feature: "contacts" },
    ],
  },
  {
    key: "channels",
    title: "Kết nối Fanpage và kênh YouTube",
    body: "Nối Fanpage Facebook và kênh YouTube của công ty để đăng bài từ Trinity. Bật nhận tin nhắn Fanpage để người nhắn vào Page tự thành khách hàng.",
    done: (p) => p.channel_linked,
    shared: true,
    actions: [
      { kind: "link", href: "/social?tab=channels", label: "Kết nối kênh đăng bài", permission: "social.manage", feature: "social_posting" },
      { kind: "link", href: "/connections?muc=facebook", label: "Nhận tin nhắn Fanpage", permission: "integrations.webhooks", feature: "facebook_page" },
    ],
  },
  {
    key: "post",
    title: "Đăng bài đầu tiên",
    body: "Soạn một bài, chọn kênh, bấm Đăng ngay. Hoặc nhờ trợ lý AI soạn và đăng giúp, AI cho bạn xem trước rồi mới đăng.",
    done: (p) => p.first_post,
    shared: true,
    permission: "social.post",
    feature: "social_posting",
    actions: [{ kind: "link", href: "/social?tab=compose", label: "Soạn bài" }],
  },
]

async function copyPrompt(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success("Đã chép câu mẫu. Dán vào khung chat với trợ lý AI nhé.")
  } catch {
    toast.error("Không chép được, hãy bôi đen câu mẫu ở cuối trang để chép.")
  }
}

/** Danh sách việc cần làm tiếp. Dấu xong lấy từ dữ liệu thật (`GET /setup/onboarding`), mỗi bước có nút đi thẳng tới chỗ làm. */
export function OnboardingChecklist({ progress }: { progress: OnboardingProgress | undefined }) {
  const { features } = useOrgFeatures()
  const { can } = usePermissions()
  const actionOk = (a: Action) => a.kind === "copy" || ((!a.feature || features[a.feature] !== false) && (!a.permission || can(a.permission)))
  const steps = STEPS.filter((s) => (!s.feature || features[s.feature] !== false) && s.actions.some((a) => a.kind === "copy" || !a.feature || features[a.feature] !== false))
  const doneCount = progress ? steps.filter((s) => s.done(progress)).length : 0

  return (
    <section aria-labelledby="viec-can-lam" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="viec-can-lam" className="text-sm font-semibold text-foreground">Việc cần làm tiếp</h2>
        <span className="text-sm text-muted-foreground" data-testid="onboarding-progress">Đã xong {doneCount}/{steps.length}</span>
      </div>
      <p className="text-sm text-muted-foreground">Không bắt buộc làm hết một lúc. Bước nào xong, dấu tích tự hiện.</p>
      <ol className="divide-y rounded-xl border bg-card">
        {steps.map((s, i) => {
          const done = progress ? s.done(progress) : false
          const allowed = !s.permission || can(s.permission)
          const actions = s.actions.filter(actionOk)
          return (
            <li key={s.key} className="flex gap-3 p-4" data-testid={`step-${s.key}`} data-done={done}>
              {done ? (
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-label="Đã xong" />
              ) : (
                <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-label="Chưa xong" />
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <p className={cn("text-sm font-semibold", done && "text-muted-foreground line-through decoration-1")}>
                  <span className="sr-only">Bước {i + 1}: </span>{s.title}
                </p>
                {done && s.shared && <p className="text-sm text-muted-foreground">Công ty bạn đã làm xong bước này, có thể do đồng nghiệp làm.</p>}
                {!done && <p className="text-sm text-muted-foreground">{s.body}</p>}
                {!done && !allowed && <p className="text-sm text-amber-700">Bước này do quản trị viên của công ty làm. Bạn nhắn quản trị viên nhé.</p>}
                {!done && allowed && actions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {actions.map((a, j) =>
                      a.kind === "copy" ? (
                        <Button key={a.label} type="button" size="sm" variant={j === 0 ? "default" : "outline"} onClick={() => copyPrompt(a.prompt)}>
                          <Copy aria-hidden /> {a.label}
                        </Button>
                      ) : (
                        <Link key={a.href} href={a.href} className={cn(buttonVariants({ size: "sm", variant: j === 0 ? "default" : "outline" }))}>
                          {a.label}
                        </Link>
                      ),
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
