import { NextRequest, NextResponse } from 'next/server'

/**
 * Proxy /uploads/* requests to the monolith — nơi phục vụ tĩnh ảnh đại diện
 * và ảnh sản phẩm. Địa chỉ backend lấy từ `AUTH_SERVICE_URL` (mặc định localhost).
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL ?? 'http://localhost:4000'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params

  // Next đã giải mã %2e%2e / %2f → chặn cả segment chứa '/', '\\' hoặc rỗng, kẻo URL
  // upstream bị chuẩn hoá (`..`) và thoát khỏi /uploads sang route khác của monolith.
  if (path.some((segment) => segment === '..' || segment === '.' || segment === '' || /[/\\]/.test(segment))) {
    return new NextResponse(null, { status: 400 })
  }

  const filePath = `/uploads/${path.map(encodeURIComponent).join('/')}`
  const url = `${AUTH_SERVICE_URL}${filePath}`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) {
      return new NextResponse(null, { status: res.status })
    }

    const body = await res.arrayBuffer()
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // Ảnh người dùng tải lên: cấm trình duyệt đoán lại kiểu (chống polyglot → HTML/JS).
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    })
  } catch {
    return new NextResponse(null, { status: 502 })
  }
}
