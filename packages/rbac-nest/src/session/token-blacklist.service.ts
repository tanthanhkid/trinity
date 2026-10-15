import { Injectable } from '@nestjs/common'

interface BlacklistEntry {
  expiresAt: number
}

@Injectable()
export class TokenBlacklistService {
  private readonly blacklist = new Map<number, BlacklistEntry>()
  private readonly TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes (access token lifetime)

  blacklistUser(userId: number): void {
    this.cleanup()
    this.blacklist.set(userId, {
      expiresAt: Date.now() + this.TOKEN_TTL_MS,
    })
  }

  isBlacklisted(userId: number): boolean {
    this.cleanup()
    const entry = this.blacklist.get(userId)
    if (!entry) return false
    if (Date.now() > entry.expiresAt) {
      this.blacklist.delete(userId)
      return false
    }
    return true
  }

  removeUser(userId: number): void {
    this.blacklist.delete(userId)
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
