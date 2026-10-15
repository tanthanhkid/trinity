"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useResolvedCodes } from "@/hooks/refs/use-refs"
import { mentionCodes, splitMentions } from "@/lib/refs/mentions"
import { RefChip } from "./ref-chip"

const REF_HREF = "#ref-"

/** Thẻ `@SP001` trong Markdown → liên kết nội bộ `[@SP001](#ref-SP001)` để vẽ thành thẻ; phần còn lại giữ nguyên. */
export function linkifyMentions(md: string): string {
  return splitMentions(md).map((s) => (s.kind === "code" ? `[@${s.code}](${REF_HREF}${s.code})` : s.text)).join("")
}

/**
 * Mô tả Markdown (công việc…) có thẻ @: định dạng Markdown như thường, mỗi `@MÃ` thành thẻ bấm được (cùng cách vẽ với `MentionText`).
 * Một lần gọi /refs/resolve cho cả đoạn; mã không thấy / ngoài quyền ⇒ thẻ xám chỉ có mã.
 */
export function MarkdownWithMentions({ text }: { text: string }) {
  const resolved = useResolvedCodes(mentionCodes(text))
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children, ...rest }) => {
          if (href?.startsWith(REF_HREF)) {
            const code = href.slice(REF_HREF.length)
            return resolved.isLoading
              ? <span className="font-mono text-sm text-primary">@{code}</span>
              : <RefChip code={code} view={resolved.data?.get(code) ?? null} />
          }
          return <a href={href} {...rest}>{children}</a>
        },
      }}
    >
      {linkifyMentions(text)}
    </ReactMarkdown>
  )
}
