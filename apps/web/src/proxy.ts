import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { loginPathWithNext } from '@/lib/oauth-authorize'

// '/.well-known' = metadata OAuth/MCP — máy chủ của ChatGPT/Claude tải KHÔNG có phiên; Next rewrite sang monolith.
// '/s/' = trang bán hàng online công khai (khách mua không đăng nhập).
const PUBLIC_PATHS = ['/login', '/.well-known', '/s/']
/** Path exact match (không dùng startsWith vì '/' match mọi thứ) */
/** `/privacy`, `/terms`: trang chính sách công khai — Meta/Google/TikTok đọc khi duyệt ứng dụng đăng bài. */
const PUBLIC_EXACT_PATHS: string[] = ['/privacy', '/terms']

function withNoCacheHeaders(response: NextResponse): NextResponse {
  // Prevent browsers/CDN from caching HTML — ensures users always get fresh
  // chunk references after a deploy (avoids stale chunk load errors)
  response.headers.set('Cache-Control', 'no-store, must-revalidate')
  response.headers.set('Pragma', 'no-cache')
  return response
}

/**
 * 🔴 RBAC quyền + phạm vi — proxy (Next 16, trước đây là middleware) CHỈ kiểm CÓ PHIÊN hay không.
 * Trang không đủ quyền → `<Forbidden />` (BE vẫn chặn dữ liệu). JWT payload chỉ
 * có `{ sub, email, sid? }` (không có `role`/`team_id`, xem
 * `services/auth/src/auth/auth.service.ts` `JwtPayload`). Mỗi trang tự gọi
 * `usePermissions()` và render `<Forbidden />` khi thiếu quyền; BE là tuyến
 * chặn dữ liệu thật qua `scopeWhere()`.
 */
/**
 * Tên miền phụ cho trang bán hàng: `{slug}.{STORE_DOMAIN}` (vd cua-hang-abc.shop.example.com) ⇒ hiển thị `/s/{slug}`.
 * Chỉ bật khi đặt STORE_DOMAIN và DNS wildcard trỏ về web; không đặt thì trang vẫn chạy ở `/s/{slug}`.
 */
function storeSubdomain(request: NextRequest): NextResponse | null {
  const domain = (process.env.STORE_DOMAIN ?? '').trim().toLowerCase()
  if (!domain) return null
  const host = (request.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '')
  if (!host.endsWith(`.${domain}`)) return null
  const slug = host.slice(0, -(domain.length + 1))
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) return null
  const { pathname } = request.nextUrl
  // API + tài nguyên tĩnh đi thẳng; mọi trang khác của tên miền phụ là trang cửa hàng.
  if (pathname.startsWith('/api/') || pathname.startsWith('/_next/')) return NextResponse.next()
  const url = request.nextUrl.clone()
  url.pathname = `/s/${slug}`
  return withNoCacheHeaders(NextResponse.rewrite(url))
}

export function proxy(request: NextRequest) {
  const sub = storeSubdomain(request)
  if (sub) return sub
  const { pathname } = request.nextUrl
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return withNoCacheHeaders(NextResponse.next())
  }
  if (PUBLIC_EXACT_PATHS.includes(pathname)) {
    return withNoCacheHeaders(NextResponse.next())
  }

  const token = request.cookies.get('access_token')?.value

  // Gốc `/`: có phiên thì vào thẳng dashboard, chưa thì ra màn đăng nhập.
  if (pathname === '/') {
    const signedIn = token ?? request.cookies.get('has_session')?.value
    return withNoCacheHeaders(
      NextResponse.redirect(new URL(signedIn ? '/dashboard' : '/login', request.url)),
    )
  }

  // Check access_token cookie (short-lived, 15 min) first
  if (token) return withNoCacheHeaders(NextResponse.next())

  // Fallback: check has_session cookie (long-lived, 7 days matching refresh token)
  // If session exists, allow through — client-side will handle token refresh via interceptor
  const hasSession = request.cookies.get('has_session')?.value
  if (hasSession) return withNoCacheHeaders(NextResponse.next())

  // chưa đăng nhập mà vào màn đồng ý OAuth ⇒ qua /login rồi QUAY LẠI (chỉ riêng `/oauth/authorize`, mọi path khác như cũ).
  const target = pathname === '/oauth/authorize' ? loginPathWithNext(`${pathname}${request.nextUrl.search}`) : '/login'
  return withNoCacheHeaders(
    NextResponse.redirect(new URL(target, request.url)),
  )
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|uploads|logo|brand).*)'],
}
