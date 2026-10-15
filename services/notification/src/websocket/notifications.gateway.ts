import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets'
import { Logger } from '@nestjs/common'
import { Server, Socket } from 'socket.io'
import * as jwt from 'jsonwebtoken'

interface JwtPayload {
  sub: number
  email: string
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
  private readonly clientUserMap = new Map<string, number>()

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

      void client.join(`user_${userId}`)
      this.clientUserMap.set(client.id, userId)
      this.logger.log(`WS connected: user ${userId}`)
    } catch (err) {
      this.logger.warn(`WS connection rejected: ${err instanceof Error ? err.message : String(err)}`)
      client.disconnect()
    }
  }

  handleDisconnect(client: Socket): void {
    const userId = this.clientUserMap.get(client.id)
    this.clientUserMap.delete(client.id)
    if (userId) {
      this.logger.log(`WS disconnected: user ${userId}`)
    }
  }

  sendToUser(userId: number, notification: NotificationPayload): void {
    this.server.to(`user_${userId}`).emit('notification:new', notification)
  }

  emitUnreadCount(
    userId: number,
    data: { count: number; bell_count: number; message_count: number },
  ): void {
    this.server.to(`user_${userId}`).emit('notification:count', data)
  }
}
