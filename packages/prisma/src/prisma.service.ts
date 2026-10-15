import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

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
    await this.$disconnect()
  }
}
