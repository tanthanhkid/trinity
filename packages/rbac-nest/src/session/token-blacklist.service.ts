import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { currentCompanyId, syncBus, tenantKey, tenantKeyFor } from '@trinity/prisma'

interface BlacklistEntry {
  expiresAt: number
}

@Injectable()
export class TokenBlacklistService implements OnModuleDestroy {
  private readonly blacklist = new Map<string, BlacklistEntry>()
  private readonly unsubscribe: Array<() => void> = []

  constructor() {
    // G12b: đăng xuất / khoá user ở tiến trình khác (`NOTIFY token`) có hiệu lực ở đây ngay.
    this.unsubscribe.push(
      syncBus.on('token', (m) => {
        const u = Number(m['u'])
        if (!Number.isInteger(u)) return
        const key = tenantKeyFor(m.c, u)
        if (m['op'] === 'unblock') this.blacklist.delete(key)
        else if (m['op'] === 'block') this.blacklist.set(key, { expiresAt: Date.now() + this.TOKEN_TTL_MS })
      }),
    )
  }

  onModuleDestroy(): void {
    for (const u of this.unsubscribe.splice(0)) u()
  }

  // Keys carry the company (`tenantKey`): user ids repeat across companies.
  private readonly TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes (access token lifetime)

  blacklistUser(userId: number): void {
    this.cleanup()
    this.blacklist.set(tenantKey(userId), {
      expiresAt: Date.now() + this.TOKEN_TTL_MS,
    })
    void syncBus.publish('token', { op: 'block', u: userId }, currentCompanyId())
  }

  isBlacklisted(userId: number): boolean {
    this.cleanup()
    const key = tenantKey(userId)
    const entry = this.blacklist.get(key)
    if (!entry) return false
    if (Date.now() > entry.expiresAt) {
      this.blacklist.delete(key)
      return false
    }
    return true
  }

  removeUser(userId: number): void {
    this.blacklist.delete(tenantKey(userId))
    void syncBus.publish('token', { op: 'unblock', u: userId }, currentCompanyId())
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
