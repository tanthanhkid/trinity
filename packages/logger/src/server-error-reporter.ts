/**
 * Hook báo lỗi 5xx — không phụ thuộc nhà cung cấp nào. Mặc định không có reporter (no-op);
 * `apps/monolith/src/monitoring.ts` đăng ký reporter khi cấu hình giám sát lỗi được bật.
 */
export interface ServerErrorContext {
  method?: string
  status?: number
  url?: string
  userId?: number | string | null
}

export type ServerErrorReporter = (err: unknown, ctx: ServerErrorContext) => void

let reporter: ServerErrorReporter | null = null

export function setServerErrorReporter(fn: ServerErrorReporter | null): void {
  reporter = fn
}

/** Không bao giờ throw: lỗi của chính reporter bị nuốt để không làm hỏng response. */
export function reportServerError(err: unknown, ctx: ServerErrorContext = {}): void {
  if (!reporter) return
  try {
    reporter(err, ctx)
  } catch {
    /* swallow */
  }
}
