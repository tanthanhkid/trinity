import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets'
import { Logger } from '@nestjs/common'
import { Server, Socket } from 'socket.io'
import * as jwt from 'jsonwebtoken'
import { currentCompanyId, isMultiTenant } from '@trinity/prisma'

interface JwtPayload {
  sub: number
  email: string
  /** Công ty của phiên (multi-tenant). Thiếu = công ty 1 (token cấp trước multi-tenant). */
  cid?: number
}

/**
 * Tên room của một user. User id TRÙNG giữa các công ty, nên room mang công ty: công ty 1 giữ tên cũ `user_<id>`,
 * công ty khác `c<cid>:user_<id>` — user 3 của công ty B không bao giờ nằm chung room với user 3 của công ty A.
 */
export function userRoom(companyId: number, userId: number): string {
  return companyId === 1 ? `user_${userId}` : `c${companyId}:user_${userId}`
}

interface NotificationPayload {
  id?: number
  title: string
  body: string
  channel: string
  event_type?: string
  action_url?: string | null
  is_read: boolean
  created_at: string
}

/**
 * Build socket.io cors origin from CORS_ORIGIN env var (danh sách phân tách bằng dấu phẩy;
 * mục dạng `*.example.com` cho mọi subdomain). localhost luôn được phép.
 * Chưa đặt CORS_ORIGIN → `false` (không thêm header CORS; dùng same-origin qua reverse proxy).
 */
function buildWsCorsOrigin(): ((origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void) | false {
  const envOrigin = process.env.CORS_ORIGIN
  if (!envOrigin) return false
  const entries = envOrigin.split(',').map((s) => s.trim()).filter(Boolean)
  return (origin, cb) => {
    if (!origin) return cb(null, true)
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true)
    const ok = entries.some((entry) => {
      if (entry === origin) return true
      const m = /^(https?:\/\/)?\*\.(.+)$/.exec(entry)
      if (!m) return false
      const host = m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`^https?:\\/\\/[a-z0-9-]+\\.${host}$`, 'i').test(origin)
    })
    cb(null, ok)
  }
}

@WebSocketGateway({
  // CORS theo danh sách `CORS_ORIGIN` (xem `buildWsCorsOrigin`).
  cors: { origin: buildWsCorsOrigin() },
  namespace: '/notifications/ws',
  path: '/notif-ws',
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationsGateway.name)
  private readonly clientUserMap = new Map<string, { userId: number; companyId: number }>()

  @WebSocketServer()
  server!: Server

  handleConnection(client: Socket): void {
    try {
      const token = client.handshake.auth?.['token'] as string | undefined
      if (!token) {
        this.logger.warn('WS connection rejected: no token')
        client.disconnect()
        return
      }

      const secret = process.env.JWT_SECRET
      if (!secret) throw new Error('JWT_SECRET not configured')
      const payload = jwt.verify(token, secret) as unknown as JwtPayload
      const userId = payload.sub
      const companyId = Number.isInteger(payload.cid) && (payload.cid as number) > 0 ? (payload.cid as number) : 1
      // Single-tenant: mọi phiên thuộc công ty 1 (room như cũ) dù token có mang cid.
      const cid = isMultiTenant() ? companyId : 1

      void client.join(userRoom(cid, userId))
      this.clientUserMap.set(client.id, { userId, companyId: cid })
      this.logger.log(`WS connected: user ${userId} (company ${cid})`)
    } catch (err) {
      this.logger.warn(`WS connection rejected: ${err instanceof Error ? err.message : String(err)}`)
      client.disconnect()
    }
  }

  handleDisconnect(client: Socket): void {
    const who = this.clientUserMap.get(client.id)
    this.clientUserMap.delete(client.id)
    if (who) {
      this.logger.log(`WS disconnected: user ${who.userId} (company ${who.companyId})`)
    }
  }

  /** Room của user trong công ty HIỆN TẠI; không có ngữ cảnh công ty ⇒ null (không phát, tránh gửi nhầm công ty). */
  private roomOf(userId: number): string | null {
    const companyId = currentCompanyId()
    if (companyId == null) {
      this.logger.warn(`WS emit bỏ qua: không có ngữ cảnh công ty (user ${userId})`)
      return null
    }
    return userRoom(companyId, userId)
  }

  sendToUser(userId: number, notification: NotificationPayload): void {
    const room = this.roomOf(userId)
    if (room) this.server.to(room).emit('notification:new', notification)
  }

  emitUnreadCount(
    userId: number,
    data: { count: number; bell_count: number; message_count: number },
  ): void {
    const room = this.roomOf(userId)
    if (room) this.server.to(room).emit('notification:count', data)
  }
}
