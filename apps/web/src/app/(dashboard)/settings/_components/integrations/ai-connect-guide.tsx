"use client"

import { AlertTriangle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { CopyButton } from "./secret-reveal-dialog"

function Steps({ title, steps }: { title: string; steps: string[] }) {
  return (
    <details className="group rounded-[var(--radius)] border bg-card p-3 open:shadow-sm">
      <summary className="cursor-pointer text-sm font-semibold">{title}</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </details>
  )
}

/**
 * Hướng dẫn nối ChatGPT / Claude. `mcpUrl=null` ⇒ máy chủ chưa chạy được MCP (thiếu INTEGRATIONS_PUBLIC_BASE_URL):
 * nói rõ nguyên nhân thay vì hiện URL sai.
 */
export function AiConnectGuide({ mcpUrl, baseUrlConfigured }: { mcpUrl: string | null; baseUrlConfigured: boolean }) {
  return (
    <div className="space-y-3">
      {mcpUrl ? (
        <Card className="rounded-2xl">
          <CardContent className="space-y-2 py-4">
            <p className="text-sm font-semibold">Địa chỉ kết nối trợ lý AI của công ty</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all" data-testid="mcp-url">{mcpUrl}</code>
              <CopyButton value={mcpUrl} label="địa chỉ kết nối" />
            </div>
            <p className="text-xs text-muted-foreground">
              AI chỉ làm được những gì bạn làm được: đọc dữ liệu theo đúng quyền của bạn, số điện thoại luôn bị che. Nếu bạn cấp quyền ghi khi kết nối, thay đổi có hiệu lực ngay. Bạn thu hồi quyền bất cứ lúc nào ở danh sách bên dưới.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex items-start gap-2 py-4 text-sm text-amber-700">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {baseUrlConfigured
                ? "Máy chủ chưa sẵn sàng cho Kết nối AI."
                : <>Chưa đặt địa chỉ công khai của hệ thống. Quản trị hệ thống cần đặt <code className="rounded bg-muted px-1">INTEGRATIONS_PUBLIC_BASE_URL</code> (vd https://crm.example.com) rồi khởi động lại dịch vụ.</>}
            </span>
          </CardContent>
        </Card>
      )}

      <Steps
        title="Cách nối với ChatGPT (gói Business / Enterprise)"
        steps={[
          "Mở ChatGPT > Settings > Apps (hoặc Connectors / Plugins) và bật chế độ nhà phát triển nếu được yêu cầu.",
          "Chọn tạo ứng dụng/connector mới, dán địa chỉ kết nối ở trên vào ô địa chỉ máy chủ (Server URL), chọn xác thực OAuth.",
          "Bấm Kết nối: ChatGPT mở trang Trinity — đăng nhập (nếu cần), kiểm tra tên ứng dụng + địa chỉ chuyển về (chatgpt.com), rồi bấm Cho phép.",
          "Trong cuộc trò chuyện, bật connector và hỏi về khách hàng, deal, công việc của bạn.",
        ]}
      />
      <Steps
        title="Cách nối với Claude (Custom connector)"
        steps={[
          "Mở Claude > Settings > Connectors > Add custom connector.",
          "Đặt tên, dán địa chỉ kết nối ở trên vào ô địa chỉ máy chủ (Server URL) rồi bấm Add.",
          "Bấm Connect: Claude mở trang Trinity — đăng nhập (nếu cần), kiểm tra địa chỉ chuyển về (claude.ai), rồi bấm Cho phép.",
          "Trong cuộc trò chuyện, bật connector từ menu công cụ.",
        ]}
      />
      <p className="text-xs text-muted-foreground">
        Bạn cần quyền &ldquo;Nối tài khoản của mình vào ChatGPT/Claude&rdquo; (integrations.ai_connect). Nếu bấm Cho phép bị từ chối, hãy nhờ quản trị viên cấp quyền này cho vai trò của bạn.
      </p>
    </div>
  )
}
