import { after, type NextRequest } from 'next/server'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { toNestPath } from '@/lib/serverless-runtime'
import { loadNestModule, type NestModule } from "#nest-loader"

/**
 * Cầu nối Web `Request` → Express app của Nest (`apps/monolith/dist/serverless.js`) trong CÙNG process Next.
 *
 * Cách làm: handler Nest được gắn vào một `http.Server` NỘI BỘ nghe cổng ngẫu nhiên trên 127.0.0.1 (chỉ trong instance,
 * không ra ngoài) và request được chuyển qua `http.request` loopback — stream cả 2 chiều, ngữ nghĩa HTTP THẬT.
 * (Nest vẫn KHÔNG `listen`: contract `getHandler()` giữ nguyên, ổ cắm thuộc phía web.)
 *
 * Vì sao KHÔNG:
 * - Pages API route (Node `req/res` gốc): chỉ cần có thư mục `pages/` là Next chèn `next/navigation-types/compat` vào
 *   `next-env.d.ts` ⇒ `useSearchParams()/usePathname()` thành `| null` ⇒ `next build` đỏ type-check ở hàng chục file App Router.
 * - `light-my-request` (req/res giả): Express đổi prototype của `res` nên mất hàm ghi của thư viện ⇒ body RỖNG (đã thử).
 */

type NestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void

let started: Promise<number> | null = null

/**
 * Entry `apps/monolith/dist/serverless.js`: `TRINITY_MONOLITH_ENTRY` ghi đè; mặc định đi ngược từ thư mục chunk
 * (`.next/server/...`) rồi cwd tới khi thấy `apps/monolith/dist/serverless.js` (local/Vercel đều giữ cấu trúc `apps/*`).
 */
function resolveNestEntry(): string {
  const override = process.env.TRINITY_MONOLITH_ENTRY?.trim()
  if (override) return override
  const rel = path.join('apps', 'monolith', 'dist', 'serverless.js')
  for (const start of [/*turbopackIgnore: true*/ __dirname, /*turbopackIgnore: true*/ process.cwd()]) {
    let dir = start
    for (let i = 0; i < 12; i++) {
      const candidate = path.join(dir, rel)
      if (fs.existsSync(candidate)) return candidate
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // Chẩn đoán: Lambda có cấu trúc thư mục khác máy build — in nơi đã dò để sửa đúng chỗ.
  const peek = (d: string): string => {
    try { return fs.readdirSync(d).slice(0, 20).join(',') } catch (e) { return `ERR ${(e as Error).message}` }
  }
  const cwd = process.cwd()
  throw new Error(
    `Không tìm thấy apps/monolith/dist/serverless.js — chưa build monolith (pnpm --filter @trinity/monolith build). ` +
      `__dirname=${__dirname} cwd=${cwd} ls(cwd)=[${peek(cwd)}] ls(..)=[${peek(path.dirname(cwd))}] ls(../..)=[${peek(path.dirname(path.dirname(cwd)))}]`,
  )
}

/**
 * Serverless: `loadNestModule()` (nest-loader.serverless.ts, require tĩnh — Next vết đủ file). Mặc định trả null ⇒ dò đường dẫn.
 */
function loadNest(): NestModule {
  const mod = loadNestModule()
  if (mod) return mod
  const entry = resolveNestEntry()
  return createRequire(entry)(entry) as NestModule
}

/** Nạp Nest bằng `require` thật (không qua bundler: decorator metadata + require động + engine Prisma) rồi mở ổ cắm nội bộ. */
function ensureServer(): Promise<number> {
  started ??= (async () => {
    const mod = loadNest()
    const handler = await mod.getHandler()
    const server = http.createServer(handler)
    server.keepAliveTimeout = 60_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    server.unref() // không giữ process sống
    return (server.address() as AddressInfo).port
  })().catch((err) => {
    started = null // lỗi khởi động không bị cache — request sau thử lại
    throw err
  })
  return started
}

/**
 * Việc nền của Nest (webhook ra, thông báo fan-out, dọn file…) đăng ký ở sổ dùng chung `Symbol.for(...)` trong
 * `@trinity/rbac-nest` (`runInBackground`). Nest chạy trong `http.Server` loopback nên KHÔNG chắc có context request của Vercel
 * để `waitUntil` — ở đây (route, context hợp lệ) ta dùng `after()` (= `waitUntil` trên Vercel) chờ sổ cạn sau khi response xong.
 */
const BACKGROUND_TASKS_KEY = Symbol.for('trinity.background-tasks')
const DRAIN_MAX_MS = 45_000

async function drainNestBackground(): Promise<void> {
  const tasks = (globalThis as Record<symbol, unknown>)[BACKGROUND_TASKS_KEY] as Set<Promise<unknown>> | undefined
  if (!tasks) return
  const deadline = Date.now() + DRAIN_MAX_MS
  while (tasks.size > 0 && Date.now() < deadline) {
    await Promise.race([
      Promise.allSettled([...tasks]),
      new Promise((resolve) => setTimeout(resolve, Math.max(1, deadline - Date.now()))),
    ])
  }
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'])
const NO_BODY_STATUS = new Set([101, 204, 205, 304])

export async function handleWithNest(req: NextRequest): Promise<Response> {
  const port = await ensureServer()

  const headers: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key)) headers[key] = value
  })

  // Chạy NGAY trong context của request thật; chỉ bắt đầu chờ sau khi response đã gửi hết.
  after(drainNestBackground)

  return new Promise<Response>((resolve, reject) => {
    const up = http.request(
      { host: '127.0.0.1', port, method: req.method, path: toNestPath(req.nextUrl.pathname) + req.nextUrl.search, headers },
      (res) => {
        const out = new Headers()
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const key = res.rawHeaders[i]
          if (!HOP_BY_HOP.has(key.toLowerCase())) out.append(key, res.rawHeaders[i + 1]) // append: giữ nhiều `set-cookie`
        }
        const status = res.statusCode ?? 502
        const noBody = NO_BODY_STATUS.has(status) || req.method === 'HEAD'
        if (noBody) res.resume()
        resolve(
          new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: out }),
        )
      },
    )
    up.once('error', reject)
    // Client ngắt giữa chừng → ngắt luôn request loopback (không để Nest xử lý tiếp / rò kết nối).
    req.signal.addEventListener('abort', () => up.destroy(), { once: true })
    if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
      Readable.fromWeb(req.body as import('node:stream/web').ReadableStream).pipe(up)
    } else {
      up.end()
    }
  })
}
