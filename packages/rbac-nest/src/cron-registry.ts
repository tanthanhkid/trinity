/**
 * Sổ đăng ký job nền. Mỗi job nền của monolith (webhook, dọn outbox, nhắc việc…) đăng ký MỘT hàm
 * `runOnce` ở đây. Ở server thường timer riêng vẫn gọi hàm đó như cũ; ở serverless không timer nào chạy, thay vào đó
 * `GET /api/v1/internal/cron/tick` gọi `runCronTick()` để chạy MỘT lượt mọi job.
 * Là singleton module-level (không DI) để mọi service trong monolith đăng ký được mà không import chéo nhau.
 */
export interface CronJob {
  name: string
  /** Trần thời gian của riêng job (ms). */
  budgetMs: number
  run: () => Promise<unknown>
}

export type CronJobStatus = 'ok' | 'error' | 'timeout'

export interface CronJobResult {
  name: string
  status: CronJobStatus
  ms: number
  result?: unknown
  error?: string
}

export interface CronTickSummary {
  startedAt: string
  durationMs: number
  jobs: CronJobResult[]
}

/** Tổng trần cả lượt < 50s (giới hạn thời gian của hàm serverless ~60s, chừa dư cho cold start + trả JSON). */
export const CRON_TICK_TOTAL_BUDGET_MS = 45_000

const jobs = new Map<string, CronJob>()

export const cronRegistry = {
  /** Đăng ký (ghi đè theo tên — an toàn khi module khởi tạo lại trong test). Trả hàm gỡ. */
  register(job: CronJob): () => void {
    jobs.set(job.name, job)
    return () => {
      if (jobs.get(job.name) === job) jobs.delete(job.name)
    }
  },
  list(): CronJob[] {
    return [...jobs.values()]
  },
  clear(): void {
    jobs.clear()
  },
}

const bigintReplacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)

function jsonSafe(v: unknown): unknown {
  if (v === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(v, bigintReplacer))
  } catch {
    return String(v)
  }
}

async function runOne(job: CronJob, capMs: number): Promise<CronJobResult> {
  const t0 = Date.now()
  const limit = Math.max(1, Math.min(job.budgetMs, capMs))
  let timer: ReturnType<typeof setTimeout> | undefined
  const TIMEOUT = Symbol('timeout')
  try {
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), limit)
    })
    const out = await Promise.race([Promise.resolve().then(job.run), timeout])
    if (out === TIMEOUT) return { name: job.name, status: 'timeout', ms: Date.now() - t0 }
    return { name: job.name, status: 'ok', ms: Date.now() - t0, result: jsonSafe(out) }
  } catch (err) {
    return { name: job.name, status: 'error', ms: Date.now() - t0, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Chạy MỘT lượt mọi job đã đăng ký, song song; lỗi/timeout của job này không chặn job khác. Mỗi job bị chặn ở
 * `min(budgetMs, totalBudgetMs)` nên cả lượt luôn ≤ `totalBudgetMs`. Job quá hạn không bị huỷ được (JS không huỷ
 * promise) nhưng lượt tick vẫn trả lời đúng hạn; việc dở sẽ được lượt sau làm tiếp (mọi job đều idempotent/claim nguyên tử).
 */
export async function runCronTick(totalBudgetMs: number = CRON_TICK_TOTAL_BUDGET_MS): Promise<CronTickSummary> {
  const t0 = Date.now()
  const results = await Promise.all(cronRegistry.list().map((j) => runOne(j, totalBudgetMs)))
  return { startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, jobs: results }
}
