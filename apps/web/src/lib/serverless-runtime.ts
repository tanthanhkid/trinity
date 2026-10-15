/**
 * Chế độ serverless (Vercel) — cờ DUY NHẤT `TRINITY_RUNTIME=serverless`.
 * Hàm thuần (không import gì của Next) để dùng cả ở `next.config.ts` lẫn route handler lẫn test.
 */
export function isServerlessRuntime(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.TRINITY_RUNTIME?.trim().toLowerCase()
  if (flag) return flag === 'serverless'
  // On Vercel the flag is implied, so a fresh deploy needs no extra env var.
  return env.VERCEL === '1'
}

export interface RewriteRule {
  source: string
  destination: string
}

/** URL khám phá OAuth/MCP ở gốc domain → route OAuth của Nest (RFC 8414 / 9728; phần đuôi path bị bỏ, như bản VPS). */
const WELL_KNOWN: Array<{ source: string; destination: string }> = [
  { source: '/.well-known/oauth-authorization-server', destination: '/api/v1/oauth/.well-known/oauth-authorization-server' },
  { source: '/.well-known/oauth-protected-resource', destination: '/api/v1/oauth/protected-resource' },
]

/**
 * Rewrite `beforeFiles` của chế độ serverless — Nest chạy TRONG app (không còn monolith :4000):
 * - `/.well-known/oauth-*` → route handler `/api/v1/[...path]` (rewrite chỉ ĐIỀU PHỐI; handler thấy URL gốc nên cầu nối
 *   dịch lại bằng `toNestPath`).
 */
export function serverlessRewrites(): RewriteRule[] {
  return [
    ...WELL_KNOWN.flatMap(({ source, destination }) => [
      { source, destination },
      { source: `${source}/:path*`, destination },
    ]),
  ]
}

/** Đường dẫn gửi cho Nest: `/.well-known/oauth-*` (+ đuôi) → route OAuth; mọi path khác giữ nguyên. */
export function toNestPath(pathname: string): string {
  for (const { source, destination } of WELL_KNOWN) {
    if (pathname === source || pathname.startsWith(`${source}/`)) return destination
  }
  return pathname
}
