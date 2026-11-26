import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { currentCompanyId, syncBus } from '@trinity/prisma'

/** Cache keys and invalidations are per company: user ids repeat across companies. */
const companyPrefix = (): string => `${currentCompanyId() ?? 0}|`

/**
 * Cache quyền trong RAM của tiến trình, TTL mặc định 60 giây ("không cần đăng nhập lại khi admin sửa quyền"): sửa quyền /
 * vai trò / cây quản lý xoá ngay cache của tiến trình xử lý request. G12a bỏ Redis pub/sub; khi chạy song song nhiều tiến
 * trình (Node + Node, Node + Rust), vô hiệu chéo qua Postgres `NOTIFY` kênh `rbac` (G12b, `docs/sync-notify.md`); mất
 * kết nối nghe thì TTL 60 giây là lưới an toàn.
 */
@Injectable()
export class RbacCache implements OnModuleDestroy {
  private readonly store = new Map<string, { v: unknown; exp: number }>()
  private readonly unsubscribe: Array<() => void> = []

  constructor() {
    // G12b: tiến trình khác (Node thứ hai, Rust) sửa quyền/vai trò ⇒ `NOTIFY rbac` → xoá ngay phần cache của user đó.
    this.unsubscribe.push(
      syncBus.on('rbac', (m) => {
        const ids = m['ids']
        if (ids === '*') this.dropLocal(`${m.c}|`, '*')
        else if (Array.isArray(ids)) this.dropLocal(`${m.c}|`, ids.map(Number).filter(Number.isInteger))
      }),
      // Đứt kết nối nghe rồi nối lại: tin có thể đã mất ⇒ bỏ hết, đọc lại từ DB.
      syncBus.onResync(() => this.store.clear()),
    )
  }

  onModuleDestroy(): void {
    for (const u of this.unsubscribe.splice(0)) u()
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
    this.dropLocal(companyPrefix(), ids)
    // Quá nhiều id thì payload vượt 8 KB: phát "tất cả của công ty" (an toàn, chỉ tốn cache).
    const wire = ids === '*' || ids.length > 500 ? '*' : ids
    void syncBus.publish('rbac', { ids: wire }, currentCompanyId() ?? 0)
  }
}
