import type { PrismaService } from '@trinity/prisma';
import { newPaymentCode } from '../payments.service';

/**
 * Dựng một yêu cầu thanh toán "đang chờ" như bản cũ từng tạo — Trinity đã ngừng tạo yêu cầu mới (G07a, #105) nên test
 * đối soát (webhook SePay, IPN) tự chèn dòng.
 */
export async function seedPendingPayment(
  db: PrismaService,
  input: { amount: number; description?: string; source_type?: string; source_id?: number; expires_at?: Date; prefix?: string },
): Promise<{ id: number; code: string }> {
  const row = await db.paymentIntent.create({
    data: {
      code: newPaymentCode(input.prefix),
      amount: BigInt(input.amount),
      description: input.description ?? null,
      source_type: input.source_type ?? 'manual',
      source_id: input.source_id ?? null,
      expires_at: input.expires_at ?? null,
    },
  });
  return { id: row.id, code: row.code };
}
