/**
 * Cờ runtime DUY NHẤT để chạy trên Vercel: `TRINITY_RUNTIME=serverless`.
 * Không đặt ⇒ hành vi chạy server thường: timer, Socket.IO, subscriber Redis chạy như trước.
 */
export function isServerless(): boolean {
  // Cùng cách chuẩn hoá ở mọi nơi đọc cờ này (monolith, web, logger):
  // lệch cách đọc (vd giá trị env có khoảng trắng/xuống dòng thừa) = web coi là serverless còn Nest bật timer/Redis/Socket.IO.
  return process.env.TRINITY_RUNTIME?.trim().toLowerCase() === 'serverless'
}

/**
 * Sổ các việc nền đang chạy của instance (chỉ ghi ở serverless). Nest chạy trong `http.Server` loopback nên
 * `@vercel/request-context` (AsyncLocalStorage) KHÔNG chắc thấy được request thật ⇒ route cầu nối (`nest-bridge.ts`,
 * nằm trong context hợp lệ của Vercel) gọi `after()` rồi chờ sổ này cạn — cùng khoá `Symbol.for` với phía web.
 */
export const BACKGROUND_TASKS_KEY = Symbol.for('trinity.background-tasks')
function backgroundTasks(): Set<Promise<unknown>> {
  const g = globalThis as Record<symbol, unknown>
  return (g[BACKGROUND_TASKS_KEY] ??= new Set<Promise<unknown>>()) as Set<Promise<unknown>>
}

/** Chờ mọi việc nền đang chạy (kể cả việc đẻ thêm trong lúc chờ) tới `maxMs`. Dùng cho test + cầu nối. */
export async function drainBackgroundTasks(maxMs = 45_000): Promise<void> {
  const deadline = Date.now() + maxMs
  const tasks = backgroundTasks()
  while (tasks.size > 0 && Date.now() < deadline) {
    await Promise.race([
      Promise.allSettled([...tasks]),
      new Promise((resolve) => setTimeout(resolve, Math.max(1, deadline - Date.now()))),
    ])
  }
}

interface RequestContextLike {
  waitUntil?: (p: Promise<unknown>) => void
}
interface RequestContextHolder {
  get?: () => RequestContextLike | undefined
}

/**
 * Cơ chế "chạy nền sau khi trả response":
 * - Vercel: `globalThis[Symbol.for('@vercel/request-context')].get().waitUntil(p)` — hàm được giữ sống tới khi `p` xong
 *   (không cần thêm dependency `@vercel/functions`).
 * - Không có context (VPS, test, dev): chỉ fire-and-forget; process luôn sống nên promise tự chạy xong.
 * Không bao giờ ném lỗi, không bao giờ chặn response; lỗi của task đi qua `onError` (mặc định nuốt).
 * Trả `'waitUntil' | 'detached'` cho test/log biết đã dùng cơ chế nào.
 */
export function runInBackground(
  task: () => Promise<unknown>,
  onError: (err: unknown) => void = () => undefined,
): 'waitUntil' | 'detached' {
  const p = Promise.resolve()
    .then(task)
    .catch((err: unknown) => {
      try {
        onError(err)
      } catch {
        /* nuốt */
      }
    })
  if (isServerless()) {
    const tasks = backgroundTasks()
    tasks.add(p)
    void p.finally(() => tasks.delete(p))
  }
  try {
    const holder = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
      | RequestContextHolder
      | undefined
    const waitUntil = holder?.get?.()?.waitUntil
    if (typeof waitUntil === 'function') {
      waitUntil(p)
      return 'waitUntil'
    }
  } catch {
    /* rơi xuống detached */
  }
  return 'detached'
}
