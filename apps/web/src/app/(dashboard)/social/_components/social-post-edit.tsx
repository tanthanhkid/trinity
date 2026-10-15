"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { getApiErrorMessage } from "@/lib/api-client"
import { CAPTION_LIMITS, optionsForResubmit, useSocialAccounts, useSocialMutations, type SocialPost } from "@/hooks/use-social"
import { NETWORK_META, NetworkMark } from "./social-network-mark"
import { scheduleError } from "./social-composer"

/** ISO → giá trị ô `datetime-local` theo giờ máy người dùng. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Sửa bài đang hẹn giờ: nội dung chung, giờ hẹn, kênh. Kênh giữ lại dùng nguyên nội dung riêng + tuỳ chọn đã chọn lúc soạn;
 * kênh thêm mới dùng mặc định (YouTube riêng tư). Tệp đính kèm giữ nguyên.
 */
export function SocialPostEdit({ post, onClose }: { post: SocialPost; onClose: () => void }) {
  const { data: accounts = [] } = useSocialAccounts()
  const { update } = useSocialMutations()
  const live = post.targets.filter((t) => t.status !== "cancelled")
  const [content, setContent] = useState(post.content)
  const [at, setAt] = useState(post.scheduled_at ? toLocalInput(post.scheduled_at) : "")
  const [selected, setSelected] = useState<number[]>(live.map((t) => t.account_id))
  const active = accounts.filter((a) => a.status === "active")
  const chosen = active.filter((a) => selected.includes(a.id))
  const err = scheduleError(at)
  const tooLong = chosen.some((a) => {
    const t = live.find((x) => x.account_id === a.id)
    return (t?.caption ?? content).length > CAPTION_LIMITS[a.network]
  })

  const save = () => {
    update.mutate(
      {
        id: post.id,
        body: {
          content,
          media_keys: post.media.map((m) => m.key),
          scheduled_at: new Date(at).toISOString(),
          targets: chosen.map((a) => {
            const t = live.find((x) => x.account_id === a.id)
            if (t) return { account_id: a.id, caption: t.caption, options: optionsForResubmit(t.options) }
            // Kênh mới thêm vào bài đang gắn UTM thì gắn theo.
            const utm = live.map((x) => (x.options as Record<string, unknown> | null)?.utm).find(Boolean)
            const base = a.network === "youtube" ? { privacy: "private" } : {}
            return { account_id: a.id, options: utm ? { ...base, utm } : a.network === "youtube" ? base : undefined }
          }),
        },
      },
      {
        onSuccess: () => {
          toast.success(`Đã lưu bài #${post.id}`)
          onClose()
        },
        onError: (e) => toast.error(getApiErrorMessage(e, "Không lưu được bài")),
      },
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Sửa bài hẹn giờ #{post.id}</DialogTitle>
          <DialogDescription>Sửa được tới 1 phút trước giờ đăng. Tệp đính kèm giữ nguyên; muốn đổi tuỳ chọn riêng từng kênh thì huỷ bài và soạn lại.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} aria-label="Nội dung bài" />
          <div className="space-y-1">
            <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Giờ đăng" className="w-auto" />
            {err && <p className="text-xs text-destructive">{err}</p>}
          </div>
          <div className="divide-y divide-border rounded-lg ring-1 ring-border">
            {active.map((a) => {
              const kept = live.some((t) => t.account_id === a.id)
              // Kênh TikTok mới cần chọn quyền xem / tương tác như màn soạn bài ⇒ không thêm ở đây.
              const blocked = !kept && a.network === "tiktok"
              return (
              <label key={a.id} className={blocked ? "flex items-center gap-2.5 px-3 py-2 text-sm opacity-60" : "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm"} title={blocked ? "Thêm kênh TikTok: soạn bài mới để chọn quyền xem" : undefined}>
                <Checkbox checked={selected.includes(a.id)} disabled={blocked} onCheckedChange={(v) => setSelected((s) => (v ? [...s, a.id] : s.filter((x) => x !== a.id)))} />
                <NetworkMark network={a.network} />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate font-medium">{a.name}</span>
                  <span className="text-xs text-muted-foreground">{NETWORK_META[a.network]?.label ?? a.network}{kept ? "" : blocked ? " · thêm TikTok: soạn bài mới" : " · kênh mới"}</span>
                </span>
              </label>
              )
            })}
          </div>
          {live.some((t) => t.options?.utm) && <p className="text-xs text-muted-foreground">Bài gắn UTM vào liên kết — giữ nguyên khi lưu.</p>}
          {tooLong && <p className="text-xs text-destructive">Nội dung dài hơn giới hạn của một kênh đã chọn.</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Đóng</Button>
          <Button type="button" onClick={save} disabled={update.isPending || chosen.length === 0 || Boolean(err) || tooLong || (!content.trim() && post.media.length === 0)}>
            {update.isPending && <Loader2 className="size-4 animate-spin" />} Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
