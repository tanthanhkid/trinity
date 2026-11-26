import { isMultiTenant, listActiveCompanies, runWithCompany } from '@trinity/prisma'

/**
 * Multi-tenant: a background job touches one company's data, so each timer round runs it once per active company,
 * each in its own company context (`runForEachCompany`). Cursor per job key.
 */
const cursors = new Map<string, number>()

/**
 * Runs `fn` once per active company, each in its own company context, one after another.
 *  - `budgetMs`: stop starting new companies once it is spent; the next run resumes after the last company
 *    reached (per `key`), so a long list is covered across rounds instead of always restarting at company 1.
 *  - A company that fails does not stop the others; if any failed, the run rejects afterwards with every
 *    failure so the caller logs an error (monitoring stays loud).
 */
export async function runForEachCompany<T>(fn: () => Promise<T>, opts: { key?: string; budgetMs?: number } = {}): Promise<unknown> {
  if (!isMultiTenant()) return fn()
  const companies = await listActiveCompanies()
  if (!companies.length) return {}
  const key = opts.key ?? ''
  // Resume after the last company reached (by id, so companies added/suspended in between do not shift it).
  const last = cursors.get(key)
  const next = last === undefined ? -1 : companies.findIndex((c) => c.id > last)
  const start = next < 0 ? 0 : next
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity
  const out: Record<number, unknown> = {}
  const failures: string[] = []
  let i = 0
  for (; i < companies.length; i++) {
    if (i > 0 && Date.now() >= deadline) break
    const company = companies[(start + i) % companies.length]
    // Saved before the run: if this round is cut short, the next one starts after this company.
    cursors.set(key, company.id)
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
