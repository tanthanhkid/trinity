"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Share2 } from "lucide-react"
import { toast } from "sonner"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePermissions } from "@/lib/rbac/use-permissions"
import type { SocialDraft } from "@/hooks/use-social"
import { SocialCalendar } from "./social-calendar"
import { SocialChannels } from "./social-channels"
import { SocialComposer } from "./social-composer"
import { SocialDraftsList } from "./social-drafts-list"
import { SocialLibrary } from "./social-library"
import { SocialRecurrenceList } from "./social-recurrence"
import { SocialPostsList } from "./social-posts-list"
import { SocialStats } from "./social-stats"

const TABS = ["compose", "drafts", "calendar", "posts", "stats", "library", "channels"] as const
type Tab = (typeof TABS)[number]

const TAB_LABELS: ReadonlyArray<readonly [Tab, string]> = [
  ["compose", "Soạn bài"], ["drafts", "Nháp"], ["calendar", "Lịch"], ["posts", "Bài đã đăng"], ["stats", "Thống kê"], ["library", "Thư viện"], ["channels", "Kênh"],
]
const LINE_TAB = "h-full flex-none rounded-md px-2.5 group-data-horizontal/tabs:after:inset-x-2 group-data-horizontal/tabs:after:bottom-[-1px] after:rounded-full"

/** Đăng đa kênh: Soạn bài · Nháp · Lịch · Bài đã đăng · Thống kê · Thư viện · Kênh. `?tab=` mở thẳng tab, `?post=` tô sáng một bài, `?draft=` tô sáng một nháp (cùng `?tab=drafts`), `?media=` tô sáng một tệp thư viện, `?social=` là kết quả OAuth. */
export function SocialScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const { can } = usePermissions()
  const postParam = Number(params.get("post")) || undefined
  const mediaParam = Number(params.get("media")) || undefined
  const draftParam = Number(params.get("draft")) || undefined
  const initial = (params.get("tab") as Tab) ?? (postParam ? "posts" : mediaParam ? "library" : draftParam ? "drafts" : "compose")
  const [tab, setTab] = useState<Tab>(TABS.includes(initial) ? initial : "compose")
  const [highlight, setHighlight] = useState(postParam)
  // Ngày chọn từ lịch → mở Soạn bài với giờ hẹn điền sẵn (`n` đổi mỗi lần bấm để chọn lại cùng ngày vẫn điền).
  // Nháp đang mở trong Soạn bài (rời tab Soạn bài thì bỏ).
  const [draft, setDraft] = useState<SocialDraft | undefined>()
  const [preset, setPreset] = useState<{ at: string; n: number } | undefined>()

  const openPost = (id: number) => {
    setHighlight(id)
    setTab("posts")
    setTimeout(() => document.getElementById(`social-post-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 300)
  }

  useEffect(() => {
    const r = params.get("social")
    if (!r) return
    if (r === "connected") toast.success(`Đã liên kết ${params.get("count") ?? ""} kênh.`)
    else if (r === "cancelled") toast.info("Đã huỷ liên kết.")
    else toast.error(params.get("reason") || "Liên kết không thành công. Thử lại, hoặc kiểm cấu hình ứng dụng của mạng.")
    router.replace("/social?tab=channels")
  }, [params, router])

  if (!can("social.post")) return <p className="text-sm text-muted-foreground">Bạn chưa có quyền đăng bài mạng xã hội.</p>

  return (
    <div className="space-y-4">
      <ShellPageHeader title="Đăng đa kênh" icon={Share2} description="Soạn một lần, đăng ngay hoặc hẹn giờ ra các kênh đã liên kết" />
      <Tabs value={tab} onValueChange={(v) => { setTab(v as Tab); if (v !== "compose") setDraft(undefined) }} className="w-full">
        {/* Tab gạch chân — cùng kiểu Cài đặt › Kết nối & AI. */}
        <TabsList variant="line" className="mb-2 h-10 w-full justify-start gap-1 rounded-none border-b border-border p-0 max-sm:h-11">
          {TAB_LABELS.map(([v, label]) => (
            <TabsTrigger key={v} value={v} className={LINE_TAB}>{label}</TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="compose">
          <SocialComposer key={draft?.id ?? "new"} draft={draft} onCreated={(kind) => { setDraft(undefined); setTab(kind === "recurring" ? "calendar" : "posts") }} onGoChannels={() => setTab("channels")} onGoCalendar={() => setTab("calendar")} preset={preset} />
        </TabsContent>
        <TabsContent value="drafts">
          <SocialDraftsList highlight={draftParam} onOpen={(d) => { setDraft(d); setTab("compose") }} onCompose={() => setTab("compose")} />
        </TabsContent>
        <TabsContent value="calendar" className="space-y-4">
          <SocialCalendar onOpen={openPost} onSchedule={(at) => { setPreset((p) => ({ at, n: (p?.n ?? 0) + 1 })); setTab("compose") }} />
          <SocialRecurrenceList />
        </TabsContent>
        <TabsContent value="posts">
          <SocialPostsList highlight={highlight} onCompose={() => setTab("compose")} />
        </TabsContent>
        <TabsContent value="stats">
          <SocialStats onOpen={openPost} />
        </TabsContent>
        <TabsContent value="library">
          <SocialLibrary highlight={mediaParam} />
        </TabsContent>
        <TabsContent value="channels">
          <SocialChannels />
        </TabsContent>
      </Tabs>
    </div>
  )
}
