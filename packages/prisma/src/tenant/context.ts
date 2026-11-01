import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Multi-tenant context: one company per sign-up, one Postgres schema per company.
 *
 * - `MULTI_TENANT=true` turns it on. Off (the default, self-hosted installs) every request runs as the single
 *   default company on the `public` schema, exactly as before.
 * - On, every database access must happen inside a company context. `PrismaService` refuses to run a query
 *   without one (fail-closed), so a code path that forgot to pick a company errors out instead of reading
 *   another company's rows.
 *
 * The HTTP middleware opens an empty scope per request (`runInTenantScope`); the JWT guard, the login route and
 * the public webhook routes then call `enterCompany()` once they know whose request it is. Background jobs
 * use `forEachCompany()`.
 */
export interface CompanyRef {
  id: number
  /** Postgres schema holding this company's tables. Company 1 (data that existed before multi-tenancy) = `public`. */
  schema: string
}

interface TenantStore {
  company: CompanyRef | null
  /**
   * Used only while `company` is unset. Public routes (webhook tokens, store/payment links) that predate
   * multi-tenancy carry no company hint and keep working for company 1; their lookups still need the secret
   * token or slug, so a fallback never exposes anything a company-1 URL did not already expose.
   */
  fallback?: CompanyRef | null
}

export const DEFAULT_COMPANY: CompanyRef = Object.freeze({ id: 1, schema: 'public' })

const storage = new AsyncLocalStorage<TenantStore>()

export function isMultiTenant(): boolean {
  return process.env.MULTI_TENANT === 'true'
}

export function schemaForCompany(id: number): string {
  if (!Number.isInteger(id) || id < 1) throw new Error(`Invalid company id: ${id}`)
  return id === 1 ? 'public' : `c_${id}`
}

export function companyRef(id: number): CompanyRef {
  return { id, schema: schemaForCompany(id) }
}

/** Opens an empty, mutable scope (one per HTTP request / socket event). */
export function runInTenantScope<T>(fn: () => T): T {
  return storage.run({ company: null }, fn)
}

/** Runs `fn` as `company` (jobs, webhooks, tests). Nested calls get their own scope. */
export function runWithCompany<T>(company: CompanyRef, fn: () => T): T {
  return storage.run({ company }, fn)
}

/**
 * Binds the current scope to `company`. Re-entering the same company is a no-op; switching an already bound
 * scope to a different company throws — one request belongs to exactly one company.
 */
export function enterCompany(company: CompanyRef): void {
  const store = storage.getStore()
  if (!store) throw new Error('enterCompany() called outside a tenant scope')
  if (store.company && store.company.id !== company.id) {
    throw new Error(`Tenant scope already bound to company ${store.company.id}, refusing to switch to ${company.id}`)
  }
  store.company = company
}

/** Sets the fallback company of the current scope (see `TenantStore.fallback`). No-op outside a scope. */
export function setFallbackCompany(company: CompanyRef | null): void {
  const store = storage.getStore()
  if (store) store.fallback = company
}

/** True when the current scope is bound to a company explicitly (not via the fallback). */
export function hasExplicitCompany(): boolean {
  if (!isMultiTenant()) return true
  return Boolean(storage.getStore()?.company)
}

/** The company of the current scope. Single-tenant mode: always the default company. */
export function currentCompany(): CompanyRef | null {
  if (!isMultiTenant()) return DEFAULT_COMPANY
  const store = storage.getStore()
  return store?.company ?? store?.fallback ?? null
}

export function currentCompanyId(): number | null {
  return currentCompany()?.id ?? null
}

export class MissingCompanyContextError extends Error {
  constructor(what: string) {
    super(`No company context for ${what}: wrap the call in runWithCompany()/forEachCompany() or enterCompany() first`)
    this.name = 'MissingCompanyContextError'
  }
}

export function requireCompany(what = 'this operation'): CompanyRef {
  const c = currentCompany()
  if (!c) throw new MissingCompanyContextError(what)
  return c
}

/**
 * Key prefix for per-company in-memory / Redis state. Database ids (user 1, contact 1…) repeat across
 * companies, so any cache keyed by id must also carry the company.
 */
export function tenantKey(key: string | number): string {
  const c = currentCompany()
  if (!c) throw new MissingCompanyContextError(`cache key ${String(key)}`)
  return c.id === 1 ? String(key) : `c${c.id}:${key}`
}
