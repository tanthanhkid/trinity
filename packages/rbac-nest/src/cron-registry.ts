import { isMultiTenant, listActiveCompanies, runWithCompany } from '@trinity/prisma'

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

/**
 * Multi-tenant: a job's `run` touches one company's data, so a tick runs it once per active company, each in
 * its own company context. Timer-driven jobs wrap their tick the same way (`runForEachCompany`).
 */
const cursors = new Map<string, number>()

/**
 * Runs `fn` once per active company, each in its own company context, one after another.
 *  - `budgetMs`: stop starting new companies once it is spent; the next run resumes after the last company
 *    reached (per `key`), so a long list is covered across ticks instead of always restarting at company 1.
 *  - A company that fails does not stop the others; if any failed, the run rejects afterwards with every
 *    failure so the tick reports `error` (monitoring stays loud).
 */
export async function runForEachCompany<T>(fn: () => Promise<T>, opts: { key?: string; budgetMs?: number } = {}): Promise<unknown> {
  if (!isMultiTenant()) return fn()
  const companies = await listActiveCompanies()
  if (!companies.length) return {}
  const key = opts.key ?? ''
  const start = Math.min(cursors.get(key) ?? 0, companies.length - 1)
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity
  const out: Record<number, unknown> = {}
  const failures: string[] = []
  let i = 0
  for (; i < companies.length; i++) {
    if (i > 0 && Date.now() >= deadline) break
    const company = companies[(start + i) % companies.length]
    // Saved before the run: if this tick is cut short (serverless timeout), the next one starts after this company.
    cursors.set(key, (start + i + 1) % companies.length)
    try {
      out[company.id] = await runWithCompany(company, fn)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[cron${key ? ` ${key}` : ''}] company ${company.id}: ${msg}`)
      failures.push(`company ${company.id}: ${msg}`)
    }
  }
  if (failures.length) throw new Error(failures.join('; ').slice(0, 1000))
  return out
}

export const cronRegistry = {
  /** Đăng ký (ghi đè theo tên — an toàn khi module khởi tạo lại trong test). Trả hàm gỡ. */
  register(input: CronJob): () => void {
    // Leave headroom inside the job's own budget for the company that is still running when it runs out.
    const job: CronJob = {
      ...input,
      run: () => runForEachCompany(input.run, { key: input.name, budgetMs: Math.floor(input.budgetMs * 0.6) }),
    }
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
