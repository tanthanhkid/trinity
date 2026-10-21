"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { FileText, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { cn } from "@/lib/utils"
import apiClient, { getApiErrorMessage } from "@/lib/api-client"
import { deferWithUndo } from "@/lib/undo"
import { useSocialAccounts, useSocialDrafts, type SocialDraft } from "@/hooks/use-social"
import { NetworkMark } from "./social-network-mark"
import { formatDateTime } from "@/lib/format"

const fmt = (iso: string) => formatDateTime(iso)

/** Tên hiển thị của nháp: tiêu đề, không thì dòng đầu của nội dung. */
export function draftLabel(d: Pick<SocialDraft, "title" | "content">): string {
  const t = d.title?.trim()
  if (t) return t
  const first = d.content.split("\n").map((l) => l.trim()).find(Boolean)
  return first ? (first.length > 100 ? `${first.slice(0, 100)}…` : first) : "(Bài nháp trống)"
}

/** Bài nháp chưa đăng: mới sửa trước; Mở (vào ô soạn) / Xoá. */
export function SocialDraftsList({ highlight, onOpen, onCompose }: { highlight?: number; onOpen: (d: SocialDraft) => void; onCompose?: () => void }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useSocialDrafts()
  const { data: accounts = [] } = useSocialAccounts()
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState<SocialDraft | null>(null)
  const byId = new Map(accounts.map((a) => [a.id, a]))

  if (isLoading) return <LoadingBlock count={3} label="Đang tải bài nháp…" />
  if (isError && !data) return <ErrorState title="Không tải được danh sách nháp" error={error} onRetry={() => void refetch()} retrying={isFetching} />
  if (!data?.length) {
    return (
      <EmptyState
        icon={FileText}
        title="Chưa có bài nháp"
        message="Soạn dở thì bấm Lưu nháp ở màn Soạn bài — bài được giữ lại ở đây để sửa và đăng sau. Bài AI soạn giúp cũng nằm ở đây."
        action={onCompose ? <Button variant="outline" onClick={onCompose}>Soạn bài</Button> : undefined}
      />
    )
  }

  return (
    <>
      <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/8 shadow-[var(--shadow-card)]">
        {data.map((d) => (
          <li key={d.id} id={`social-draft-${d.id}`} className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3.5 sm:px-5", d.id === highlight && "bg-primary/[0.05] ring-2 ring-inset ring-primary/30")}>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="line-clamp-2 whitespace-pre-wrap text-sm font-medium text-foreground">{draftLabel(d)}</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                {d.targets.length === 0 ? (
                  <span>Chưa chọn kênh</span>
                ) : (
                  <span className="flex items-center gap-1" aria-label={`${d.targets.length} kênh`}>
                    {d.targets.map((t) => {
                      const a = byId.get(t.account_id)
                      return a ? <NetworkMark key={t.account_id} network={a.network} size="sm" /> : <span key={t.account_id}>#{t.account_id}</span>
                    })}
                  </span>
                )}
                <span>· Sửa {fmt(d.updated_at)}</span>
                {d.scheduled_at && <span>· Hẹn {fmt(d.scheduled_at)}</span>}
                {d.media.length > 0 && <span>· {d.media.length} tệp</span>}
                {d.source !== "web" && <span>· qua AI</span>}
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button size="sm" variant="outline" onClick={() => onOpen(d)}>Mở</Button>
              <Button size="sm" variant="ghost" onClick={() => setRemoving(d)}><Trash2 className="size-3.5" /> Xoá</Button>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Xoá bài nháp?"
        description={<>Bài nháp <b>{removing ? draftLabel(removing) : ""}</b> biến khỏi danh sách ngay; bạn có 5 giây để bấm Hoàn tác trước khi xoá hẳn.</>}
        confirmLabel="Xoá nháp"
        onConfirm={() => {
          const d = removing
          if (!d) return
          setRemoving(null)
          const key = ["social", "drafts"]
          queryClient.setQueryData<SocialDraft[]>(key, (list) => list?.filter((x) => x.id !== d.id))
          deferWithUndo({
            message: "Đã xoá bài nháp.",
            // Gọi thẳng API (không qua hook): hết 5 giây có thể đã rời màn này.
            commit: () =>
              apiClient
                .delete(`/social/drafts/${d.id}`)
                .catch((err) => toast.error(getApiErrorMessage(err, "Không xoá được bài nháp")))
                .finally(() => queryClient.invalidateQueries({ queryKey: key })),
            onUndo: () => queryClient.invalidateQueries({ queryKey: key }),
          })
        }}
      />
    </>
  )
}
