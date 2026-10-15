"use client"

import { Loader2 } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { getApiErrorMessage } from "@/lib/api-client"
import { TIKTOK_PRIVACY_LABELS, useTiktokCreatorInfo, type SocialAccount, type TiktokCreatorInfo, type TiktokPrivacy } from "@/hooks/use-social"

/** Lựa chọn đăng TikTok của một kênh. Mọi công tắc mặc định TẮT, quyền xem không chọn sẵn (UX guidelines của TikTok). */
export interface TiktokChoice {
  privacy?: TiktokPrivacy
  comment: boolean
  duet: boolean
  stitch: boolean
  commercial: boolean
  brandOrganic: boolean
  brandContent: boolean
}

export const EMPTY_TIKTOK_CHOICE: TiktokChoice = { privacy: undefined, comment: false, duet: false, stitch: false, commercial: false, brandOrganic: false, brandContent: false }

export const TIKTOK_MUSIC_URL = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
export const TIKTOK_BRANDED_URL = "https://www.tiktok.com/legal/page/global/bc-policy/en"

/** `options` gửi BE cho một kênh TikTok. */
export function tiktokOptionsOf(c: TiktokChoice, info: TiktokCreatorInfo | undefined, durationSec: number | null | undefined) {
  return {
    privacy_level: c.privacy,
    allow_comment: c.comment && !info?.comment_disabled,
    allow_duet: c.duet && !info?.duet_disabled,
    allow_stitch: c.stitch && !info?.stitch_disabled,
    brand_organic: c.commercial && c.brandOrganic,
    brand_content: c.commercial && c.brandContent,
    video_duration_sec: durationSec ?? undefined,
  }
}

/** Lý do chưa đăng được lên kênh TikTok này (null = đăng được). `durationSec` undefined = đang đo. */
export function tiktokBlocker(c: TiktokChoice, info: TiktokCreatorInfo | undefined, durationSec: number | null | undefined): string | null {
  if (!info) return "Đang lấy thông tin tài khoản TikTok…"
  if (!c.privacy) return "Chọn ai được xem video."
  if (!info.privacy_level_options.includes(c.privacy)) return "Tài khoản không còn cho quyền xem đã chọn — chọn lại."
  if (c.commercial && !c.brandOrganic && !c.brandContent) return "Bạn đã bật công bố nội dung thương mại: chọn ít nhất một loại."
  if (c.commercial && c.brandContent && c.privacy === "SELF_ONLY") return "Nội dung có thương hiệu không thể để Chỉ mình tôi."
  if (durationSec === undefined) return "Đang đo thời lượng video…"
  const max = info.max_video_post_duration_sec
  if (max != null && durationSec != null && durationSec > max) return `Video dài ${Math.round(durationSec)} giây, tài khoản này đăng được tối đa ${max} giây.`
  return null
}

function Toggle({ label, checked, disabled, note, onChange }: { label: string; checked: boolean; disabled: boolean; note?: string; onChange: (v: boolean) => void }) {
  return (
    <label className={disabled ? "flex items-start gap-2 text-sm opacity-60" : "flex cursor-pointer items-start gap-2 text-sm"}>
      <Checkbox checked={checked && !disabled} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
      <span>
        {label}
        {note && <span className="block text-xs text-muted-foreground">{note}</span>}
      </span>
    </label>
  )
}

/** Khối tuỳ chọn TikTok trong màn soạn bài: tài khoản đăng, quyền xem, tương tác, công bố thương mại, thời lượng. */
export function TiktokPostOptions({ account, value, onChange, durationSec }: { account: SocialAccount; value: TiktokChoice; onChange: (c: TiktokChoice) => void; durationSec: number | null | undefined }) {
  const q = useTiktokCreatorInfo(account.id, true)
  const info = q.data
  const set = (p: Partial<TiktokChoice>) => onChange({ ...value, ...p })

  if (q.isLoading) return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Đang lấy thông tin tài khoản TikTok…</p>
  if (q.isError || !info) {
    return (
      <div className="space-y-1 text-xs">
        <p className="text-destructive">{getApiErrorMessage(q.error, "Không lấy được thông tin tài khoản TikTok.")}</p>
        <button type="button" className="text-primary hover:underline" onClick={() => q.refetch()}>Thử lại</button>
      </div>
    )
  }

  const options = info.privacy_level_options.filter((p): p is TiktokPrivacy => p in TIKTOK_PRIVACY_LABELS)
  const max = info.max_video_post_duration_sec
  const tooLong = max != null && durationSec != null && durationSec !== undefined && durationSec > max
  const handle = info.username ? `@${info.username}` : null

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5 rounded-md bg-muted/50 px-2.5 py-2">
        {info.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- ảnh đại diện từ CDN của TikTok, không qua next/image
          <img src={info.avatar_url} alt="" className="size-8 rounded-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <span className="size-8 rounded-full bg-muted" />
        )}
        <span className="min-w-0 text-xs leading-tight">
          <span className="block text-muted-foreground">Đăng lên tài khoản TikTok</span>
          <span className="block truncate text-sm font-medium">{info.nickname || account.name}{handle && <span className="font-normal text-muted-foreground"> {handle}</span>}</span>
        </span>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium">Ai được xem video này</p>
        <Select value={value.privacy ?? null} onValueChange={(v) => v && set({ privacy: v as TiktokPrivacy })}>
          <SelectTrigger className="w-full" aria-label={`Ai được xem video trên ${account.name}`}>
            <SelectValue placeholder="Chọn quyền xem">{(v) => (v ? TIKTOK_PRIVACY_LABELS[v as TiktokPrivacy] ?? null : "Chọn quyền xem")}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((k) => {
              const off = k === "SELF_ONLY" && value.commercial && value.brandContent
              return <SelectItem key={k} value={k} disabled={off}>{TIKTOK_PRIVACY_LABELS[k]}{off ? " (không dùng được với nội dung có thương hiệu)" : ""}</SelectItem>
            })}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium">Cho phép người xem</p>
        <Toggle label="Bình luận" checked={value.comment} disabled={info.comment_disabled} note={info.comment_disabled ? "Tài khoản đã tắt trong cài đặt TikTok" : undefined} onChange={(v) => set({ comment: v })} />
        <Toggle label="Duet" checked={value.duet} disabled={info.duet_disabled} note={info.duet_disabled ? "Tài khoản đã tắt trong cài đặt TikTok" : undefined} onChange={(v) => set({ duet: v })} />
        <Toggle label="Stitch" checked={value.stitch} disabled={info.stitch_disabled} note={info.stitch_disabled ? "Tài khoản đã tắt trong cài đặt TikTok" : undefined} onChange={(v) => set({ stitch: v })} />
      </div>

      <div className="space-y-2">
        <label className="flex cursor-pointer items-start justify-between gap-3 text-sm">
          <span>
            Công bố nội dung thương mại
            <span className="block text-xs text-muted-foreground">Bật nếu video quảng bá bạn, một thương hiệu, sản phẩm hoặc dịch vụ.</span>
          </span>
          <Switch checked={value.commercial} onCheckedChange={(v) => set({ commercial: v, ...(v ? {} : { brandOrganic: false, brandContent: false }) })} aria-label="Công bố nội dung thương mại" />
        </label>
        {value.commercial && (
          <div className="space-y-1.5 pl-1">
            <Toggle label="Thương hiệu của bạn" checked={value.brandOrganic} disabled={false} note={'Bạn quảng bá chính mình hoặc doanh nghiệp của mình. Video sẽ được gắn nhãn "Promotional content".'} onChange={(v) => set({ brandOrganic: v })} />
            <Toggle
              label="Nội dung có thương hiệu"
              checked={value.brandContent}
              disabled={false}
              note={'Bạn quảng bá cho một thương hiệu hoặc bên thứ ba. Video sẽ được gắn nhãn "Paid partnership".'}
              onChange={(v) => set({ brandContent: v, ...(v && value.privacy === "SELF_ONLY" ? { privacy: undefined } : {}) })}
            />
            {!value.brandOrganic && !value.brandContent && <p className="text-xs text-destructive">Chọn ít nhất một loại để tiếp tục.</p>}
          </div>
        )}
      </div>

      {tooLong ? (
        <p className="text-xs text-destructive">Video dài {Math.round(durationSec!)} giây, tài khoản này đăng được tối đa {max} giây.</p>
      ) : (
        max != null && <p className="text-xs text-muted-foreground">Tài khoản này đăng được video tối đa {max} giây.</p>
      )}
      <p className="text-xs text-muted-foreground">TikTok nhận đúng một video mỗi bài. Sau khi đăng, TikTok cần vài phút để xử lý video trước khi video hiện trên hồ sơ.</p>
    </div>
  )
}
