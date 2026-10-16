"use client"

import { useState, type ReactNode } from "react"
import { CopyButton } from "@/app/(dashboard)/settings/_components/integrations/secret-reveal-dialog"
import { AgentConnect } from "./agent-connect"
import { SETUP_PROMPTS } from "@/app/(dashboard)/bat-dau/_components/setup-prompts"
import { SocialChannels } from "@/app/(dashboard)/social/_components/social-channels"
import { SocialComposer } from "@/app/(dashboard)/social/_components/social-composer"
import type { WizardStepKey } from "@/hooks/use-onboarding-wizard"

const prompt = (key: string) => SETUP_PROMPTS.find((p) => p.key === key)?.text ?? ""

/** Câu mẫu thêm cho wizard — lời người dùng thường, không tên công cụ. */
export const WIZARD_PROMPTS = {
  hello: "Trinity của mình đang có gì? Kể ngắn gọn cho mình nghe.",
  contact: "Thêm giúp mình một khách hàng: tên <tên khách>, số điện thoại <số điện thoại>, ghi chú <khách quan tâm gì>.",
  post: "Soạn giúp mình một bài ngắn giới thiệu công ty để đăng lên Fanpage. Cho mình xem trước, mình đồng ý thì đăng.",
} as const

export function PromptBox({ title, text }: { title: string; text: string }) {
  return (
    <div className="space-y-1.5 rounded-xl border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <CopyButton value={text} label={title} />
      </div>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{text}</p>
    </div>
  )
}

function StepAi() {
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Chọn trợ lý AI bạn đang dùng, bấm <b>Copy prompt</b>.</li>
        <li>Dán vào trợ lý AI. Nó tự nối với Trinity và mở trang đăng nhập; bạn đăng nhập rồi bấm Cho phép.</li>
        <li>Trợ lý AI hỏi bạn về công ty để dựng hệ thống. Thấy nó trả lời được là đã nối xong.</li>
      </ol>
      <AgentConnect />
    </div>
  )
}

function StepBuild() {
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Chép câu mẫu bên dưới, dán vào khung chat với trợ lý AI đã nối với Trinity.</li>
        <li>Trả lời từng câu AI hỏi về cách công ty bạn đang làm.</li>
        <li>AI tóm tắt lại, bạn đồng ý là AI dựng danh sách và màn hình trên Trinity.</li>
      </ol>
      <PromptBox title="Câu mẫu: dựng hệ thống" text={prompt("build")} />
    </div>
  )
}

function StepData() {
  return (
    <div className="space-y-4">
      <p className="text-sm">Đưa ít nhất một dữ liệu thật vào Trinity. Chọn một trong hai cách:</p>
      <PromptBox title="Cách 1: nhập file đang dùng (Google Sheet, Excel)" text={prompt("import")} />
      <PromptBox title="Cách 2: thêm một khách đầu tiên" text={WIZARD_PROMPTS.contact} />
      <p className="text-sm text-muted-foreground">Thay phần trong dấu &lt; &gt; bằng thông tin thật trước khi gửi. Dữ liệu chỉ người trong công ty bạn xem được.</p>
    </div>
  )
}

function StepChannels() {
  return (
    <div className="space-y-4">
      <p className="text-sm">Bấm <b>Liên kết</b> ở Facebook (Fanpage) hoặc YouTube, đăng nhập và đồng ý trên trang của Facebook/Google. Xong sẽ quay lại đây, kênh hiện <b>Hoạt động</b>.</p>
      <SocialChannels />
    </div>
  )
}

function StepPost({ onGoChannels }: { onGoChannels: () => void }) {
  const [sent, setSent] = useState(false)
  return (
    <div className="space-y-4">
      <p className="text-sm">Soạn một bài, chọn kênh rồi bấm <b>Đăng ngay</b>. Bài sẽ lên kênh thật của công ty, nên viết nội dung bạn muốn khách thấy.</p>
      {sent && <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" role="status">Đã gửi bài đi đăng. Chờ khoảng nửa phút rồi bấm “Tôi đã làm xong”.</p>}
      <SocialComposer onCreated={() => setSent(true)} onGoChannels={onGoChannels} />
      <PromptBox title="Hoặc nhờ trợ lý AI soạn và đăng" text={WIZARD_PROMPTS.post} />
    </div>
  )
}

export const STEP_TEXT: Record<WizardStepKey, { title: string; why: string }> = {
  ai: {
    title: "Kết nối trợ lý AI của bạn",
    why: "Trinity làm việc qua trợ lý AI bạn đang dùng (ChatGPT, Claude hoặc Gemini). Chưa nối thì chưa làm được gì, nên đây là bước đầu tiên.",
  },
  build: {
    title: "Dựng quy trình cho công ty",
    why: "Kể cho trợ lý AI công ty bạn làm gì. AI hỏi vài câu rồi dựng danh sách, màn hình và các bước xử lý theo đúng cách công ty bạn đang làm.",
  },
  data: {
    title: "Đưa dữ liệu đầu tiên vào",
    why: "Trinity cần dữ liệu thật để bắt đầu theo dõi: danh sách khách, đơn hàng hay học viên bạn đang có.",
  },
  channels: {
    title: "Kết nối Fanpage hoặc kênh YouTube",
    why: "Nối kênh của công ty để đăng bài từ Trinity và để khách nhắn Fanpage tự thành khách hàng.",
  },
  post: {
    title: "Đăng bài đầu tiên",
    why: "Thử đăng một bài lên kênh vừa nối để chắc mọi thứ chạy đúng.",
  },
}

export function StepBody({ step, onGoChannels }: { step: WizardStepKey; onGoChannels: () => void }): ReactNode {
  switch (step) {
    case "ai":
      return <StepAi />
    case "build":
      return <StepBuild />
    case "data":
      return <StepData />
    case "channels":
      return <StepChannels />
    case "post":
      return <StepPost onGoChannels={onGoChannels} />
  }
}
