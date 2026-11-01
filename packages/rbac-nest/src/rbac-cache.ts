import Redis from 'ioredis'
import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common'
import { isServerless } from './runtime'
import { currentCompanyId } from '@trinity/prisma'

/** Cache keys and invalidations are per company: user ids repeat across companies. */
const companyPrefix = (): string => `${currentCompanyId() ?? 0}|`

const CHANNEL = 'rbac:invalidate'

/**
 * Cache RAM (theo process) + pub/sub Redis để mọi process đồng bộ vô hiệu khi quyền/vai trò/cây quản lý đổi
 * "Không cần đăng nhập lại khi admin sửa quyền".
 *
 * Không có `REDIS_URL` → chỉ cache cục bộ, TTL an toàn 60s (đủ ngắn để không
 * cần cross-process invalidation trong dev đơn máy).
 *
 * Serverless (`TRINITY_RUNTIME=serverless`): LUÔN chỉ cache RAM của instance, KHÔNG mở kết nối Redis nào
 * (không giữ được subscriber lâu dài; mỗi cold start mở 2 kết nối là phí) dù có `REDIS_URL`. Sửa quyền xoá ngay
 * cache instance xử lý request, các instance khác tự hết hạn sau ≤ 60s (TTL mặc định `set`) ⇒ hiệu lực ≤ 60s.
 */
@Injectable()
export class RbacCache implements OnModuleDestroy {
  private readonly log = new Logger('RbacCache')
  private readonly store = new Map<string, { v: unknown; exp: number }>()
  private pub?: Redis
  private sub?: Redis

  constructor() {
    if (isServerless()) {
      this.log.debug('Serverless — cache quyền chỉ trong RAM instance, TTL 60s')
      return
    }
    const url = process.env.REDIS_URL
    if (!url) {
      this.log.warn('Không có REDIS_URL — chỉ vô hiệu cache cục bộ, TTL 60s')
      return
    }
    this.pub = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false })
    this.sub = new Redis(url, { maxRetriesPerRequest: null })
    // Mất Redis không được làm sập process / spam log: cache RAM + TTL 60s vẫn đúng.
    this.pub.on('error', (e) => this.warnThrottled(e))
    this.sub.on('error', (e) => this.warnThrottled(e))
    this.sub.subscribe(CHANNEL).catch((e) => this.log.warn(`subscribe lỗi: ${e.message}`))
    this.sub.on('message', (_c, msg) => {
      // "<companyId>|<ids or *>" (older processes publish without the prefix = company 1)
      const [cid, body] = msg.includes('|') ? msg.split('|', 2) : ['1', msg]
      this.dropLocal(`${cid}|`, body === '*' ? '*' : body.split(',').map(Number))
    })
  }

  private lastWarn = 0
  private warnThrottled(e: Error): void {
    if (Date.now() - this.lastWarn < 60_000) return
    this.lastWarn = Date.now()
    this.log.warn(`Redis lỗi (${e.message}) — dùng cache RAM, TTL 60s`)
  }

  get<T>(k: string): T | undefined {
    const key = companyPrefix() + k
    const e = this.store.get(key)
    if (!e) return undefined
    if (e.exp < Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return e.v as T
  }

  set(k: string, v: unknown, ttlMs = 60_000): void {
    this.store.set(companyPrefix() + k, { v, exp: Date.now() + ttlMs })
  }

  private dropLocal(prefix: string, ids: number[] | '*'): void {
    if (ids === '*') {
      for (const k of [...this.store.keys()]) if (k.startsWith(prefix)) this.store.delete(k)
      return
    }
    // khoá dạng "g:<uid>" (khớp CHÍNH XÁC) và "s:<uid>:<scope>" (khớp theo
    // tiền tố CÓ dấu ':' chặn cuối id). Trước đây dùng `startsWith('g:'+id)`
    // trần — thiếu delimiter khiến invalidate user 1 xoá NHẦM cache của user
    // 12/19/100... (mọi id có "1" làm tiền tố thập phân). Đây là over-
    // invalidation (không leak quyền, chỉ tốn cache oan) nhưng vẫn là bug
    // đúng-sai rõ ràng, sửa cho khớp ý định trong comment.
    const idSet = new Set(ids)
    for (const full of [...this.store.keys()]) {
      if (!full.startsWith(prefix)) continue
      const k = full.slice(prefix.length)
      const gMatch = /^g:(\d+)$/.exec(k)
      if (gMatch && idSet.has(Number(gMatch[1]))) {
        this.store.delete(full)
        continue
      }
      const sMatch = /^s:(\d+):/.exec(k)
      if (sMatch && idSet.has(Number(sMatch[1]))) {
        this.store.delete(full)
      }
    }
  }

  async invalidateUsers(ids: number[] | '*'): Promise<void> {
    const prefix = companyPrefix()
    this.dropLocal(prefix, ids)
    await this.pub?.publish(CHANNEL, prefix + (ids === '*' ? '*' : ids.join(','))).catch(() => undefined)
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit()])
  }
}
