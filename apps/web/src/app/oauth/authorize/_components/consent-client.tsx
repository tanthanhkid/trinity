"use client"

import { useState } from "react"
import { AlertTriangle, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"

export interface ConsentClientInfo {
  name: string
  logo_uri: string | null
  client_uri: string | null
  kind: string
  redirect_uri: string
  redirect_host: string
  loopback: boolean
  /** Có khi redirect đi đúng host đã biết (chatgpt.com / claude.ai). */
  known_as: string | null
}

/**
 * Tên + logo do CHÍNH client tự khai nên KHÔNG đáng tin một mình (có thể giả "ChatGPT") — màn đồng ý luôn hiện thêm
 * host nơi trình duyệt sẽ được chuyển về (MCP spec: PHẢI hiển thị hostname redirect), nhãn "đã nhận diện" chỉ khi host
 * khớp danh sách đã biết, và cảnh báo rõ khi chưa nhận diện / chỉ có redirect loopback.
 */
export function ConsentClient({ client }: { client: ConsentClientInfo }) {
  const [logoOk, setLogoOk] = useState(true)
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center gap-3">
          {client.logo_uri && logoOk && (
            // eslint-disable-next-line @next/next/no-img-element -- ảnh từ miền ngoài do client khai; không qua next/image
            <img src={client.logo_uri} alt="" referrerPolicy="no-referrer" className="size-12 shrink-0 rounded-lg border object-contain" onError={() => setLogoOk(false)} />
          )}
          <div className="min-w-0">
            <p className="break-words text-base font-semibold">{client.name}</p>
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {client.known_as ? (
                <Badge variant="success"><ShieldCheck className="size-3" /> Đã nhận diện: {client.known_as}</Badge>
              ) : (
                <Badge variant="secondary">Chưa được nhận diện</Badge>
              )}
            </p>
          </div>
        </div>

        <p className="text-sm">
          Sau khi bạn quyết định, trình duyệt sẽ chuyển về: <code className="rounded bg-muted px-1 font-mono break-all" data-testid="redirect-host">{client.redirect_host}</code>
        </p>

        {!client.known_as && (
          <p className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>Hệ thống chưa nhận diện ứng dụng này — tên hiển thị do chính ứng dụng tự khai. Chỉ cho phép nếu bạn vừa tự bắt đầu việc kết nối từ ChatGPT/Claude (hoặc công cụ bạn tin tưởng) và địa chỉ chuyển về ở trên đúng như bạn mong đợi.</span>
          </p>
        )}
        {client.loopback && (
          <p className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>Kết quả sẽ được gửi về một chương trình đang chạy trên CHÍNH máy tính của bạn (localhost). Chỉ cho phép nếu bạn đang tự chạy công cụ đó (ví dụ Claude Code).</span>
          </p>
        )}
      </CardContent>
    </Card>
  )
}
