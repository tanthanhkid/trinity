import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Prisma } from '@prisma/client';
import type { QueryWebhookDeliveriesDto } from './dto/query-deliveries.dto';

const encode = (d: Date, id: string): string => `${d.getTime()}.${id}`;
function decode(c: string): { at: Date; id: string } | null {
  const m = /^(\d{1,15})\.([0-9a-f-]{36})$/.exec(c);
  return m ? { at: new Date(Number(m[1])), id: m[2] } : null;
}

/** Nhật ký gửi. 🔴 KHÔNG trả `payload` (chứa dữ liệu khách theo quyền của CHỦ THỂ, người xem có thể thấp quyền hơn). */
@Injectable()
export class WebhookDeliveriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: QueryWebhookDeliveriesDto) {
    const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
    const and: Prisma.WebhookDeliveryWhereInput[] = [];
    if (q.endpoint_id !== undefined) and.push({ endpoint_id: q.endpoint_id });
    if (q.status) and.push({ status: q.status });
    if (q.event_type) and.push({ event_type: q.event_type });
    const cur = q.cursor ? decode(q.cursor) : null;
    if (cur) and.push({ OR: [{ created_at: { lt: cur.at } }, { created_at: cur.at, id: { lt: cur.id } }] });
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { AND: and },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true, endpoint_id: true, event_id: true, event_type: true, status: true, attempts: true,
        next_attempt_at: true, last_status_code: true, last_error: true, created_at: true, delivered_at: true,
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r) => ({ ...r, event_id: r.event_id === null ? null : r.event_id.toString() })),
      next_cursor: rows.length > limit && last ? encode(last.created_at, last.id) : null,
    };
  }
}
