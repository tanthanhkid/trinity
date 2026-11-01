/**
 * Multi-tenant: user 3 của công ty 5 và user 3 của công ty 1 không bao giờ chung room, và cache số chưa đọc không lẫn.
 */
import { Server, Socket } from 'socket.io'
import * as jwt from 'jsonwebtoken'
import { companyRef, runWithCompany } from '@trinity/prisma'
import { NotificationsGateway, userRoom } from '../notifications.gateway'
import { NotificationsService } from '../../notifications/notifications.service'

const SECRET = 'ws-tenant-test-secret'
const OLD_SECRET = process.env.JWT_SECRET
const OLD_MT = process.env.MULTI_TENANT
beforeAll(() => {
  process.env.JWT_SECRET = SECRET
  process.env.MULTI_TENANT = 'true'
})
afterAll(() => {
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = OLD_SECRET
  if (OLD_MT === undefined) delete process.env.MULTI_TENANT
  else process.env.MULTI_TENANT = OLD_MT
})

function client(token: string): Socket & { join: jest.Mock; disconnect: jest.Mock } {
  return { id: Math.random().toString(36), handshake: { auth: { token } }, join: jest.fn(), disconnect: jest.fn() } as never
}

describe('NotificationsGateway — room theo công ty', () => {
  let gateway: NotificationsGateway
  let emits: Array<{ room: string; event: string }>

  beforeEach(() => {
    gateway = new NotificationsGateway()
    emits = []
    gateway.server = {
      to: jest.fn((room: string) => ({ emit: (event: string) => emits.push({ room, event }) })),
    } as unknown as Server
  })

  it('handshake: cid 5 ⇒ room c5:user_3; thiếu cid ⇒ room cũ user_3 (công ty 1)', () => {
    const b = client(jwt.sign({ sub: 3, email: 'b@x.vn', cid: 5 }, SECRET))
    const a = client(jwt.sign({ sub: 3, email: 'a@x.vn' }, SECRET))
    gateway.handleConnection(b)
    gateway.handleConnection(a)
    expect(b.join).toHaveBeenCalledWith('c5:user_3')
    expect(a.join).toHaveBeenCalledWith('user_3')
    expect(userRoom(5, 3)).not.toBe(userRoom(1, 3))
  })

  it('phát cho user 3 trong công ty 1 không tới room user 3 của công ty 5 (và ngược lại)', () => {
    const n = { title: 't', body: 'b', channel: 'in_app', is_read: false, created_at: '' }
    runWithCompany(companyRef(1), () => gateway.sendToUser(3, n))
    runWithCompany(companyRef(5), () => gateway.emitUnreadCount(3, { count: 1, bell_count: 1, message_count: 0 }))
    expect(emits).toEqual([
      { room: 'user_3', event: 'notification:new' },
      { room: 'c5:user_3', event: 'notification:count' },
    ])
  })

  it('không có ngữ cảnh công ty ⇒ không phát gì', () => {
    gateway.sendToUser(3, { title: 't', body: 'b', channel: 'in_app', is_read: false, created_at: '' })
    expect(emits).toEqual([])
  })
})

describe('NotificationsService — cache số chưa đọc theo công ty', () => {
  it('user 3 công ty 1 và user 3 công ty 5 không dùng chung cache', async () => {
    let counting = 0
    const prisma = { notificationLog: { count: jest.fn(async () => (counting += 1) * 10) } }
    const svc = new NotificationsService(prisma as never, {} as never, {} as never)
    const a = await runWithCompany(companyRef(1), () => svc.getUnreadCount(3))
    const b = await runWithCompany(companyRef(5), () => svc.getUnreadCount(3))
    const a2 = await runWithCompany(companyRef(1), () => svc.getUnreadCount(3))
    expect(a).toEqual({ count: 10 })
    expect(b).toEqual({ count: 20 }) // không nhận cache của công ty 1
    expect(a2).toEqual({ count: 10 }) // cache của công ty 1 vẫn đúng
    expect(prisma.notificationLog.count).toHaveBeenCalledTimes(2)

    // Huỷ cache của user 3 công ty 5 không đụng cache công ty 1.
    runWithCompany(companyRef(5), () => svc.invalidateUnreadCache(3))
    expect(await runWithCompany(companyRef(1), () => svc.getUnreadCount(3))).toEqual({ count: 10 })
  })
})
