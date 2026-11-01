import { Injectable } from '@nestjs/common'
import { tenantKey } from '@trinity/prisma'

interface BlacklistEntry {
  expiresAt: number
}

@Injectable()
export class TokenBlacklistService {
  private readonly blacklist = new Map<string, BlacklistEntry>()
  // Keys carry the company (`tenantKey`): user ids repeat across companies.
  private readonly TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes (access token lifetime)

  blacklistUser(userId: number): void {
    this.cleanup()
    this.blacklist.set(tenantKey(userId), {
      expiresAt: Date.now() + this.TOKEN_TTL_MS,
    })
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
