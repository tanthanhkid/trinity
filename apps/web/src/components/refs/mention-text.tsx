"use client"

import { Fragment } from "react"
import { useResolvedCodes } from "@/hooks/refs/use-refs"
import { mentionCodes, splitMentions } from "@/lib/refs/mentions"
import { cn } from "@/lib/utils"
import { RefChip } from "./ref-chip"

/**
 * Văn bản có thẻ @ (ghi chú, mô tả): chữ giữ nguyên xuống dòng, mỗi `@SP001` thành thẻ bấm được. Mã không tìm thấy / ngoài quyền
 * xem ⇒ thẻ xám chỉ có mã. Một lần gọi /refs/resolve cho cả đoạn.
 */
export function MentionText({ text, className }: { text: string; className?: string }) {
  const codes = mentionCodes(text)
  const resolved = useResolvedCodes(codes)
  const segs = splitMentions(text)
  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {segs.map((s, i) => (
        <Fragment key={i}>
          {s.kind === "text" ? s.text
            : resolved.isLoading ? <span className="font-mono text-sm text-primary">@{s.code}</span>
            : <RefChip code={s.code} view={resolved.data?.get(s.code) ?? null} />}
        </Fragment>
      ))}
    </span>
  )
}
