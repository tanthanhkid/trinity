import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { PublicApiService } from '../public-api/public-api.service';
import { normalizeVnPhone } from '../integrations/webhooks/inbound/inbound-payload';
import { phoneVariants } from '../google/sheet-mapping';

/** Khách từ phần mềm bán hàng, đã chuẩn hoá. */
export interface ExternalCustomer {
  external_id: string;
  code?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  updated_at?: Date | null;
  data?: Record<string, unknown>;
}

/** Đơn / hoá đơn từ phần mềm bán hàng, đã chuẩn hoá. */
export interface ExternalOrder {
  kind: 'order' | 'invoice';
  external_id: string;
  code?: string | null;
  total: number;
  status?: string | null;
  customer?: { external_id?: string | null; name?: string | null; phone?: string | null } | null;
  items?: Array<{ name: string; quantity: number; price: number }>;
  updated_at?: Date | null;
  data?: Record<string, unknown>;
}

export interface ExternalProduct {
  external_id: string;
  code?: string | null;
  name: string;
  price?: number | null;
  updated_at?: Date | null;
  data?: Record<string, unknown>;
}

export interface SyncOwner {
  id: number;
  team_id: number | null;
}

const vnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;

/**
 * Ghi dữ liệu từ phần mềm bán hàng / sàn vào CRM — dùng chung cho mọi connector (KiotViet, Sapo, WooCommerce…):
 * - bản ghi gốc vào `connector_records` (một dòng mỗi khách/đơn/hàng, cập nhật khi đổi);
 * - khách có SĐT ⇒ ghép khách CRM cùng SĐT, chưa có thì tạo mới (người nối connector phụ trách);
 * - đơn/hoá đơn MỚI của khách đã ghép ⇒ ghi một dòng vào lịch sử khách.
 */
@Injectable()
export class CommerceSyncService {
  private readonly logger = new Logger(CommerceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicApi: PublicApiService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * Phạm vi xem bản ghi bán hàng theo quyền deal của người gọi: bản ghi đã ghép khách ⇒ theo người phụ trách khách;
   * chưa ghép khách (khách lẻ, hàng hoá) ⇒ chỉ phạm vi "tất cả" mới thấy.
   */
  async scopeWhere(user: AuthUser): Promise<Prisma.ConnectorRecordWhereInput> {
    const ids = await this.scope.ownerIds(user, 'deals.view');
    if (ids === 'all') return {};
    const contacts = await this.prisma.contact.findMany({ where: { assigned_to: { in: ids ?? [] }, deleted_at: null }, select: { id: true }, take: 50_000 });
    return { contact_id: { in: contacts.map((c) => c.id) } };
  }

  /** Khách CRM theo SĐT (tạo nếu chưa có). Không có SĐT hợp lệ ⇒ null (chỉ lưu bản ghi gốc). */
  async contactFor(provider: string, c: { name?: string | null; phone?: string | null; email?: string | null }, owner: SyncOwner): Promise<number | null> {
    const phone = c.phone ? normalizeVnPhone(c.phone) : null;
    if (!phone) return null;
    return this.prisma.$transaction(async (tx) => {
      // Cùng khoá với ContactsService.create / webhook vào ⇒ tạo tay và đồng bộ cùng SĐT chạy tuần tự.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phone}))`;
      const dup = await tx.contact.findFirst({ where: { phone: { in: phoneVariants(phone) }, deleted_at: null }, orderBy: { id: 'asc' }, select: { id: true } });
      if (dup) return dup.id;
      const created = await this.publicApi.createContactInTx(
        tx,
        { phone, full_name: c.name?.trim().slice(0, 255) || null, email: c.email?.trim().slice(0, 255) || null },
        owner,
        `connector:${provider}`,
      );
      await tx.activity.create({
        data: { contact_id: created.id, action: 'note', details: { description: `Tạo từ ${label(provider)}`, source: `connector:${provider}` }, created_by: null },
      });
      return created.id;
    });
  }

  async upsertCustomer(provider: string, account: string, c: ExternalCustomer, owner: SyncOwner): Promise<{ contact_id: number | null }> {
    const contact_id = await this.contactFor(provider, c, owner);
    await this.upsert(provider, account, 'customer', c.external_id, {
      code: c.code ?? null, name: c.name ?? null, contact_id, amount: null, status: null,
      data: c.data ?? {}, external_updated_at: c.updated_at ?? null,
    });
    return { contact_id };
  }

  async upsertOrder(provider: string, account: string, o: ExternalOrder, owner: SyncOwner): Promise<{ contact_id: number | null; created: boolean }> {
    let contact_id: number | null = null;
    if (o.customer?.external_id) {
      const known = await this.prisma.connectorRecord.findUnique({
        where: { provider_account_kind_external_id: { provider, account, kind: 'customer', external_id: o.customer.external_id } },
        select: { contact_id: true },
      });
      contact_id = known?.contact_id ?? null;
    }
    if (!contact_id && o.customer?.phone) contact_id = await this.contactFor(provider, o.customer, owner);
    const created = await this.upsert(provider, account, o.kind, o.external_id, {
      code: o.code ?? null, name: o.customer?.name ?? null, contact_id, amount: BigInt(Math.round(o.total || 0)), status: o.status ?? null,
      data: { ...(o.data ?? {}), items: o.items ?? [] }, external_updated_at: o.updated_at ?? null,
    });
    if (created && contact_id) {
      const what = o.kind === 'invoice' ? 'Hoá đơn' : 'Đơn hàng';
      const items = (o.items ?? []).slice(0, 3).map((i) => `${i.name} ×${i.quantity}`).join(', ');
      await this.prisma.activity
        .create({
          data: {
            contact_id,
            action: 'note',
            details: { description: `${what} ${label(provider)} ${o.code ?? o.external_id} — ${vnd(o.total)}${items ? ` (${items}${(o.items?.length ?? 0) > 3 ? '…' : ''})` : ''}`, source: `connector:${provider}` },
            metadata: { provider, kind: o.kind, external_id: o.external_id },
            created_by: null,
          },
        })
        .catch((e) => this.logger.warn(`Ghi lịch sử đơn lỗi: ${(e as Error).message}`));
    }
    return { contact_id, created };
  }

  async upsertProduct(provider: string, account: string, p: ExternalProduct): Promise<void> {
    await this.upsert(provider, account, 'product', p.external_id, {
      code: p.code ?? null, name: p.name, contact_id: null, amount: p.price == null ? null : BigInt(Math.round(p.price)), status: null,
      data: p.data ?? {}, external_updated_at: p.updated_at ?? null,
    });
  }

  /** Xoá phía nguồn ⇒ đánh dấu, không xoá dữ liệu CRM. */
  async markRemoved(provider: string, account: string, kind: string, externalId: string): Promise<void> {
    await this.prisma.connectorRecord.updateMany({ where: { provider, account, kind, external_id: externalId }, data: { status: 'removed' } });
  }

  /** true = bản ghi mới. */
  private async upsert(
    provider: string, account: string, kind: string, external_id: string,
    v: { code: string | null; name: string | null; contact_id: number | null; amount: bigint | null; status: string | null; data: Record<string, unknown>; external_updated_at: Date | null },
  ): Promise<boolean> {
    const data = {
      code: v.code?.slice(0, 64) ?? null,
      name: v.name?.slice(0, 255) ?? null,
      amount: v.amount,
      status: v.status?.slice(0, 40) ?? null,
      data: v.data as Prisma.InputJsonObject,
      external_updated_at: v.external_updated_at,
    };
    try {
      await this.prisma.connectorRecord.create({ data: { provider, account: account.slice(0, 80), kind, external_id: external_id.slice(0, 64), contact_id: v.contact_id, ...data } });
      return true;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      await this.prisma.connectorRecord.update({
        where: { provider_account_kind_external_id: { provider, account: account.slice(0, 80), kind, external_id: external_id.slice(0, 64) } },
        // Ghép khách chỉ thêm, không gỡ (đơn đã ghép giữ nguyên khi nguồn gửi lại thiếu khách).
        data: { ...data, ...(v.contact_id ? { contact_id: v.contact_id } : {}) },
      });
      return false;
    }
  }
}

export function label(provider: string): string {
  return ({ kiotviet: 'KiotViet', sapo: 'Sapo', woocommerce: 'WooCommerce', ipos: 'iPOS', shopee: 'Shopee', lazada: 'Lazada' } as Record<string, string>)[provider] ?? provider;
}
