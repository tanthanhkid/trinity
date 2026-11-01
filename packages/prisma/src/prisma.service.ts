import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import { clientForSchema, disconnectTenantClients, setBaseClient, trackClientWork } from './tenant/clients'
import { MissingCompanyContextError, currentCompany, isMultiTenant } from './tenant/context'

/**
 * Prisma mặc định tính pool size = `num_cpus*2+1` mỗi client, có thể phồng hơn cần
 * trên máy nhỏ. `PrismaModule` là `@Global()` và dùng CHUNG trong monolith — chỉ có
 * ĐÚNG 1 `PrismaClient`/1 connection pool cho toàn process.
 *
 * Chốt TƯỜNG MINH `connection_limit` thay vì để Prisma tự suy theo CPU — mặc định 5,
 * override qua env `PRISMA_CONNECTION_LIMIT` khi cần. KHÔNG đụng `DATABASE_URL` nếu
 * người vận hành đã tự set `connection_limit` trong đó.
 */
function resolveDatasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL
  if (!raw) return undefined
  if (/[?&]connection_limit=/.test(raw)) return raw
  const limit = process.env.PRISMA_CONNECTION_LIMIT?.trim() || '5'
  const separator = raw.includes('?') ? '&' : '?'
  return `${raw}${separator}connection_limit=${limit}`
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = resolveDatasourceUrl()
    super({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
      ...(url ? { datasources: { db: { url } } } : {}),
    })
  }

  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await disconnectTenantClients()
    await this.$disconnect()
  }
}

/**
 * Members that always act on the base client itself (lifecycle, Nest hooks), whatever the company context.
 * Everything else — model delegates, `$transaction`, `$queryRaw`… — goes to the current company's client.
 */
const PASSTHROUGH = new Set<PropertyKey>([
  'onModuleInit',
  'onModuleDestroy',
  '$connect',
  '$disconnect',
  '$on',
  'constructor',
  'then',
  'toJSON',
])

/** Model delegates (`prisma.contact`…) — derived from the generated client, so new models are covered. */
const MODEL_DELEGATES = new Set<string>(
  Object.values(Prisma.ModelName).map((name) => name.charAt(0).toLowerCase() + name.slice(1)),
)

/**
 * Only data access is routed: model delegates and the `$` query API (`$queryRaw`, `$transaction`…). Everything
 * else (`hasOwnProperty`, Nest's metadata scans, Prisma internals) reads the base object.
 */
function isTenantData(prop: string): boolean {
  return MODEL_DELEGATES.has(prop) || (prop.startsWith('$') && !PASSTHROUGH.has(prop))
}

/**
 * Multi-tenant routing: `PrismaService` is injected everywhere, so it is the one place that decides which
 * company's schema a query touches. With `MULTI_TENANT=true` it resolves every access against the company of
 * the current async context and throws when there is none (fail-closed). Single-tenant mode: plain client.
 */
function tenantRouted(base: PrismaService): PrismaService {
  setBaseClient(base)
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || PASSTHROUGH.has(prop) || !isTenantData(prop) || !isMultiTenant()) {
        return Reflect.get(target, prop, receiver)
      }
      const company = currentCompany()
      if (!company) throw new MissingCompanyContextError(`prisma.${String(prop)}`)
      const client = company.schema === 'public' ? target : clientForSchema(company.schema)
      const value = Reflect.get(client, prop, client)
      if (typeof value !== 'function') return value
      if (prop === '$transaction' && company.schema !== 'public') {
        return (...args: unknown[]) =>
          trackClientWork(company.schema, () => (value as (...a: unknown[]) => Promise<unknown>).apply(client, args))
      }
      return value.bind(client)
    },
  })
}

/** Nest instantiates the provider through this factory so every injection gets the routed proxy. */
export function createPrismaService(): PrismaService {
  return tenantRouted(new PrismaService())
}
