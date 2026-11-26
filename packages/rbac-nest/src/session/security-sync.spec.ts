import { SyncBus, sslOptionsFromUrl, syncBus } from '@trinity/prisma'
import { ActiveSessionService } from './active-session.service'
import { TokenBlacklistService } from './token-blacklist.service'

const other = new SyncBus('rust-x')
const wire = (k: string, extra: Record<string, unknown>) => JSON.stringify({ v: 1, o: other.origin, k, c: 1, ...extra })

describe('thứ tự tin token/session (G12b)', () => {
  it('tin unblock cũ hơn lần block đã áp không được ghi đè', () => {
    const bl = new TokenBlacklistService()
    const now = Date.now()
    syncBus.dispatch(wire('token', { op: 'block', u: 7, t: now }))
    syncBus.dispatch(wire('token', { op: 'unblock', u: 7, t: now - 1000 }))
    expect(bl.isBlacklisted(7)).toBe(true)
    syncBus.dispatch(wire('token', { op: 'unblock', u: 7, t: now + 1 }))
    expect(bl.isBlacklisted(7)).toBe(false)
    // block đến muộn nhưng cũ hơn dấu gỡ: không làm sống lại
    syncBus.dispatch(wire('token', { op: 'block', u: 7, t: now }))
    expect(bl.isBlacklisted(7)).toBe(false)
    bl.onModuleDestroy()
  })

  it('tin phiên cũ không ghi đè phiên mới hơn', () => {
    const s = new ActiveSessionService()
    const now = Date.now()
    syncBus.dispatch(wire('session', { op: 'start', u: 3, s: 'moi', t: now }))
    syncBus.dispatch(wire('session', { op: 'start', u: 3, s: 'cu', t: now - 500 }))
    expect(s.isCurrentSession(3, 'moi')).toBe(true)
    expect(s.isCurrentSession(3, 'cu')).toBe(false)
    syncBus.dispatch(wire('session', { op: 'clear', u: 3, t: now - 10 }))
    expect(s.isCurrentSession(3, 'cu')).toBe(false) // clear cũ hơn: bỏ qua
    s.onModuleDestroy()
  })

  it('tin thiếu t bị bỏ', () => {
    const bl = new TokenBlacklistService()
    syncBus.dispatch(wire('token', { op: 'block', u: 8 }))
    expect(bl.isBlacklisted(8)).toBe(false)
    bl.onModuleDestroy()
  })
})

describe('sslOptionsFromUrl', () => {
  it('không tham số SSL: không TLS', () => {
    expect(sslOptionsFromUrl('postgresql://u:p@h:5432/d?schema=public').ssl).toBe(false)
  })
  it('sslmode=require: TLS có kiểm chứng chỉ, bỏ tham số kiểu Prisma khỏi URL', () => {
    const r = sslOptionsFromUrl('postgresql://u:p@h/d?sslmode=require&connection_limit=5')
    expect(r.ssl).toEqual({ rejectUnauthorized: true })
    expect(r.connectionString).not.toMatch(/sslmode/)
  })
  it('sslaccept=accept_invalid_certs hoặc no-verify: không kiểm chứng chỉ', () => {
    expect(sslOptionsFromUrl('postgresql://u@h/d?sslmode=require&sslaccept=accept_invalid_certs').ssl).toEqual({ rejectUnauthorized: false })
    expect(sslOptionsFromUrl('postgresql://u@h/d?sslmode=no-verify').ssl).toEqual({ rejectUnauthorized: false })
  })
})
