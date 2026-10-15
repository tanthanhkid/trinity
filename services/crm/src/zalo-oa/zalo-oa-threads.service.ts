import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, publishIntegrationEvent } from '@trinity/prisma';
import type { Prisma, ZaloOaMessage, ZaloOaThread } from '@prisma/client';
import { ZaloOaContactLinker } from './zalo-oa-contact-linker.service';
import { toZaloPhone } from './zalo-oa.config';

export interface RecordMessage {
  threadId: number;
  direction: 'in' | 'out';
  kind: 'text' | 'attachment' | 'zns';
  msgId: string | null;
  text: string | null;
  payload?: Prisma.InputJsonValue;
  status: 'received' | 'sent' | 'failed';
  error?: string | null;
  sentBy?: number | null;
  at?: Date;
}

const PREVIEW_MAX = 200;
const preview = (m: RecordMessage): string => (m.text ?? (m.kind === 'zns' ? '[Tin ZNS]' : '[Tệp đính kèm]')).slice(0, PREVIEW_MAX);

/** Hội thoại + tin nhắn OA. Ghi tin = 1 transaction (tin + cập nhật hội thoại + outbox) và khử trùng theo `msg_id`. */
@Injectable()
export class ZaloOaThreadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly linker: ZaloOaContactLinker,
  ) {}

  upsertThread(oaId: string, zaloUserId: string): Promise<ZaloOaThread> {
    return this.prisma.zaloOaThread.upsert({
      where: { oa_id_zalo_user_id: { oa_id: oaId, zalo_user_id: zaloUserId } },
      create: { oa_id: oaId, zalo_user_id: zaloUserId },
      update: {},
    });
  }

  async get(id: number): Promise<ZaloOaThread> {
    const t = await this.prisma.zaloOaThread.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Không có hội thoại này');
    return t;
  }

  async updateProfile(id: number, p: { name: string | null; avatar: string | null; phone: string | null }, contactId: number | null): Promise<void> {
    await this.prisma.zaloOaThread.update({
      where: { id },
      data: { display_name: p.name ?? undefined, avatar_url: p.avatar ?? undefined, phone: p.phone ?? undefined, contact_id: contactId ?? undefined },
    });
  }

  /** Trả `null` nếu tin đã có (webhook gửi lại) — KHÔNG phát sự kiện lần hai. */
  async record(m: RecordMessage): Promise<ZaloOaMessage | null> {
    const at = m.at ?? new Date();
    const thread = await this.get(m.threadId);
    const assignedTo = await this.linker.assignedTo(thread.contact_id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.zaloOaMessage.create({
          data: {
            thread_id: m.threadId, direction: m.direction, kind: m.kind, msg_id: m.msgId, text: m.text,
            payload: m.payload ?? {}, status: m.status, error: m.error ?? null, sent_by: m.sentBy ?? null, created_at: at,
          },
        });
        if (m.status !== 'failed') {
          const inbound = m.direction === 'in';
          await tx.zaloOaThread.update({
            where: { id: m.threadId },
            data: {
              last_message_preview: preview(m),
              last_message_at: at,
              ...(inbound ? { last_inbound_at: at, unread_count: { increment: 1 } } : {}),
            },
          });
          await publishIntegrationEvent(
            tx,
            inbound ? 'zalo_oa.message_received' : 'zalo_oa.message_sent',
            { thread_id: m.threadId, contact_id: thread.contact_id, contact_assigned_to: assignedTo, kind: m.kind },
            { resourceId: m.threadId, actorUserId: m.sentBy ?? null },
          );
        }
        return row;
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return null;
      throw err;
    }
  }

  async list(opts: { limit: number; cursor?: number; q?: string }) {
    const where: Prisma.ZaloOaThreadWhereInput = opts.q
      ? { OR: [{ display_name: { contains: opts.q, mode: 'insensitive' } }, { phone: { contains: opts.q } }] }
      : {};
    const rows = await this.prisma.zaloOaThread.findMany({
      where,
      orderBy: [{ last_message_at: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.limit;
    const data = hasMore ? rows.slice(0, opts.limit) : rows;
    return { data, meta: { next_cursor: hasMore ? data[data.length - 1].id : null } };
  }

  async messages(threadId: number, opts: { limit: number; before?: bigint }) {
    await this.get(threadId);
    const rows = await this.prisma.zaloOaMessage.findMany({
      where: { thread_id: threadId, ...(opts.before ? { id: { lt: opts.before } } : {}) },
      orderBy: { id: 'desc' },
      take: opts.limit,
    });
    return rows.map((r) => ({ ...r, id: r.id.toString() }));
  }

  async markRead(id: number): Promise<void> {
    await this.get(id);
    await this.prisma.zaloOaThread.update({ where: { id }, data: { unread_count: 0 } });
  }

  /** Gán tay hội thoại ↔ khách: theo `contact_id` có sẵn, hoặc theo SĐT (tìm/tạo). */
  async link(id: number, p: { contactId?: number; phone?: string }, ownerUserId: number): Promise<ZaloOaThread> {
    const t = await this.get(id);
    let contactId: number | null = null;
    if (p.contactId) {
      const c = await this.prisma.contact.findFirst({ where: { id: p.contactId, deleted_at: null }, select: { id: true } });
      if (!c) throw new NotFoundException('Không có khách này');
      contactId = c.id;
    } else if (p.phone) {
      contactId = await this.linker.findOrCreate({ zaloUserId: t.zalo_user_id, phone: p.phone, name: t.display_name, ownerUserId });
    }
    if (contactId === null) throw new NotFoundException('Không tìm/tạo được khách (SĐT không hợp lệ?)');
    return this.prisma.zaloOaThread.update({ where: { id }, data: { contact_id: contactId, phone: (p.phone ? toZaloPhone(p.phone) : null) ?? t.phone } });
  }
}
