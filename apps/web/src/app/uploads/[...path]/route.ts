import { NextRequest, NextResponse } from 'next/server'
import { buildBlobUploadUrl, isBlobUploadsEnabled } from '@/lib/uploads-blob'
import { isServerlessRuntime } from '@/lib/serverless-runtime'

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

  // STORAGE_DRIVER=vercel-blob → ảnh nằm ở Blob (không có đĩa bền trên Vercel).
  // Blob không có (404) → rơi xuống monolith để dữ liệu cũ trên đĩa vẫn đọc được.
  if (isBlobUploadsEnabled()) {
    const blobUrl = buildBlobUploadUrl(path)
    if (blobUrl) {
      const blobRes = await fetchBlob(blobUrl)
      if (blobRes) return blobRes
    }
  }

  // serverless không có monolith / đĩa bền để rơi xuống → Blob không có file = 404 thật (không phải 502).
  if (isServerlessRuntime()) return new NextResponse(null, { status: 404 })

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

const UPLOAD_HEADERS = {
  // Ảnh người dùng tải lên: cấm trình duyệt đoán lại kiểu (chống polyglot → HTML/JS).
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'public, max-age=86400, immutable',
}

/** `null` khi Blob không có file / lỗi tạm → caller thử nguồn kế tiếp. */
async function fetchBlob(url: string): Promise<NextResponse | null> {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? ''}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok || !res.body) return null
    return new NextResponse(res.body, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream',
        ...UPLOAD_HEADERS,
      },
    })
  } catch {
    return null
  }
}
