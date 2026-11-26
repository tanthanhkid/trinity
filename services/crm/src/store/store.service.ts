import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService, claimCompanyRoute, publishIntegrationEvent, releaseCompanyRoute } from '@trinity/prisma';
import { ScopeService, assertInScope, makePhoneMasker, type AuthUser } from '@trinity/rbac-nest';
import { randomInt } from 'node:crypto';
import { FixedWindowLimiter } from '../common/helpers/fixed-window-limiter';
import { normalizePhone, phoneVariants } from '../common/helpers/phone.helper';
import { PublicApiService } from '../public-api/public-api.service';
import { OrgFeaturesService } from '../settings/org-features.service';
import { VIETQR_ACCOUNT_RE, VIETQR_BANKS, buildVietQr, findVietQrBank } from './vietqr';

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
  /** Tài khoản nhận chuyển khoản (QR VietQR tự sinh): BIN ngân hàng 6 số, số tài khoản, tên chủ tài khoản (hiển thị). */
  bank_bin: string | null;
  bank_account: string | null;
  bank_account_name: string | null;
  /** Nhắc chủ cửa hàng (vd migration 0022 tắt chuyển khoản vì không đọc được tài khoản SePay cũ); lưu tài khoản hợp lệ thì xoá. */
  bank_notice: string | null;
  published: boolean;
  product_ids: number[];
  /** Người phụ trách khách mới tạo từ đơn online. */
  owner_user_id: number | null;
}

const DEFAULTS: StoreSettings = {
  slug: '', name: '', tagline: null, theme: 'toi-gian', accent: '#2563eb', phone: null, address: null, cover_url: null, logo_url: null,
  cod: true, bank_transfer: false, bank_bin: null, bank_account: null, bank_account_name: null, bank_notice: null,
  published: false, product_ids: [], owner_user_id: null,
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
  if (input.bank_bin !== undefined) {
    const raw = String(input.bank_bin ?? '').trim();
    const bank = raw ? findVietQrBank(raw) : null;
    if (raw && !bank) throw new BadRequestException('Ngân hàng không có trong danh sách nhận VietQR — chọn lại ngân hàng.');
    next.bank_bin = bank?.bin ?? null;
  }
  if (input.bank_account !== undefined) {
    const acc = String(input.bank_account ?? '').replace(/\s+/g, '');
    if (acc && !VIETQR_ACCOUNT_RE.test(acc)) throw new BadRequestException('Số tài khoản: 4–19 chữ số hoặc chữ cái, không dấu cách.');
    next.bank_account = acc || null;
  }
  const accName = str('bank_account_name', 80);
  if (accName !== undefined) next.bank_account_name = accName || null;
  if (next.bank_transfer && !(next.bank_bin && next.bank_account)) {
    throw new BadRequestException('Chuyển khoản cần chọn ngân hàng và nhập số tài khoản nhận tiền.');
  }
  if (next.bank_bin && next.bank_account) next.bank_notice = null;
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

/** Tài khoản nhận chuyển khoản đang dùng được (bật + đủ BIN hợp lệ + số TK), không thì null. */
export function bankAccountOf(s: StoreSettings): { bin: string; name: string; account: string; account_name: string | null } | null {
  if (!s.bank_transfer || !s.bank_account || !VIETQR_ACCOUNT_RE.test(s.bank_account)) return null;
  const bank = findVietQrBank(s.bank_bin);
  return bank ? { bin: bank.bin, name: bank.name, account: s.bank_account, account_name: s.bank_account_name } : null;
}

/** Danh sách ngân hàng nhận VietQR cho màn cấu hình (BIN + tên). */
export const STORE_BANKS = VIETQR_BANKS.map((b) => ({ bin: b.bin, name: b.name }));

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
    private readonly publicApi: PublicApiService,
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
    // Multi-tenant: an address (slug) belongs to ONE company, so links work even without `?cid=`. First claim wins.
    if (next.slug && next.slug !== current.slug) {
      await claimCompanyRoute('store_slug', next.slug);
    }
    const value = JSON.stringify(next);
    await this.prisma.setting.upsert({ where: { key: STORE_SETTING_KEY }, update: { value, updated_by: userId }, create: { key: STORE_SETTING_KEY, value, updated_by: userId } });
    if (current.slug && current.slug !== next.slug) await releaseCompanyRoute('store_slug', current.slug);
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
    return {
      name: s.name, tagline: s.tagline, theme: s.theme, accent: s.accent, phone: s.phone, address: s.address, cover_url: s.cover_url, logo_url: s.logo_url,
      payment: { cod: s.cod, bank_transfer: bankAccountOf(s) !== null },
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
    const phone = normalizePhone(String(input.phone ?? ''));
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
    if (method === 'bank_transfer' && (total < 1000 || total > 10_000_000_000)) throw new BadRequestException('Tổng đơn phải từ 1.000đ tới 10 tỷ để chuyển khoản.');
    const owner = await this.owner(s);
    const contactId = await this.contactFor({ name, phone }, owner);
    const assignedTo = contactId ? (await this.prisma.contact.findUnique({ where: { id: contactId }, select: { assigned_to: true } }))?.assigned_to ?? null : null;
    // Sự kiện webhook "đơn mới" (Zapier/n8n) ghi outbox CÙNG transaction với lúc tạo đơn (COD và chuyển khoản như nhau).
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
          await emit(tx, row);
          return { id: row.id, code: row.code };
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
    }
    if (!order) throw new BadRequestException('Không tạo được đơn, vui lòng thử lại.');
    // Chuyển khoản: QR VietQR tĩnh sinh tại chỗ (không gọi dịch vụ ngoài), nội dung = mã đơn. Không tự khớp tiền — đơn ở
    // trạng thái "mới" tới khi nhân viên xác nhận (PATCH store/orders/:id).
    const bank = method === 'bank_transfer' ? bankAccountOf(s) : null;
    const payment = bank
      ? {
          qr_data: buildVietQr({ bin: bank.bin, account: bank.account, amount: total, content: order.code }),
          transfer_content: order.code,
          bank: { bin: bank.bin, bank: bank.name, account_number: bank.account, account_name: bank.account_name },
        }
      : null;
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
    const phone = normalizePhone(String(phoneRaw ?? ''));
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

  /** Khách theo SĐT (trùng khách cũ ⇒ khách đó), chưa có thì tạo. Cùng khoá tư vấn theo SĐT với tạo khách tay / webhook vào. */
  private async contactFor(c: { name: string; phone: string }, owner: { id: number; team_id: number | null }): Promise<number | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${c.phone}))`;
      const dup = await tx.contact.findFirst({ where: { phone: { in: phoneVariants(c.phone) }, deleted_at: null }, orderBy: { id: 'asc' }, select: { id: true } });
      if (dup) return dup.id;
      // Nhãn nguồn `connector:store` giữ như trước để báo cáo theo nguồn không đứt.
      const created = await this.publicApi.createContactInTx(tx, { phone: c.phone, full_name: c.name.slice(0, 255) || null, email: null }, owner, 'connector:store');
      await tx.activity.create({ data: { contact_id: created.id, action: 'note', details: { description: 'Tạo từ trang bán hàng', source: 'connector:store' }, created_by: null } });
      return created.id;
    });
  }

  private async owner(s: StoreSettings): Promise<{ id: number; team_id: number | null }> {
    const u = s.owner_user_id ? await this.prisma.user.findUnique({ where: { id: s.owner_user_id }, select: { id: true, team_id: true } }) : null;
    return { id: u?.id ?? s.owner_user_id ?? 0, team_id: u?.team_id ?? null };
  }
}
