"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Loader2, Play } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSocialMediaPreview, useSocialPreview, type SocialPreviewBody, type SocialTargetPreview } from "@/hooks/use-social"
import { NETWORK_META, NetworkMark } from "./social-network-mark"
import { queueWhenLabel } from "./social-queue"

/** Đợi `delayMs` sau lần đổi cuối mới trả giá trị mới. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return v
}

/** Chữ có xuống dòng, gập tại `at` với nút "… Xem thêm" (vị trí xấp xỉ do BE tính). */
function ClampedText({ text, at, className }: { text: string; at: number | null; className?: string }) {
  const [open, setOpen] = useState(false)
  const cut = at !== null && at < text.length && !open
  return (
    <p className={cn("whitespace-pre-wrap break-words text-[13px] leading-5", className)}>
      {cut ? text.slice(0, at).trimEnd() : text}
      {at !== null && at < text.length && (
        <>
          {cut && "… "}
          <button type="button" className="font-medium text-muted-foreground hover:underline" onClick={() => setOpen((o) => !o)}>
            {cut ? "Xem thêm" : " Thu gọn"}
          </button>
        </>
      )}
    </p>
  )
}

function MediaBox({ type }: { type: "image" | "video" }) {
  return (
    <div className="flex aspect-square items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
      {type === "video" ? <Play className="size-5" /> : "Ảnh"}
    </div>
  )
}

/**
 * Một thẻ xem trước theo dáng mạng. `renderMedia` cho phép gắn ảnh thật (xem `SocialPreviewPanel`); mặc định là ô giữ chỗ ghi loại tệp.
 */
export function PreviewCard({ p, renderMedia }: { p: SocialTargetPreview; renderMedia?: (m: SocialTargetPreview["media"][number]) => ReactNode }) {
  const net = p.network
  const yt = net === "youtube"
  const video = p.media.find((m) => m.type === "video")
  const body = yt ? (p.description ?? p.text) : p.text
  return (
    <article className="space-y-2 rounded-lg border border-border bg-card p-3" aria-label={`Xem trước ${p.account_name}`} data-network={net ?? ""}>
      <header className="flex items-center gap-2">
        <span aria-hidden className="size-8 shrink-0 rounded-full bg-muted" />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-medium">{p.account_name}</span>
          <span className="text-[11px] text-muted-foreground">{net ? NETWORK_META[net]?.label : "Kênh không dùng được"}</span>
        </span>
        {net && <NetworkMark network={net} size="sm" />}
      </header>

      {yt && (
        <>
          <div className="flex aspect-video items-center justify-center rounded-md bg-muted text-muted-foreground">
            {video && renderMedia ? renderMedia(video) : <Play className="size-8" />}
          </div>
          <p className="text-sm font-semibold leading-5" data-testid="preview-title">{p.title || "(chưa có tiêu đề)"}</p>
        </>
      )}

      {body ? <ClampedText text={body} at={p.truncated_at} /> : <p className="text-xs italic text-muted-foreground">(chưa có chữ)</p>}

      {!yt && p.media.length > 0 && (
        <div className={cn("grid gap-1", p.media.length === 1 ? "grid-cols-1" : "grid-cols-3")}>
          {p.media.map((m) => (
            <div key={m.key} className="overflow-hidden rounded-md">{renderMedia ? renderMedia(m) : <MediaBox type={m.type} />}</div>
          ))}
        </div>
      )}

      {p.first_comment && (
        <div className="rounded-md bg-muted/60 px-2.5 py-1.5" data-testid="preview-first-comment">
          <p className="text-[11px] font-medium text-muted-foreground">Bình luận đầu tiên của {p.account_name}</p>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-5">{p.first_comment}</p>
        </div>
      )}

      {p.limit !== null && (
        <p className={cn("text-right text-[11px]", p.length > p.limit ? "text-destructive" : "text-muted-foreground")}>
          {p.length.toLocaleString("vi-VN")}/{p.limit.toLocaleString("vi-VN")}
        </p>
      )}
      {p.warnings.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive" role="alert">
          {p.warnings.map((w, i) => <li key={`${i}-${w}`}>{w}</li>)}
        </ul>
      )}
    </article>
  )
}

function LibraryThumb({ id, type }: { id: number; type: "image" | "video" }) {
  const { url } = useSocialMediaPreview(id, type === "image")
  if (type === "video" || !url) return <MediaBox type={type} />
  // eslint-disable-next-line @next/next/no-img-element -- ảnh tải qua BE (object URL), next/image không tối ưu được
  return <img src={url} alt="" className="aspect-square size-full object-cover" />
}

/** Cột "Xem trước": gọi BE (debounce ~400 ms, giữ kết quả cũ khi tải) rồi vẽ một thẻ cho mỗi kênh đã chọn. `libIds`: media key → id thư viện (để hiện ảnh thật). */
export function SocialPreviewPanel({ body, libIds }: { body: SocialPreviewBody; libIds: Record<string, number | undefined> }) {
  const has = body.targets.length > 0
  const key = JSON.stringify(body)
  const debounced = useDebounced(key, 400)
  const sent = useMemo(() => JSON.parse(debounced) as SocialPreviewBody, [debounced])
  const q = useSocialPreview(sent, has && sent.targets.length > 0)
  if (!has) return <p className="text-sm text-muted-foreground">Chọn ít nhất một kênh để xem trước.</p>
  const d = q.data
  return (
    <div className="space-y-3" data-testid="social-preview">
      {(q.isFetching || key !== debounced) && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Đang cập nhật bản xem trước" />}
      {q.isError && <p className="text-xs text-destructive">Không tải được bản xem trước.</p>}
      {d?.warnings.length ? (
        <ul className="space-y-0.5 text-xs text-destructive" role="alert">
          {d.warnings.map((w, i) => <li key={`${i}-${w}`}>{w}</li>)}
        </ul>
      ) : null}
      {d && <p className="text-xs text-muted-foreground">{d.scheduled_at ? `${d.from_queue ? "Khung hàng đợi" : "Hẹn"}: ${queueWhenLabel(d.scheduled_at)}` : "Đăng ngay"}</p>}
      {d?.targets.map((t) => (
        <PreviewCard
          key={t.account_id}
          p={t}
          renderMedia={(m) => {
            const id = libIds[m.key]
            return id ? <LibraryThumb id={id} type={m.type} /> : <MediaBox type={m.type} />
          }}
        />
      ))}
      <p className="text-[11px] text-muted-foreground">Điểm "Xem thêm" là ước lượng — mỗi mạng hiển thị khác nhau tuỳ thiết bị.</p>
    </div>
  )
}
