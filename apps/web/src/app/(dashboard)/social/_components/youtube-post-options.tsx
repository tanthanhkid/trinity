"use client"

import { useState } from "react"
import { ImageIcon, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  YOUTUBE_CATEGORY_LABELS,
  YOUTUBE_PRIVACY_LABELS,
  useYoutubePlaylists,
  type SocialAccount,
  type SocialLibraryItem,
  type YoutubeCategory,
  type YoutubePrivacy,
} from "@/hooks/use-social"
import { SocialLibrary } from "./social-library"

/** Lựa chọn đăng YouTube của một kênh. */
export interface YoutubeChoice {
  title: string
  privacy: YoutubePrivacy
  description: string
  tags: string
  category: YoutubeCategory
  kids: boolean
  playlist: string
  thumbnail: { key: string; name: string } | null
}

export const EMPTY_YOUTUBE_CHOICE: YoutubeChoice = { title: "", privacy: "private", description: "", tags: "", category: "22", kids: false, playlist: "", thumbnail: null }

/** Tags gõ cách nhau dấu phẩy → mảng sạch (BE kiểm tổng 500 ký tự). */
export const splitTags = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean)

/** `options` gửi BE cho một kênh YouTube. */
export function youtubeOptionsOf(c: YoutubeChoice) {
  return {
    title: c.title.trim() || undefined,
    privacy: c.privacy,
    description: c.description.trim() || undefined,
    tags: splitTags(c.tags).length ? splitTags(c.tags) : undefined,
    category_id: c.category,
    made_for_kids: c.kids,
    playlist_id: c.playlist || undefined,
    thumbnail_key: c.thumbnail?.key,
  }
}

/** Ngược của `youtubeOptionsOf`: `options` đã lưu → lựa chọn trên màn soạn (mở lại nháp). */
export function youtubeChoiceFrom(options: Record<string, unknown> | null | undefined): YoutubeChoice {
  const o = options ?? {}
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const privacy = str(o.privacy)
  const category = str(o.category_id)
  const thumb = str(o.thumbnail_key)
  return {
    title: str(o.title),
    privacy: privacy in YOUTUBE_PRIVACY_LABELS ? (privacy as YoutubePrivacy) : "private",
    description: str(o.description),
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string").join(", ") : "",
    category: category in YOUTUBE_CATEGORY_LABELS ? (category as YoutubeCategory) : "22",
    kids: o.made_for_kids === true,
    playlist: str(o.playlist_id),
    thumbnail: thumb ? { key: thumb, name: thumb.split("/").pop() ?? thumb } : null,
  }
}

const NO_PLAYLIST = "__none__"

/** Khối tuỳ chọn YouTube trong màn soạn bài: tiêu đề, mô tả, thẻ, danh mục, quyền xem, trẻ em, playlist, ảnh thumbnail. */
export function YoutubePostOptions({ account, value, onChange }: { account: SocialAccount; value: YoutubeChoice; onChange: (c: YoutubeChoice) => void }) {
  const set = (p: Partial<YoutubeChoice>) => onChange({ ...value, ...p })
  const playlists = useYoutubePlaylists(account.id, true)
  const [thumbOpen, setThumbOpen] = useState(false)
  const pickThumb = (m: SocialLibraryItem) => {
    set({ thumbnail: value.thumbnail?.key === m.key ? null : { key: m.key, name: m.name } })
    setThumbOpen(false)
  }

  return (
    <div className="space-y-2">
      <Input value={value.title} maxLength={100} placeholder="Tiêu đề video (bỏ trống = dòng đầu nội dung)" aria-label={`Tiêu đề video cho ${account.name}`} onChange={(e) => set({ title: e.target.value })} />
      <Textarea rows={3} value={value.description} maxLength={5000} placeholder="Mô tả video (bỏ trống = dùng nội dung bài)" aria-label={`Mô tả video cho ${account.name}`} onChange={(e) => set({ description: e.target.value })} />
      <Input value={value.tags} placeholder="Thẻ, cách nhau dấu phẩy (vd: bánh ngọt, công thức)" aria-label={`Thẻ video cho ${account.name}`} onChange={(e) => set({ tags: e.target.value })} />
      <div className="grid grid-cols-2 gap-2">
        <Select value={value.category} onValueChange={(v) => v && set({ category: v as YoutubeCategory })}>
          <SelectTrigger className="w-full" aria-label={`Danh mục video trên ${account.name}`}>
            <SelectValue>{(v) => YOUTUBE_CATEGORY_LABELS[v as YoutubeCategory] ?? null}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(YOUTUBE_CATEGORY_LABELS) as YoutubeCategory[]).map((k) => <SelectItem key={k} value={k}>{YOUTUBE_CATEGORY_LABELS[k]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={value.privacy} onValueChange={(v) => v && set({ privacy: v as YoutubePrivacy })}>
          <SelectTrigger className="w-full" aria-label={`Quyền xem video trên ${account.name}`}>
            <SelectValue>{(v) => YOUTUBE_PRIVACY_LABELS[v as YoutubePrivacy] ?? null}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(YOUTUBE_PRIVACY_LABELS) as YoutubePrivacy[]).map((k) => <SelectItem key={k} value={k}>{YOUTUBE_PRIVACY_LABELS[k]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Select value={value.playlist || NO_PLAYLIST} onValueChange={(v) => set({ playlist: !v || v === NO_PLAYLIST ? "" : v })}>
        <SelectTrigger className="w-full" aria-label={`Playlist trên ${account.name}`}>
          <SelectValue>{(v) => (v && v !== NO_PLAYLIST ? playlists.data?.find((p) => p.id === v)?.title ?? "Playlist" : "Không thêm vào playlist")}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PLAYLIST}>Không thêm vào playlist</SelectItem>
          {(playlists.data ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>)}
        </SelectContent>
      </Select>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <Checkbox checked={value.kids} onCheckedChange={(v) => set({ kids: v })} className="mt-0.5" />
        <span>
          Video dành cho trẻ em
          <span className="block text-xs text-muted-foreground">YouTube bắt buộc khai báo. Bật thì YouTube tắt bình luận và quảng cáo cá nhân hoá.</span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setThumbOpen(true)}>
          <ImageIcon className="size-4" /> {value.thumbnail ? "Đổi ảnh thumbnail" : "Chọn ảnh thumbnail"}
        </Button>
        {value.thumbnail && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="truncate">{value.thumbnail.name}</span>
            <button type="button" aria-label="Bỏ ảnh thumbnail" className="hover:text-foreground" onClick={() => set({ thumbnail: null })}><X className="size-3.5" /></button>
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">YouTube nhận đúng một video mỗi bài. Ảnh thumbnail JPG/PNG tối đa 2 MB; kênh chưa xác minh số điện thoại thì YouTube không nhận ảnh thumbnail riêng.</p>
      <Dialog open={thumbOpen} onOpenChange={setThumbOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Chọn ảnh thumbnail</DialogTitle>
            <DialogDescription>Bấm vào một ảnh JPG hoặc PNG trong thư viện.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <SocialLibrary initialType="image" pick={{ selected: value.thumbnail ? [value.thumbnail.key] : [], onToggle: pickThumb }} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setThumbOpen(false)}>Đóng</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
