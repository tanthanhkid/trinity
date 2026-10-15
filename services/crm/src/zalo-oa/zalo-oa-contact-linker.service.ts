import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { PublicApiService } from '../public-api/public-api.service';
import { toLocalPhone, toZaloPhone } from './zalo-oa.config';

/**
 * Ghép hội thoại OA với khách CRM: (1) `contacts.zalo_account` = user_id Zalo; (2) trùng SĐT (0…, 84…, +84…);
 * (3) có SĐT mà chưa có khách ⇒ TẠO khách mới giao cho người đã kết nối OA (qua lõi tạo khách chung, phát `contact.created`).
 * Không có SĐT ⇒ KHÔNG tạo (Contact.phone bắt buộc) — hội thoại để trống `contact_id`, gán tay bằng API `link`.
 */
@Injectable()
export class ZaloOaContactLinker {
  private readonly logger = new Logger(ZaloOaContactLinker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicApi: PublicApiService,
  ) {}

  phoneVariants(zaloPhone: string): string[] {
    const local = toLocalPhone(zaloPhone);
    return [local, `84${local.slice(1)}`, `+84${local.slice(1)}`];
  }

  async find(zaloUserId: string, phone: string | null): Promise<number | null> {
    const byAccount = await this.prisma.contact.findFirst({ where: { zalo_account: zaloUserId, deleted_at: null }, orderBy: { id: 'asc' }, select: { id: true } });
    if (byAccount) return byAccount.id;
    const z = phone ? toZaloPhone(phone) : null;
    if (!z) return null;
    const byPhone = await this.prisma.contact.findFirst({ where: { phone: { in: this.phoneVariants(z) }, deleted_at: null }, orderBy: { id: 'asc' }, select: { id: true } });
    return byPhone?.id ?? null;
  }

  /** Tìm, không có thì tạo (cần SĐT hợp lệ). Trả id khách hoặc null. */
  async findOrCreate(p: { zaloUserId: string; phone: string | null; name: string | null; ownerUserId: number }): Promise<number | null> {
    const found = await this.find(p.zaloUserId, p.phone);
    if (found) return found;
    const z = p.phone ? toZaloPhone(p.phone) : null;
    if (!z) return null;
    const owner = await this.prisma.user.findUnique({ where: { id: p.ownerUserId }, select: { id: true, status: true, team_id: true, deleted_at: true } });
    if (!owner || owner.status !== 'active' || owner.deleted_at !== null) {
      this.logger.warn(`Không tạo khách từ Zalo OA: người phụ trách ${p.ownerUserId} không còn hoạt động`);
      return null;
    }
    const local = toLocalPhone(z);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${local}))`;
      const dup = await tx.contact.findFirst({ where: { phone: { in: this.phoneVariants(z) }, deleted_at: null }, select: { id: true } });
      if (dup) return dup.id;
      const created = await this.publicApi.createContactInTx(
        tx,
        { phone: local, full_name: p.name, zalo_account: p.zaloUserId },
        { id: owner.id, team_id: owner.team_id },
        'zalo_oa',
      );
      return created.id;
    });
  }

  assignedTo(contactId: number | null): Promise<number | null> {
    if (contactId === null) return Promise.resolve(null);
    return this.prisma.contact.findUnique({ where: { id: contactId }, select: { assigned_to: true } }).then((c) => c?.assigned_to ?? null);
  }
}
