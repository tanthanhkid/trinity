"use client"

import { AtSign } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { useRefBacklinks } from "@/hooks/refs/use-refs"
import type { RefType } from "@/lib/refs/mentions"
import { RefChip } from "./ref-chip"

/**
 * "Được nhắc tới ở": các bản ghi (mọi bảng) đang gắn thẻ @ hoặc trường Liên kết tới bản ghi này — chỉ để xem, không ràng buộc.
 * BE chỉ trả nguồn người xem thấy được. Không có ⇒ không hiện gì.
 */
export function MentionedIn({ type, id }: { type: RefType; id: number }) {
  const q = useRefBacklinks(type, id)
  const rows = q.data ?? []
  if (rows.length === 0) return null
  return (
    // overflow-visible: ô xem nhanh khi rê chuột vào thẻ nằm INLINE dưới thẻ — Card mặc định overflow-hidden sẽ cắt mất.
    <Card className="overflow-visible rounded-2xl" data-testid="mentioned-in">
      <CardContent className="space-y-2 p-4">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><AtSign className="size-4" aria-hidden /> Được nhắc tới ở <span className="font-normal text-muted-foreground">· {rows.length}</span></p>
        <ul className="space-y-1.5">
          {rows.map((b) => (
            <li key={b.source.ref} className="flex flex-wrap items-center gap-2 text-sm">
              <RefChip view={b.source} />
              <span className="text-muted-foreground">{b.source.table}{b.fields.length ? ` · ${b.fields.join(", ")}` : ""}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
