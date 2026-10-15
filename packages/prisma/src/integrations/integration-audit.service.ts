import { Injectable, Logger } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma.service'
import { MAX_ERROR, sanitizeMetadata, sanitizeText } from './audit-sanitize'

export type IntegrationChannel = 'mcp' | 'webhook_out' | 'webhook_in'
export type IntegrationAuditStatus = 'ok' | 'denied' | 'error'
export const INTEGRATION_CHANNELS: readonly IntegrationChannel[] = ['mcp', 'webhook_out', 'webhook_in']
export const INTEGRATION_AUDIT_STATUSES: readonly IntegrationAuditStatus[] = ['ok', 'denied', 'error']

export interface IntegrationAuditEntry {
  channel: IntegrationChannel
  /** Tên tool / sự kiện / hành động. */
  action: string
  status: IntegrationAuditStatus
  clientId?: string | null
  userId?: number | null
  resource?: string | null
  resourceId?: string | number | null
  httpStatus?: number | null
  durationMs?: number | null
  error?: string | null
  /** Sẽ bị lọc: bỏ secret/token, che SĐT, cắt độ dài. */
  metadata?: Record<string, unknown>
}

export interface IntegrationAuditQuery {
  channel?: IntegrationChannel
  status?: IntegrationAuditStatus
  userId?: number
  from?: Date
  to?: Date
  cursor?: string
  limit?: number
}

export interface IntegrationAuditRow {
  id: string
  created_at: Date
  channel: string
  client_id: string | null
  user_id: number | null
  action: string
  resource: string | null
  resource_id: string | null
  status: string
  http_status: number | null
  duration_ms: number | null
  error: string | null
  metadata: Prisma.JsonValue
}

const cut = (v: string | null | undefined, max: number): string | null => (v == null || v === '' ? null : v.slice(0, max))
const clampInt = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.max(0, Math.min(Math.trunc(v), 2_147_483_647))

/** Cursor `"<epochMs>.<id>"` — created_at có độ chính xác ms nên khớp tuyệt đối với cột `timestamptz(3)`. */
export function encodeAuditCursor(createdAt: Date, id: bigint): string {
  return `${createdAt.getTime()}.${id.toString()}`
}
export function decodeAuditCursor(cursor: string): { createdAt: Date; id: bigint } | null {
  const m = /^(\d{1,15})\.(\d{1,19})$/.exec(cursor)
  return m ? { createdAt: new Date(Number(m[1])), id: BigInt(m[2]) } : null
}

@Injectable()
export class IntegrationAuditService {
  private readonly logger = new Logger(IntegrationAuditService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ghi nhật ký. 🔴 KHÔNG BAO GIỜ ném lỗi ra caller: nhật ký hỏng không được làm hỏng lời gọi MCP/webhook.
   * Lỗi chỉ ghi log máy chủ (không kèm payload).
   */
  async log(entry: IntegrationAuditEntry): Promise<void> {
    try {
      await this.prisma.integrationAuditLog.create({
        data: {
          channel: entry.channel,
          client_id: cut(entry.clientId, 255),
          user_id: entry.userId ?? null,
          action: entry.action.slice(0, 128),
          resource: cut(entry.resource, 64),
          resource_id: entry.resourceId == null ? null : String(entry.resourceId).slice(0, 64),
          status: entry.status,
          http_status: clampInt(entry.httpStatus),
          duration_ms: clampInt(entry.durationMs),
          error: entry.error ? sanitizeText(entry.error, MAX_ERROR) : null,
          metadata: sanitizeMetadata(entry.metadata),
        },
        select: { id: true },
      })
    } catch (err) {
      this.logger.warn(`integration audit log failed (${entry.channel}/${entry.action}): ${(err as Error)?.message}`)
    }
  }

  /** Danh sách mới → cũ, phân trang cursor. `next_cursor` null khi hết. */
  async list(q: IntegrationAuditQuery): Promise<{ data: IntegrationAuditRow[]; next_cursor: string | null }> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100)
    const and: Prisma.IntegrationAuditLogWhereInput[] = []
    if (q.channel) and.push({ channel: q.channel })
    if (q.status) and.push({ status: q.status })
    if (q.userId !== undefined) and.push({ user_id: q.userId })
    if (q.from) and.push({ created_at: { gte: q.from } })
    if (q.to) and.push({ created_at: { lte: q.to } })
    const cur = q.cursor ? decodeAuditCursor(q.cursor) : null
    if (cur) and.push({ OR: [{ created_at: { lt: cur.createdAt } }, { created_at: cur.createdAt, id: { lt: cur.id } }] })

    const rows = await this.prisma.integrationAuditLog.findMany({
      where: { AND: and },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return {
      data: page.map((r) => ({ ...r, id: r.id.toString() })),
      next_cursor: rows.length > limit && last ? encodeAuditCursor(last.created_at, last.id) : null,
    }
  }
}
