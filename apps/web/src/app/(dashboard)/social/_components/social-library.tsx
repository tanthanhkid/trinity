"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Check, EyeOff, ImagePlus, Images, Loader2, Search, Video } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { getApiErrorMessage } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { uploadSocialFile, useHideSocialMedia, useSocialLibrary, useSocialMediaPreview, type SocialLibraryItem } from "@/hooks/use-social"

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm"
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const day = (iso: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(iso))

function Thumb({ m }: { m: SocialLibraryItem }) {
  const { url, isError } = useSocialMediaPreview(m.id, m.type === "image")
  if (m.type === "video")
    return (
      <div className="flex size-full flex-col items-center justify-center gap-1 bg-muted text-muted-foreground">
        <Video className="size-8" />
        <span className="text-xs">Video</span>
      </div>
    )
  if (isError) return <div className="flex size-full items-center justify-center bg-muted text-xs text-muted-foreground">Không xem được</div>
  if (!url) return <div className="size-full animate-pulse bg-muted" />
  // eslint-disable-next-line @next/next/no-img-element -- ảnh tải qua BE (object URL), next/image không tối ưu được
  return <img src={url} alt={m.name} className="size-full object-cover" />
}

/**
 * Thư viện ảnh/video đăng bài dùng chung trong công ty. `pick` = chọn tệp cho bài đang soạn; không có `pick` = xem, tải lên,
 * ẩn khỏi thư viện (ẩn không xoá tệp — bài cũ vẫn dùng).
 */
export function SocialLibrary({ pick, highlight, initialType }: { pick?: { selected: string[]; onToggle: (m: SocialLibraryItem) => void }; highlight?: number; initialType?: "image" | "video" }) {
  const qc = useQueryClient()
  const [type, setType] = useState<"image" | "video" | undefined>(initialType)
  const [q, setQ] = useState("")
  const [search, setSearch] = useState("")
  const lib = useSocialLibrary(type, search)
  const hide = useHideSocialMedia()
  const [hiding, setHiding] = useState<SocialLibraryItem | null>(null)
  const [uploading, setUploading] = useState(0)
  const items = lib.data?.pages.flatMap((p) => p.data) ?? []

  const addFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? [])
    if (!list.length) return
    setUploading((n) => n + list.length)
    let ok = 0
    for (const f of list) {
      try {
        await uploadSocialFile(f, () => undefined)
        ok++
      } catch (err) {
        toast.error(`${f.name}: ${getApiErrorMessage(err, "Tải tệp không thành công")}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
    if (ok) toast.success(`Đã thêm ${ok} tệp vào thư viện`)
    await qc.invalidateQueries({ queryKey: ["social", "library"] })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label="Loại tệp">
          {([[undefined, "Tất cả"], ["image", "Ảnh"], ["video", "Video"]] as const).map(([t, label]) => (
            <Button key={label} size="sm" variant={type === t ? "soft" : "outline"} aria-pressed={type === t} onClick={() => setType(t)}>{label}</Button>
          ))}
        </div>
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()) }}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm theo tên tệp" aria-label="Tìm theo tên tệp" className="h-8 w-48" />
          <Button type="submit" size="icon" variant="outline" className="size-8" aria-label="Tìm"><Search className="size-4" /></Button>
        </form>
        {!pick && (
          <label className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} Tải ảnh / video lên
            <input type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => { void addFiles(e.target.files); e.target.value = "" }} />
          </label>
        )}
      </div>

      {lib.isError && <p className="text-sm text-destructive">{getApiErrorMessage(lib.error, "Không tải được thư viện")}</p>}
      {lib.isLoading ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Đang tải" />
      ) : items.length === 0 ? (
        <EmptyState icon={Images} message={search || type ? "Không có tệp khớp bộ lọc." : "Thư viện trống. Ảnh/video tải lên khi soạn bài sẽ tự vào đây để dùng lại."} />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6" data-testid="social-library-grid">
          {items.map((m) => {
            const chosen = pick?.selected.includes(m.key) ?? false
            return (
              <li key={m.id} id={`social-media-${m.id}`} className={cn("group overflow-hidden rounded-lg border bg-card", (chosen || m.id === highlight) && "ring-2 ring-primary")} data-testid="social-library-item">
                <button type="button" className="relative block aspect-square w-full" disabled={!pick} onClick={() => pick?.onToggle(m)} aria-pressed={pick ? chosen : undefined} aria-label={pick ? `Chọn ${m.name}` : m.name}>
                  <Thumb m={m} />
                  {chosen && <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="size-4" /></span>}
                </button>
                <div className="flex items-center gap-1 px-2 py-1.5 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={m.name}>{m.name}</p>
                    <p className="text-muted-foreground">{kb(m.size)} · {day(m.created_at)}{m.source === "mcp" ? " · AI" : ""}</p>
                  </div>
                  {!pick && (
                    <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Ẩn ${m.name} khỏi thư viện`} title="Ẩn khỏi thư viện" onClick={() => setHiding(m)}>
                      <EyeOff className="size-4" />
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {lib.hasNextPage && (
        <Button variant="outline" size="sm" onClick={() => lib.fetchNextPage()} disabled={lib.isFetchingNextPage}>
          {lib.isFetchingNextPage && <Loader2 className="size-4 animate-spin" />} Xem thêm
        </Button>
      )}

      <ConfirmDialog
        open={!!hiding}
        onOpenChange={(o) => !o && setHiding(null)}
        title="Ẩn tệp khỏi thư viện?"
        description={<>Tệp <b>{hiding?.name}</b> sẽ không hiện trong thư viện nữa. Bài đã đăng hoặc đã hẹn giờ có tệp này vẫn giữ nguyên.</>}
        confirmLabel="Ẩn khỏi thư viện"
        tone="default"
        pending={hide.isPending}
        onConfirm={() => {
          if (!hiding) return
          hide.mutate(hiding.id, {
            onSuccess: () => { toast.success("Đã ẩn khỏi thư viện"); setHiding(null) },
            onError: (err) => toast.error(getApiErrorMessage(err, "Không ẩn được tệp")),
          })
        }}
      />
    </div>
  )
}
