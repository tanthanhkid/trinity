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
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL is not set')
  const url = new URL(raw)
  url.searchParams.set('schema', schema)
  if (connectionLimit && !url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', connectionLimit)
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

/** Disconnects the least recently used clients beyond the cap (never ones used in the last minute). */
function evictIdle(): void {
  const cap = maxClients()
  if (clients.size <= cap) return
  const now = Date.now()
  const byAge = [...clients.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [schema, entry] of byAge) {
    if (clients.size <= cap) break
    if (now - entry.lastUsed < 60_000) break
    clients.delete(schema)
    void entry.client.$disconnect().catch(() => undefined)
  }
}

export async function disconnectTenantClients(): Promise<void> {
  const all = [...clients.values()]
  clients.clear()
  await Promise.all(all.map((e) => e.client.$disconnect().catch(() => undefined)))
}
