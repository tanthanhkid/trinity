import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { currentCompanyId, syncBus, tenantKey, tenantKeyFor } from '@trinity/prisma'
import { runForEachCompany } from '../for-each-company'
import { deleteBlock, loadBlocks, saveBlock } from './security-state'

interface BlacklistEntry {
  expiresAt: number
  /** Thời điểm của thay đổi (ms, giờ người phát): tin cũ hơn thay đổi đã áp không được ghi đè. */
  at: number
  /** false = đã gỡ (dấu mộ giữ tới hết TTL để tin `block` đến muộn không làm sống lại). */
  blocked: boolean
}

/**
 * Blacklist token theo user. RAM là lớp nhanh; bảng `token_blacklist` là sự thật bền (G12b): khởi động lại hoặc nối lại kênh
 * NOTIFY thì nạp lại từ DB. Tin NOTIFY mang `t` (thời điểm thay đổi) và chỉ áp khi không cũ hơn thay đổi đã có.
 */
@Injectable()
export class TokenBlacklistService implements OnModuleInit, OnModuleDestroy {
  private readonly blacklist = new Map<string, BlacklistEntry>()
  private readonly unsubscribe: Array<() => void> = []
  // Keys carry the company (`tenantKey`): user ids repeat across companies.
  private readonly TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes (access token lifetime)

  constructor() {
    // G12b: đăng xuất / khoá user ở tiến trình khác (`NOTIFY token`) có hiệu lực ở đây ngay.
    this.unsubscribe.push(
      syncBus.on('token', (m) => {
        const u = Number(m['u'])
        const t = Number(m['t'])
        if (!Number.isInteger(u) || !Number.isFinite(t)) return
        this.apply(tenantKeyFor(m.c, u), m['op'] === 'block', t)
      }),
      // Nối lại sau lúc đứt: tin đã mất ⇒ nạp lại từ bảng bền.
      syncBus.onResync(() => void this.reload()),
    )
  }

  onModuleInit(): void {
    void this.reload()
  }

  onModuleDestroy(): void {
    for (const u of this.unsubscribe.splice(0)) u()
  }

  private apply(key: string, blocked: boolean, at: number): void {
    const cur = this.blacklist.get(key)
    if (cur && cur.at > at) return
    this.blacklist.set(key, { blocked, at, expiresAt: at + this.TOKEN_TTL_MS })
  }

  /** Nạp lại mọi công ty từ DB: dòng mới hơn thắng; mục đang chặn mà DB không còn (đã gỡ ở nơi khác) thì bỏ. */
  async reload(): Promise<void> {
    try {
      await runForEachCompany(async () => {
        const cid = currentCompanyId() ?? 1
        const belongs = (key: string): boolean => (cid === 1 ? /^\d+$/.test(key) : key.startsWith(`c${cid}:`))
        const rows = await loadBlocks()
        const seen = new Set<string>()
        for (const r of rows) {
          const key = tenantKey(r.user_id)
          seen.add(key)
          const cur = this.blacklist.get(key)
          const at = r.updated_at.getTime()
          if (!cur || cur.at <= at) this.blacklist.set(key, { blocked: true, at, expiresAt: r.expires_at.getTime() })
        }
        for (const [key, e] of this.blacklist) {
          if (belongs(key) && e.blocked && !seen.has(key) && Date.now() - e.at > 5_000) this.blacklist.delete(key)
        }
      }, { key: 'token-blacklist-reload' })
    } catch (e) {
      console.warn(`[token-blacklist] nạp lại lỗi: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  blacklistUser(userId: number): void {
    this.cleanup()
    const at = Date.now()
    this.blacklist.set(tenantKey(userId), { expiresAt: at + this.TOKEN_TTL_MS, at, blocked: true })
    void saveBlock(userId, new Date(at + this.TOKEN_TTL_MS))
    void syncBus.publish('token', { op: 'block', u: userId, t: at }, currentCompanyId())
  }

  isBlacklisted(userId: number): boolean {
    this.cleanup()
    const key = tenantKey(userId)
    const entry = this.blacklist.get(key)
    if (!entry || !entry.blocked) return false
    if (Date.now() > entry.expiresAt) {
      this.blacklist.delete(key)
      return false
    }
    return true
  }

  removeUser(userId: number): void {
    const at = Date.now()
    this.blacklist.set(tenantKey(userId), { blocked: false, at, expiresAt: at + this.TOKEN_TTL_MS })
    void deleteBlock(userId)
    void syncBus.publish('token', { op: 'unblock', u: userId, t: at }, currentCompanyId())
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.blacklist) {
      if (now > entry.expiresAt) {
        this.blacklist.delete(key)
      }
    }
  }

  /** Exposed for testing */
  clear(): void {
    this.blacklist.clear()
  }
}
