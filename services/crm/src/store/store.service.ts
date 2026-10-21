import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService, publishIntegrationEvent } from '@trinity/prisma';
import { ScopeService, assertInScope, makePhoneMasker, type AuthUser } from '@trinity/rbac-nest';
import { randomInt } from 'node:crypto';
import { FixedWindowLimiter } from '../common/helpers/fixed-window-limiter';
import { normalizeVnPhone } from '../integrations/webhooks/inbound/inbound-payload';
import { OrgFeaturesService } from '../settings/org-features.service';
import { CommerceSyncService } from '../connectors/commerce-sync.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { PaymentsService } from '../connectors/payments.service';

export const STORE_SETTING_KEY = 'online_store';
export const STORE_THEMES = ['toi-gian', 'am-ap', 'soi-dong'] as const;
export type StoreTheme = (typeof STORE_THEMES)[number];
export const STORE_ORDER_STATUSES = ['new', 'confirmed', 'paid', 'shipped', 'done', 'cancelled'] as const;

export interface StoreSettings {
  slug: string;
  name: string;
  tagline: string | null;
  theme: StoreTheme;
  accent: string;
  phone: string | null;
  address: string | null;
  /** Ảnh bìa + logo (https), hiện ở đầu trang. */
  cover_url: string | null;
  logo_url: string | null;
  cod: boolean;
  bank_transfer: boolean;
  published: boolean;
  product_ids: number[];
  /** Người phụ trách khách mới tạo từ đơn online. */
  owner_user_id: number | null;
}

const DEFAULTS: StoreSettings = {
  slug: '', name: '', tagline: null, theme: 'toi-gian', accent: '#2563eb', phone: null, address: null, cover_url: null, logo_url: null,
  cod: true, bank_transfer: false, published: false, product_ids: [], owner_user_id: null,
};
const RESERVED = new Set(['admin', 'api', 'www', 'app', 'login', 'settings', 'static', 'trinity']);
const vnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function cleanStoreSettings(input: Record<string, unknown>, current: StoreSettings): StoreSettings {
  const str = (k: string, max: number) => (input[k] === undefined ? undefined : String(input[k] ?? '').trim().slice(0, max));
  const next: StoreSettings = { ...current };
  const slug = str('slug', 40);
  if (slug !== undefined) {
    const s = slug.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(s) || RESERVED.has(s)) throw new BadRequestException('Địa chỉ trang: 3–40 ký tự chữ thường không dấu, số, gạch ngang (vd cua-hang-abc).');
    next.slug = s;
  }
  const name = str('name', 80);
  if (name !== undefined) {
    if (!name) throw new BadRequestException('Thiếu tên cửa hàng.');
    next.name = name;
  }
  for (const k of ['tagline', 'phone', 'address'] as const) {
    const v = str(k, k === 'address' ? 200 : 120);
    if (v !== undefined) next[k] = v || null;
  }
  for (const k of ['cover_url', 'logo_url'] as const) {
    const v = str(k, 500);
    if (v === undefined) continue;
    if (v && !/^https:\/\/[^\s"'<>]+$/i.test(v)) throw new BadRequestException('Ảnh bìa / logo phải là đường dẫn https.');
    next[k] = v || null;
  }
  if (input.theme === 'dam-net') input.theme = 'soi-dong'; // tên cũ
  if (input.theme !== undefined) {
    if (!(STORE_THEMES as readonly string[]).includes(String(input.theme))) throw new BadRequestException('Giao diện không hợp lệ.');
    next.theme = input.theme as StoreTheme;
  }
  if (input.accent !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(input.accent))) throw new BadRequestException('Màu chủ đạo dạng #RRGGBB.');
    next.accent = String(input.accent);
  }
  for (const k of ['cod', 'bank_transfer', 'published'] as const) if (typeof input[k] === 'boolean') next[k] = input[k] as boolean;
  if (Array.isArray(input.product_ids)) {
    const ids = [...new Set((input.product_ids as unknown[]).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
    if (ids.length > 200) throw new BadRequestException('Tối đa 200 sản phẩm trên trang.');
    next.product_ids = ids;
  }
  if (input.owner_user_id !== undefined) next.owner_user_id = input.owner_user_id == null ? null : Number(input.owner_user_id) || null;
  if (next.published) {
    if (!next.slug || !next.name) throw new BadRequestException('Cần địa chỉ trang và tên cửa hàng trước khi mở bán.');
    if (!next.cod && !next.bank_transfer) throw new BadRequestException('Bật ít nhất một cách thanh toán (COD hoặc chuyển khoản).');
  }
  return next;
}

/** Trang bán hàng online nhanh: một trang / tổ chức, sản phẩm lấy từ danh mục Sản phẩm, đơn vào CRM. Cờ `online_store` (mặc định tắt). */
@Injectable()
export class StoreService {
  private readonly logger = new Logger(StoreService.name);
  /** Chống spam đơn: 5 đơn / 10 phút / IP, và 300 đơn / 10 phút cho cả trang. */
  private readonly perIp = new FixedWindowLimiter(5, 10 * 60_000);
  private readonly perStore = new FixedWindowLimiter(300, 10 * 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly features: OrgFeaturesService,
    private readonly sync: CommerceSyncService,
    private readonly payments: PaymentsService,
    private readonly connectors: ConnectorsService,
    private readonly scope: ScopeService,
  ) {}

  async settings(): Promise<StoreSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: STORE_SETTING_KEY } });
    if (!row) return { ...DEFAULTS };
    try {
      const v = { ...DEFAULTS, ...(JSON.parse(row.value) as Partial<StoreSettings>) };
      if ((v.theme as string) === 'dam-net') v.theme = 'soi-dong';
      return v;
    } catch {
      return { ...DEFAULTS };
    }
  }

  async saveSettings(input: Record<string, unknown>, userId: number): Promise<StoreSettings> {
    const current = await this.settings();
    const next = cleanStoreSettings(input, { ...current, owner_user_id: current.owner_user_id ?? userId });
    if (next.bank_transfer && !(await this.connectors.active('sepay').catch(() => null))) {
      throw new BadRequestException('Chuyển khoản cần kết nối SePay trước (Cài đặt › Kết nối & AI › Thanh toán).');
    }
    const value = JSON.stringify(next);
    await this.prisma.setting.upsert({ where: { key: STORE_SETTING_KEY }, update: { value, updated_by: userId }, create: { key: STORE_SETTING_KEY, value, updated_by: userId } });
    return next;
  }

  /** Cửa hàng đang mở (cờ bật + đã mở bán + đúng địa chỉ); không thì 404 (không lộ là có trang hay không). */
  private async openStore(slug: string): Promise<StoreSettings> {
    const s = await this.settings();
    if (!(await this.features.isEnabled('online_store')) || !s.published || !s.slug || s.slug !== String(slug ?? '').toLowerCase()) throw new NotFoundException('Không có cửa hàng này.');
    return s;
  }

  private async products(ids: number[]) {
    if (!ids.length) return [];
    const rows = await this.prisma.product.findMany({
      where: { id: { in: ids }, is_active: true, deleted_at: null, price: { not: null } },
      select: { id: true, name: true, price: true, image_url: true, description: true },
    });
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map((p) => ({ ...p, price: Number(p.price), description: p.description?.slice(0, 600) ?? null }));
  }

  async publicStore(slug: string) {
    const s = await this.openStore(slug);
    const sepay = s.bank_transfer ? await this.connectors.active('sepay').catch(() => null) : null;
    return {
      name: s.name, tagline: s.tagline, theme: s.theme, accent: s.accent, phone: s.phone, address: s.address, cover_url: s.cover_url, logo_url: s.logo_url,
      payment: { cod: s.cod, bank_transfer: s.bank_transfer && !!sepay },
      products: await this.products(s.product_ids),
    };
  }

  async placeOrder(slug: string, ip: string, input: { name?: string; phone?: string; address?: string; note?: string; payment_method?: string; items?: Array<{ product_id?: number; quantity?: number }> }) {
    const s = await this.openStore(slug);
    for (const [lim, key] of [[this.perIp, `ip:${ip}`], [this.perStore, `store:${s.slug}`]] as const) {
      const r = lim.hit(key);
      if (!r.allowed) throw new HttpException({ statusCode: 429, message: 'Bạn đặt quá nhiều đơn, vui lòng thử lại sau ít phút.', retryAfter: r.retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const name = String(input.name ?? '').trim().slice(0, 120);
    const phone = normalizeVnPhone(String(input.phone ?? ''));
    const address = String(input.address ?? '').trim().slice(0, 300) || null;
    if (!name) throw new BadRequestException('Vui lòng nhập họ tên.');
    if (!phone) throw new BadRequestException('Số điện thoại không hợp lệ.');
    const method = input.payment_method === 'bank_transfer' ? 'bank_transfer' : 'cod';
    const pub = await this.publicStore(slug);
    if (method === 'cod' && !pub.payment.cod) throw new BadRequestException('Cửa hàng không nhận thanh toán khi nhận hàng.');
    if (method === 'bank_transfer' && !pub.payment.bank_transfer) throw new BadRequestException('Cửa hàng chưa nhận chuyển khoản.');
    if (method === 'cod' && !address) throw new BadRequestException('Vui lòng nhập địa chỉ giao hàng.');
    // Giá luôn lấy từ danh mục — không tin giá trình duyệt gửi lên.
    const byId = new Map(pub.products.map((p) => [p.id, p]));
    const lines: Array<{ product_id: number; name: string; price: number; quantity: number }> = [];
    for (const it of (input.items ?? []).slice(0, 30)) {
      const p = byId.get(Number(it?.product_id));
      const q = Math.floor(Number(it?.quantity));
      if (!p || !(q >= 1 && q <= 99)) continue;
      lines.push({ product_id: p.id, name: p.name, price: p.price, quantity: q });
    }
    if (!lines.length) throw new BadRequestException('Giỏ hàng trống hoặc sản phẩm không còn bán.');
    const total = lines.reduce((t, l) => t + l.price * l.quantity, 0);
    // Kiểm giới hạn của yêu cầu thanh toán TRƯỚC khi lưu đơn (không để đơn mồ côi khi tạo thanh toán bị từ chối).
    if (method === 'bank_transfer' && (total < 1000 || total > 10_000_000_000)) throw new BadRequestException('Tổng đơn phải từ 1.000đ tới 10 tỷ để chuyển khoản.');
    const owner = await this.owner(s);
    const contactId = await this.sync.contactFor('store', { name, phone }, owner);
    const assignedTo = contactId ? (await this.prisma.contact.findUnique({ where: { id: contactId }, select: { assigned_to: true } }))?.assigned_to ?? null : null;
    // Sự kiện webhook "đơn mới" (Zapier/n8n) ghi outbox CÙNG transaction với lúc đơn chốt: COD = lúc tạo đơn; chuyển khoản = lúc gắn
    // yêu cầu thanh toán (đơn bị gỡ khi tạo thanh toán lỗi thì không phát sự kiện).
    const emit = (tx: Prisma.TransactionClient, row: { id: number; code: string; status: string; customer_name: string; customer_phone: string; customer_address: string | null; note: string | null; total: bigint; payment_method: string; contact_id: number | null; created_at: Date }) =>
      publishIntegrationEvent(
        tx,
        'store_order.created',
        {
          order: {
            id: row.id, code: row.code, status: row.status, customer_name: row.customer_name, customer_phone: row.customer_phone,
            customer_address: row.customer_address, note: row.note,
            items: lines.map((l) => ({ product_id: l.product_id, name: l.name, quantity: l.quantity, price: l.price })),
            total: Number(row.total), payment_method: row.payment_method, contact_id: row.contact_id, contact_assigned_to: assignedTo,
            created_at: row.created_at.toISOString(),
          },
        },
        { resourceId: row.id },
      );
    let order: { id: number; code: string } | null = null;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
      let code = 'DH-';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      try {
        order = await this.prisma.$transaction(async (tx) => {
          const row = await tx.storeOrder.create({
            data: { code, customer_name: name, customer_phone: phone, customer_address: address, note: String(input.note ?? '').trim().slice(0, 500) || null, items: lines as unknown as Prisma.InputJsonArray, total: BigInt(total), payment_method: method, contact_id: contactId },
          });
          if (method !== 'bank_transfer') await emit(tx, row);
          return { id: row.id, code: row.code };
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
    }
    if (!order) throw new BadRequestException('Không tạo được đơn, vui lòng thử lại.');
    let payment: { qr_url: string | null; transfer_content: string; bank: unknown } | null = null;
    if (method === 'bank_transfer') {
      try {
        const p = await this.payments.create({ amount: total, description: `Đơn online ${order.code}`, source_type: 'store_order', source_id: order.id, contact_id: contactId, expires_in_hours: 48 }, owner.id || null);
        await this.prisma.$transaction(async (tx) => {
          const row = await tx.storeOrder.update({ where: { id: order!.id }, data: { payment_intent_id: p.id } });
          await emit(tx, row);
        });
        payment = { qr_url: p.qr_url, transfer_content: p.transfer_content, bank: p.bank };
      } catch (err) {
        // Không tạo được thanh toán ⇒ gỡ đơn vừa tạo (khách nhận lỗi và đặt lại, không để đơn mồ côi trùng lặp).
        await this.prisma.storeOrder.delete({ where: { id: order.id } }).catch(() => undefined);
        throw err;
      }
    }
    if (contactId) {
      const items = lines.slice(0, 3).map((l) => `${l.name} ×${l.quantity}`).join(', ');
      await this.prisma.activity
        .create({ data: { contact_id: contactId, action: 'note', details: { description: `Đơn online ${order.code} — ${vnd(total)} (${items}${lines.length > 3 ? '…' : ''}) · ${method === 'cod' ? 'COD' : 'chuyển khoản'}`, source: 'store' }, metadata: { store_order_id: order.id }, created_by: null } })
        .catch((e) => this.logger.warn(`Ghi lịch sử đơn online lỗi: ${(e as Error).message}`));
    }
    return { code: order.code, total, payment_method: method, payment };
  }

  /** Khách xem lại đơn của mình: phải đúng mã + SĐT đặt hàng (không dò được đơn người khác). */
  async orderStatus(slug: string, code: string, phoneRaw: string) {
    await this.openStore(slug);
    const phone = normalizeVnPhone(String(phoneRaw ?? ''));
    const o = await this.prisma.storeOrder.findUnique({ where: { code: String(code ?? '').toUpperCase() } });
    if (!o || !phone || o.customer_phone !== phone) throw new NotFoundException('Không tìm thấy đơn.');
    return { code: o.code, status: o.status, total: Number(o.total), payment_method: o.payment_method };
  }

  /**
   * Đơn trong phạm vi `deals.view` của người xem — theo người phụ trách khách đã ghép (đơn chưa ghép khách chỉ phạm vi "tất cả").
   * SĐT người mua che theo `contacts.phone_full` (cùng quy tắc màn Khách hàng).
   */
  async listOrders(user: AuthUser, status?: string, limit = 50) {
    const view = await this.scope.ownerIds(user, 'deals.view');
    const owners = view === 'all' ? null : view ?? [];
    const where: Prisma.StoreOrderWhereInput = { ...(status ? { status } : {}) };
    if (owners) {
      const contacts = await this.prisma.contact.findMany({ where: { assigned_to: { in: owners }, deleted_at: null }, select: { id: true }, take: 50_000 });
      where.contact_id = { in: contacts.map((c) => c.id) };
    }
    const rows = await this.prisma.storeOrder.findMany({ where, orderBy: { id: 'desc' }, take: Math.min(Math.max(limit, 1), 200) });
    const ownerOf = await this.contactOwners(rows.map((o) => o.contact_id));
    const mask = makePhoneMasker((await this.scope.ownerIds(user, 'contacts.phone_full')) ?? []);
    return rows.map((o) => ({ ...o, total: Number(o.total), customer_phone: mask([o.contact_id ? ownerOf.get(o.contact_id) : null], o.customer_phone) ?? '' }));
  }

  async updateOrderStatus(user: AuthUser, id: number, status: string) {
    if (!(STORE_ORDER_STATUSES as readonly string[]).includes(status)) throw new BadRequestException('Trạng thái không hợp lệ.');
    const o = await this.prisma.storeOrder.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Không có đơn này.');
    // Ngoài phạm vi `deals.manage` ⇒ 404 (không lộ là có đơn).
    await assertInScope(this.scope, user, 'deals.manage', [o.contact_id ? (await this.contactOwners([o.contact_id])).get(o.contact_id) : null]);
    const u = await this.prisma.storeOrder.update({ where: { id }, data: { status } });
    return { ...u, total: Number(u.total) };
  }

  private async contactOwners(ids: Array<number | null>): Promise<Map<number, number | null>> {
    const list = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
    if (!list.length) return new Map();
    const rows = await this.prisma.contact.findMany({ where: { id: { in: list } }, select: { id: true, assigned_to: true } });
    return new Map(rows.map((r) => [r.id, r.assigned_to]));
  }

  private async owner(s: StoreSettings): Promise<{ id: number; team_id: number | null }> {
    const u = s.owner_user_id ? await this.prisma.user.findUnique({ where: { id: s.owner_user_id }, select: { id: true, team_id: true } }) : null;
    return { id: u?.id ?? s.owner_user_id ?? 0, team_id: u?.team_id ?? null };
  }
}
