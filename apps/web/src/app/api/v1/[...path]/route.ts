import { NextRequest, NextResponse } from 'next/server'
import { isServerlessRuntime } from '@/lib/serverless-runtime'
import { handleWithNest } from '@/lib/nest-bridge'

// Vercel serverless: Nest chạy TRONG app, KHÔNG proxy ra backend nào (phải khai ở đây: route handler
// export `maxDuration` là trần của Vercel Hobby; chế độ Node server tự chạy bỏ qua giá trị này).
export const maxDuration = 60

// Runtime-only: NEXT_PUBLIC_API_URL được Next inline khi build (vd "/api/v1"),
// sau khi strip "/api/v1" còn lại "" nên KHÔNG dùng làm fallback.
// Chỉ đọc BACKEND_URL từ process.env; fallback cuối cùng là `http://localhost`.
//
// ⚠ KHÔNG fallback sang domain public: nếu quên set BACKEND_URL, request sẽ đi
// vòng ra ngoài rồi fail im lặng. Fallback localhost an toàn hơn (nếu backend
// localhost không chạy, fail rõ ràng) + có warn log để dễ debug.
const RAW_BACKEND_URL = process.env.BACKEND_URL?.trim()
const BACKEND_URL = RAW_BACKEND_URL && RAW_BACKEND_URL.length > 0
  ? RAW_BACKEND_URL
  : 'http://localhost'

if (!RAW_BACKEND_URL && process.env.NODE_ENV !== 'test' && !isServerlessRuntime()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[API Proxy] ⚠ BACKEND_URL chưa set trong env; fallback http://localhost. ' +
    'Hãy đặt BACKEND_URL trỏ tới backend (mặc định http://localhost), ' +
    'không trỏ về chính domain public của web để tránh vòng lặp proxy.',
  )
}

// Local dev: route to correct service based on path
const LOCAL_ROUTES: Record<string, string> = {
  '/api/v1/auth': 'http://localhost:4000',
  '/api/v1/users': 'http://localhost:4000',
  '/api/v1/roles': 'http://localhost:4000',
  '/api/v1/teams': 'http://localhost:4000',
  '/api/v1/api-keys': 'http://localhost:4000',
  '/api/v1/public/auth': 'http://localhost:4000',
  '/api/v1/public/contacts': 'http://localhost:4000',
  '/api/v1/contacts': 'http://localhost:4000',
  '/api/v1/activities': 'http://localhost:4000',
  '/api/v1/reports': 'http://localhost:4000',
  '/api/v1/settings': 'http://localhost:4000',
  '/api/v1/newsfeed': 'http://localhost:4000',
  // Kanban (bảng công việc đa board tuỳ biến), module mới trong
  // services/crm phục vụ qua monolith :4000 cùng mọi route CRM khác.
  '/api/v1/kanban': 'http://localhost:4000',
  '/api/v1/management/job-titles': 'http://localhost:4000',
  '/api/v1/management/employees': 'http://localhost:4000',
  '/api/v1/management/contracts': 'http://localhost:4000',
  '/api/v1/management/attendance': 'http://localhost:4000',
  '/api/v1/management/recruitment': 'http://localhost:4000',
  '/api/v1/management/teams': 'http://localhost:4000',
  '/api/v1/projects': 'http://localhost:4000',
  '/api/v1/products': 'http://localhost:4000',
  // 2 prefix MỚI của khung sản phẩm đa ngành (`products.module.ts`,
  // nay phục vụ qua monolith :4000 cùng mọi route khác). KHÔNG khớp
  // prefix `/api/v1/products` ở trên (khác chuỗi: "product-categories" ≠
  // "products...") nên PHẢI khai riêng — thiếu là rơi về BACKEND_URL và lặp proxy.
  '/api/v1/product-categories': 'http://localhost:4000',
  '/api/v1/product-attribute-defs': 'http://localhost:4000',
  // POS bán hàng tại quầy (`services/commerce/src/pos`, cùng monolith :4000). Thiếu prefix này
  // thì request `/api/v1/pos/*` rơi về BACKEND_URL → reverse proxy → quay lại route proxy = LẶP (xem test api-proxy-monolith-prefixes).
  '/api/v1/pos': 'http://localhost:4000',
  '/api/v1/employees': 'http://localhost:4000',
  '/api/v1/kpi': 'http://localhost:4000',
  '/api/v1/payslips': 'http://localhost:4000',
  '/api/v1/salary-rules': 'http://localhost:4000',
  '/api/v1/salary-components': 'http://localhost:4000',
  '/api/v1/insurance-settings': 'http://localhost:4000',
  '/api/v1/tax-config': 'http://localhost:4000',
  '/api/v1/notifications': 'http://localhost:4000',
  '/api/v1/templates': 'http://localhost:4000',
  // Kết nối & AI (nhật ký, webhook ra/vào cấu hình) + webhook VÀO công khai `/api/v1/hooks/in/:token`.
  // Bảng này chỉ có tác dụng ở local dev; thiếu prefix ở đây thì request rơi về BACKEND_URL.
  '/api/v1/integrations': 'http://localhost:4000',
  '/api/v1/hooks': 'http://localhost:4000',
  // Fanpage Facebook: quản trị/hộp thư + webhook Meta + callback OAuth.
  '/api/v1/facebook': 'http://localhost:4000',
  '/api/v1/zalo-oa': 'http://localhost:4000',
  // Connector (SePay/VNPay/MoMo/KiotViet…), yêu cầu thanh toán, link thanh toán công khai + trang kết quả.
  '/api/v1/connectors': 'http://localhost:4000',
  '/api/v1/payments': 'http://localhost:4000',
  '/api/v1/pay/': 'http://localhost:4000',
  // Trang bán hàng online (quản trị + công khai).
  '/api/v1/store/': 'http://localhost:4000',
  // Bản tin sáng/chiều (cấu hình, danh sách của tôi), cùng monolith :4000.
  '/api/v1/briefings': 'http://localhost:4000',
  // Thực thể tuỳ biến ("tính năng" người dùng tự thêm): định nghĩa + bản ghi + xuất CSV, cùng monolith :4000.
  '/api/v1/custom-objects': 'http://localhost:4000',
  '/api/v1/setup': 'http://localhost:4000', //  trạng thái dựng quy trình (màn Bắt đầu)
  // Chấm điểm lead + nhắc việc treo (gói Trợ lý Kinh doanh), cùng monolith :4000.
  '/api/v1/lead-scoring': 'http://localhost:4000',
  '/api/v1/stale-work': 'http://localhost:4000',
  // OAuth 2.1 Authorization Server (register/token/revoke + 2 route đồng ý của màn /oauth/authorize).
  '/api/v1/oauth': 'http://localhost:4000',
  // máy chủ MCP chỉ đọc (`POST /api/v1/mcp`).
  '/api/v1/mcp': 'http://localhost:4000',
}

function getBackendUrl(path: string): string {
  if (process.env.NODE_ENV === 'development' || BACKEND_URL.includes('localhost')) {
    for (const [prefix, url] of Object.entries(LOCAL_ROUTES)) {
      if (path.startsWith(prefix)) return url
    }
  }
  return BACKEND_URL
}

async function proxy(req: NextRequest) {
  if (isServerlessRuntime()) {
    try {
      return await handleWithNest(req)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[Nest serverless] ${req.method} ${req.nextUrl.pathname} lỗi:`, err)
      return NextResponse.json(
        { error: 'Service unavailable', message: 'Dịch vụ chưa sẵn sàng, vui lòng thử lại.' },
        { status: 503 },
      )
    }
  }
  const path = req.nextUrl.pathname + req.nextUrl.search
  const backendBase = getBackendUrl(path)
  const url = `${backendBase}${path}`

  // xuất Excel (quét bảng lớn + build xlsx) — 15s mặc định có thể 504.
  // Nới timeout cho MỌI route export (contacts/export, ...).
  const isExport = req.nextUrl.pathname.endsWith('/export')

  const headers = new Headers()
  req.headers.forEach((value, key) => {
    if (['host', 'connection', 'transfer-encoding'].includes(key)) return
    headers.set(key, value)
  })
  // Set correct Host header for the backend server (reverse proxy khớp theo server_name)
  const backendHost = new URL(BACKEND_URL).host
  headers.set('host', backendHost)

  let body: BodyInit | null = null
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await req.arrayBuffer()
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      isExport ? 120_000 : 15_000,
    )

    const res = await fetch(url, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
    })

    clearTimeout(timeout)

    const responseHeaders = new Headers()
    res.headers.forEach((value, key) => {
      if (['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(key)) return
      responseHeaders.set(key, value)
    })
    const responseBody = await res.arrayBuffer()

    return new NextResponse(responseBody, {
      status: res.status,
      headers: responseHeaders,
    })
  } catch (err) {
    const error = err as Error
    // Log nội bộ (log của server); KHÔNG trả `error.message` cho client vì có thể
    // lộ backend hostname/port/stack — giữ error generic theo category.
    console.error(`[API Proxy] Failed to proxy ${req.method} ${path}:`, error)

    const isTimeout = error.name === 'AbortError'
    const status = isTimeout ? 504 : 502
    return NextResponse.json(
      {
        error: isTimeout ? 'Backend timeout' : 'Backend unreachable',
        message: isTimeout
          ? 'Backend phản hồi chậm, vui lòng thử lại.'
          : 'Không kết nối được dịch vụ, vui lòng thử lại sau.',
      },
      { status },
    )
  }
}

export const GET = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
