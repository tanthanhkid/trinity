"use client"

import { Bot, MessagesSquare, Send, Shapes, type LucideIcon } from "lucide-react"
import { useOrgFeatures } from "@/hooks/use-org-features"

interface Feature {
  key: string
  icon: LucideIcon
  title: string
  body: string
  show?: (f: ReturnType<typeof useOrgFeatures>["features"]) => boolean
}

/** "Trinity làm được gì" — lời theo định vị: điều hành bằng trợ lý AI quen dùng, không nói chuyện kỹ thuật. */
const FEATURES: readonly Feature[] = [
  {
    key: "ai",
    icon: Bot,
    title: "Điều hành bằng trợ lý AI bạn đang dùng",
    body: "Nối ChatGPT, Claude hoặc Gemini với Trinity. Hỏi tình hình, thêm khách, giao việc bằng lời, như nhắn cho một nhân viên.",
  },
  {
    key: "build",
    icon: Shapes,
    title: "Hệ thống may theo cách công ty bạn làm",
    body: "Muốn quản lý gì (học viên, đơn hàng, lịch hẹn, kho…) thì kể cho AI. AI tạo danh sách, màn hình và các bước xử lý ngay, không cần lập trình.",
  },
  {
    key: "social",
    icon: Send,
    title: "Soạn một lần, đăng mọi kênh",
    body: "Viết bài, gắn ảnh hoặc video, bấm một nút là lên Fanpage Facebook và kênh YouTube của công ty cùng lúc.",
    show: (f) => f.social_posting !== false,
  },
  {
    key: "messenger",
    icon: MessagesSquare,
    title: "Khách nhắn Fanpage vào thẳng danh sách khách",
    body: "Mỗi người nhắn vào Page thành một khách hàng có người phụ trách, tin nhắn ghi vào lịch sử chăm sóc. Không sót khách.",
    show: (f) => f.facebook_page !== false && f.contacts !== false,
  },
]

export function OnboardingIntro() {
  const { features } = useOrgFeatures()
  const items = FEATURES.filter((x) => !x.show || x.show(features))
  return (
    <section aria-labelledby="trinity-co-gi" className="space-y-3">
      <h2 id="trinity-co-gi" className="text-sm font-semibold text-foreground">Trinity làm được gì cho bạn</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map(({ key, icon: Icon, title, body }) => (
          <div key={key} className="flex gap-3 rounded-xl border bg-card p-4" data-testid={`intro-${key}`}>
            <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold leading-snug">{title}</p>
              <p className="text-sm text-muted-foreground">{body}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
