import type Redis from 'ioredis'
import { isServerless } from './runtime'

interface Entry {
  value: string
  expiresAt: number | null
}

/**
 * Redis giả trong RAM của instance — chỉ dựng ở serverless khi KHÔNG có `REDIS_URL`.
 * Chỉ hiện thực đúng các lệnh code đang dùng (get/set[EX,NX]/setex/del/incr/expire).
 * Mọi caller đã fail-open (cache/dedupe/guard), nên khác instance không
 * thấy nhau chỉ làm cache hụt, không sai nghiệp vụ. Có `REDIS_URL` thì dùng Redis thật như cũ.
 */
export class MemoryRedis {
  private readonly store = new Map<string, Entry>()
  private static readonly MAX_KEYS = 5000

  private live(key: string): Entry | undefined {
    const e = this.store.get(key)
    if (!e) return undefined
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return e
  }

  private put(key: string, value: string, ttlSec: number | null): void {
    if (this.store.size >= MemoryRedis.MAX_KEYS) {
      const first = this.store.keys().next()
      if (!first.done) this.store.delete(first.value)
    }
    this.store.set(key, { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : null })
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    const flags = args.map((a) => String(a).toUpperCase())
    const exIdx = flags.indexOf('EX')
    const ttl = exIdx >= 0 ? Number(args[exIdx + 1]) : null
    if (flags.includes('NX') && this.live(key)) return null
    this.put(key, String(value), ttl)
    return 'OK'
  }

  async setex(key: string, ttlSec: number, value: string): Promise<'OK'> {
    this.put(key, String(value), ttlSec)
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0
    for (const k of keys) if (this.store.delete(k)) n += 1
    return n
  }

  async incr(key: string): Promise<number> {
    const cur = this.live(key)
    const next = (cur ? Number(cur.value) || 0 : 0) + 1
    this.store.set(key, { value: String(next), expiresAt: cur?.expiresAt ?? null })
    return next
  }

  async expire(key: string, ttlSec: number): Promise<number> {
    const e = this.live(key)
    if (!e) return 0
    e.expiresAt = Date.now() + ttlSec * 1000
    return 1
  }

  async quit(): Promise<'OK'> {
    return 'OK'
  }

  disconnect(): void {
    /* no-op */
  }
}

/** Serverless và không có `REDIS_URL` ⇒ không mở kết nối Redis nào cả. */
export function shouldUseMemoryRedis(): boolean {
  return isServerless() && !process.env.REDIS_URL
}

/** Client cho `REDIS_CLIENT`: RAM khi `shouldUseMemoryRedis()`, ngược lại `build()` (ioredis thật). */
export function createRedisClient(build: () => Redis): Redis {
  return shouldUseMemoryRedis() ? (new MemoryRedis() as unknown as Redis) : build()
}
