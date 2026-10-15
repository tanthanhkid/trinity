import { describe, it, expect } from 'vitest'
import { decodeJwtExpMs } from '@/lib/jwt-exp'

function makeToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`
}

describe('decodeJwtExpMs', () => {
  it('trả exp (ms) từ JWT hợp lệ', () => {
    const expSec = 1_700_000_000
    expect(decodeJwtExpMs(makeToken({ sub: 1, exp: expSec }))).toBe(
      expSec * 1000,
    )
  })

  it('null khi token null hoặc rỗng', () => {
    expect(decodeJwtExpMs(null)).toBeNull()
    expect(decodeJwtExpMs('')).toBeNull()
  })

  it('null khi token không đủ 3 phần', () => {
    expect(decodeJwtExpMs('a.b')).toBeNull()
    expect(decodeJwtExpMs('onlyonepart')).toBeNull()
  })

  it('null khi payload không có exp', () => {
    expect(decodeJwtExpMs(makeToken({ sub: 1 }))).toBeNull()
  })

  it('null khi exp không phải số', () => {
    expect(decodeJwtExpMs(makeToken({ sub: 1, exp: 'soon' }))).toBeNull()
  })

  it('null khi payload không decode được (base64 hỏng)', () => {
    expect(decodeJwtExpMs('aaa.@@@notbase64@@@.sig')).toBeNull()
  })
})
