import { publishIntegrationEvent, type MessengerEventRef } from '@trinity/prisma';
import type { Prisma } from '@prisma/client';

type Client = Pick<Prisma.TransactionClient, 'integrationEvent' | 'contact'>;

/**
 * Phát sự kiện webhook ra ngoài cho một tin Messenger vừa lưu (gọi đúng chỗ `facebookMessage.create` thành công — `mid` duy nhất
 * nên mỗi tin chỉ một sự kiện, kể cả khi echo của Meta tới sau). Chỉ định danh, không nội dung (như Zalo OA).
 */
export async function publishMessengerEvent(
  client: Client,
  conv: { id: number; page_id: string; contact_id: number | null },
  direction: 'in' | 'out',
  origin: MessengerEventRef['origin'],
  actorUserId: number | null = null,
): Promise<void> {
  const contact = conv.contact_id ? await client.contact.findUnique({ where: { id: conv.contact_id }, select: { assigned_to: true } }) : null;
  await publishIntegrationEvent(
    client,
    direction === 'in' ? 'messenger.message_received' : 'messenger.message_sent',
    { conversation_id: conv.id, page_id: conv.page_id, contact_id: conv.contact_id, contact_assigned_to: contact?.assigned_to ?? null, origin },
    { resourceId: conv.id, actorUserId },
  );
}
