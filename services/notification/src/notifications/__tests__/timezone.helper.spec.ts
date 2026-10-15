import { isBusinessHours, getNextBusinessStart, getVietnamTime } from '../helpers/timezone.helper'

describe('timezone.helper', () => {
  describe('getVietnamTime', () => {
    it('should add 7 hours to UTC time', () => {
      const utc = new Date('2026-03-30T01:00:00Z') // 01:00 UTC = 08:00 VN
      const vn = getVietnamTime(utc)
      expect(vn.getUTCHours()).toBe(8)
    })
  })

  describe('isBusinessHours', () => {
    it('should return true at 10:00 VN (03:00 UTC)', () => {
      const date = new Date('2026-03-30T03:00:00Z') // 10:00 VN
      expect(isBusinessHours(date)).toBe(true)
    })

    it('should return true at 08:00 VN (01:00 UTC)', () => {
      const date = new Date('2026-03-30T01:00:00Z') // 08:00 VN
      expect(isBusinessHours(date)).toBe(true)
    })

    it('should return false at 07:59 VN (00:59 UTC)', () => {
      const date = new Date('2026-03-30T00:59:00Z') // 07:59 VN
      expect(isBusinessHours(date)).toBe(false)
    })

    it('should return false at 18:00 VN (11:00 UTC)', () => {
      const date = new Date('2026-03-30T11:00:00Z') // 18:00 VN
      expect(isBusinessHours(date)).toBe(false)
    })

    it('should return true at 17:59 VN (10:59 UTC)', () => {
      const date = new Date('2026-03-30T10:59:00Z') // 17:59 VN
      expect(isBusinessHours(date)).toBe(true)
    })

    it('should return false at 22:00 VN (15:00 UTC)', () => {
      const date = new Date('2026-03-30T15:00:00Z') // 22:00 VN
      expect(isBusinessHours(date)).toBe(false)
    })
  })

  describe('getNextBusinessStart', () => {
    it('should return today 08:00 VN if before 08:00 VN', () => {
      const date = new Date('2026-03-30T00:00:00Z') // 07:00 VN
      const next = getNextBusinessStart(date)
      // Expected: 2026-03-30T01:00:00Z (08:00 VN)
      expect(next.getUTCHours()).toBe(1)
      expect(next.getUTCDate()).toBe(30)
    })

    it('should return tomorrow 08:00 VN if after 08:00 VN', () => {
      const date = new Date('2026-03-30T05:00:00Z') // 12:00 VN
      const next = getNextBusinessStart(date)
      // Expected: 2026-03-31T01:00:00Z (08:00 VN tomorrow)
      expect(next.getUTCHours()).toBe(1)
      expect(next.getUTCDate()).toBe(31)
    })

    it('should return tomorrow 08:00 VN if at 20:00 VN', () => {
      const date = new Date('2026-03-30T13:00:00Z') // 20:00 VN
      const next = getNextBusinessStart(date)
      expect(next.getUTCHours()).toBe(1)
      expect(next.getUTCDate()).toBe(31)
    })
  })
})
