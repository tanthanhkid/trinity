import { PrismaClient } from '@prisma/client'

/**
 * One PrismaClient per company schema, created on first use and kept in a small LRU.
 * Company 1 (`public`) uses the base client owned by `PrismaService`; the others get a client whose URL carries
 * `?schema=c_<id>`, so every query (models, raw SQL, triggers) resolves inside that company's schema only.
 */
let baseClient: PrismaClient | null = null
const clients = new Map<string, { client: PrismaClient; lastUsed: number }>()

const maxClients = (): number => Math.max(2, Number(process.env.TENANT_MAX_CLIENTS) || 30)
const perClientConnections = (): string => process.env.TENANT_CONNECTION_LIMIT?.trim() || '2'

export function setBaseClient(client: PrismaClient): void {
  baseClient = client
}

export function getBaseClient(): PrismaClient {
  if (!baseClient) throw new Error('PrismaService has not been constructed yet')
  return baseClient
}

/** DATABASE_URL pointed at one schema (used by the client pool and by the migration runner). */
export function databaseUrlForSchema(schema: string, connectionLimit?: string): string {
  // Company schemas rely on a per-connection search_path (`?schema=`), which a transaction-mode pooler
  // (PgBouncer, Neon pooled) shares between clients. Use a direct / session-mode URL for them.
  const raw = process.env.TENANT_DATABASE_URL || process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL is not set')
  const url = new URL(raw)
  if (url.searchParams.get('pgbouncer') === 'true' || /-pooler\./.test(url.hostname)) {
    throw new Error(
      'Multi-tenant company schemas need a direct or session-mode Postgres URL: set TENANT_DATABASE_URL (or DIRECT_DATABASE_URL)',
    )
  }
  url.searchParams.set('schema', schema)
  // Always ours: a connection_limit meant for the main pool must not multiply by the number of companies.
  if (connectionLimit) url.searchParams.set('connection_limit', connectionLimit)
  else url.searchParams.delete('connection_limit')
  return url.toString()
}

export function clientForSchema(schema: string): PrismaClient {
  if (schema === 'public') return getBaseClient()
  if (!/^c_[0-9]+$/.test(schema)) throw new Error(`Refusing to open unknown schema "${schema}"`)
  const hit = clients.get(schema)
  if (hit) {
    hit.lastUsed = Date.now()
    return hit.client
  }
  const client = new PrismaClient({
    log: ['error'],
    datasources: { db: { url: databaseUrlForSchema(schema, perClientConnections()) } },
  })
  clients.set(schema, { client, lastUsed: Date.now() })
  evictIdle()
  return client
}

/**
 * Keeps at most TENANT_MAX_CLIENTS clients: the least recently used ones beyond the cap leave the pool at once and
 * are disconnected a few seconds later (so a query in flight can finish). Background jobs that walk every company
 * therefore cycle through the pool instead of growing it.
 */
function evictIdle(): void {
  const cap = maxClients()
  if (clients.size <= cap) return
  const now = Date.now()
  const byAge = [...clients.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [schema, entry] of byAge) {
    if (clients.size <= cap) break
    clients.delete(schema)
    // Let a query already in flight settle before closing; the next access to this company opens a fresh client.
    const delay = Math.min(10_000, Math.max(1_000, 10_000 - (now - entry.lastUsed)))
    setTimeout(() => void entry.client.$disconnect().catch(() => undefined), delay).unref?.()
  }
}

export async function disconnectTenantClients(): Promise<void> {
  const all = [...clients.values()]
  clients.clear()
  await Promise.all(all.map((e) => e.client.$disconnect().catch(() => undefined)))
}
