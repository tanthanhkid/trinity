import { TokenBlacklistService } from './token-blacklist.service'

describe('TokenBlacklistService', () => {
  let service: TokenBlacklistService

  beforeEach(() => {
    service = new TokenBlacklistService()
  })

  it('blacklistUser đánh dấu user blacklist', () => {
    service.blacklistUser(42)
    expect(service.isBlacklisted(42)).toBe(true)
  })

  it('isBlacklisted trả false cho user chưa từng blacklist', () => {
    expect(service.isBlacklisted(99)).toBe(false)
  })

  it('removeUser xoá user khỏi blacklist', () => {
    service.blacklistUser(42)
    expect(service.isBlacklisted(42)).toBe(true)
    service.removeUser(42)
    expect(service.isBlacklisted(42)).toBe(false)
  })

  it('removeUser không throw khi user chưa từng blacklist', () => {
    expect(() => service.removeUser(123)).not.toThrow()
  })

  it('clear xoá toàn bộ blacklist', () => {
    service.blacklistUser(1)
    service.blacklistUser(2)
    service.clear()
    expect(service.isBlacklisted(1)).toBe(false)
    expect(service.isBlacklisted(2)).toBe(false)
  })
})
