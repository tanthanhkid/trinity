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
  const body = p.text
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

      {body ? <ClampedText text={body} at={p.truncated_at} /> : <p className="text-xs italic text-muted-foreground">(chưa có chữ)</p>}

      {p.media.length > 0 && (
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
  // Mỗi Page một tab xem trước (chọn tab nào cũng giữ khi bản xem trước tải lại; tab biến mất thì về Page đầu).
  const [tabId, setTabId] = useState<number | null>(null)
  const shown = q.data?.targets.find((t) => t.account_id === tabId) ?? q.data?.targets[0]
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
      {d && d.targets.length > 1 && (
        <div role="tablist" aria-label="Page xem trước" className="flex gap-1.5 lg:gap-1 lg:rounded-[10px] lg:bg-ax-sunken lg:p-[3px]">
          {d.targets.map((t) => {
            const on = t.account_id === shown?.account_id
            return (
              <button
                key={t.account_id}
                type="button"
                role="tab"
                id={`social-prev-tab-${t.account_id}`}
                aria-selected={on}
                aria-controls="social-prev-panel"
                onClick={() => setTabId(t.account_id)}
                className={cn(
                  "min-h-11 min-w-0 flex-1 cursor-pointer truncate rounded-lg px-2 text-sm font-semibold outline-none focus-visible:shadow-[var(--ax-focus-ring)] lg:min-h-10",
                  on ? "bg-ax-primary text-white lg:bg-ax-surface lg:text-ax-ink lg:shadow-[0_1px_2px_rgba(23,24,28,.08),0_0_0_1px_rgba(23,24,28,.04)]" : "bg-ax-sunken text-ax-ink-2 hover:text-ax-ink lg:bg-transparent",
                )}
              >
                {t.account_name}
              </button>
            )
          })}
        </div>
      )}
      {shown && (
        <div role={d && d.targets.length > 1 ? "tabpanel" : undefined} id="social-prev-panel" aria-labelledby={d && d.targets.length > 1 ? `social-prev-tab-${shown.account_id}` : undefined}>
          <PreviewCard
            p={shown}
            renderMedia={(m) => {
              const id = libIds[m.key]
              return id ? <LibraryThumb id={id} type={m.type} /> : <MediaBox type={m.type} />
            }}
          />
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Điểm "Xem thêm" là ước lượng — mỗi mạng hiển thị khác nhau tuỳ thiết bị.</p>
    </div>
  )
}
