"use client"

import { Card, CardContent } from "@/components/ui/card"

const NODE = `import { createHmac, timingSafeEqual } from 'node:crypto'

export function verify(secret, rawBody, header, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  const t = Number(parts.t)
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest()
  const got = Buffer.from(parts.v1 ?? '', 'hex')
  return got.length === expected.length && timingSafeEqual(got, expected)
}`

const PY = `import hashlib, hmac, time

def verify(secret: str, raw_body: bytes, header: str, tolerance=300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts.get("t", "0"))
    if not t or abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))`

/** Tài liệu ngắn cho bên nhận: định dạng, kiểm chữ ký (Node + Python), at-least-once. Văn bản tĩnh. */
export function WebhookVerifyDocs() {
  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-3 py-4 text-sm">
        <details>
          <summary className="min-h-6 cursor-pointer font-semibold text-[var(--color-app-primary-ink)] max-sm:min-h-11 max-sm:py-2">Hướng dẫn cho bên nhận: kiểm chữ ký</summary>
          <div className="mt-3 space-y-3">
            <p>
              Mỗi lượt gửi là <code>POST</code> JSON <code>{`{ id, type, created_at, data }`}</code> kèm các header <code>X-Trinity-Event</code>,{" "}
              <code>X-Trinity-Delivery</code> và <code>X-Trinity-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, với{" "}
              <code>v1 = HMAC-SHA256(secret, &quot;&lt;t&gt;.&lt;body thô&gt;&quot;)</code>. Trả HTTP <strong>2xx</strong> trong 10 giây là thành công; redirect (3xx) bị coi là lỗi.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Dùng <strong>body thô</strong> (đúng byte nhận được), từ chối nếu <code>t</code> lệch quá 5 phút.</li>
              <li>Giao <strong>ít nhất một lần</strong>: có thể nhận trùng — lưu <code>X-Trinity-Delivery</code> đã xử lý để bỏ qua lần trùng. Không đảm bảo thứ tự.</li>
              <li>Thử lại sau 1 phút, 5 phút, 30 phút, 2 giờ, 6 giờ, 12 giờ (tối đa 7 lần) rồi dừng; lỗi liên tiếp 20 lần thì endpoint tự tắt.</li>
            </ul>
            <p className="text-xs font-semibold text-muted-foreground">Node.js</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{NODE}</pre>
            <p className="text-xs font-semibold text-muted-foreground">Python</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{PY}</pre>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}
