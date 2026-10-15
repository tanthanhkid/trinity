import { wrapData } from '../ai-output';
import { vnWhen } from '../actions/action-social-tools';
import { ToolUserError, type ToolDef } from './tool-types';
import { normalizePhone, phoneVariants } from '../../../google/sheet-mapping';

const PROVIDERS = ['kiotviet', 'sapo', 'ipos', 'woocommerce', 'shopee', 'lazada'] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Ngày YYYY-MM-DD theo giờ Việt Nam → mốc UTC đầu ngày (`end` = đầu ngày hôm sau). */
function vnDay(v: unknown, end = false): Date | null {
  if (typeof v !== 'string' || !DAY.test(v)) return null;
  const [y, m, day] = v.split('-').map(Number);
  // Ngày không tồn tại (31/02, 29/02 năm thường) bị JS dồn sang tháng sau ⇒ từ chối thay vì truy vấn nhầm khoảng.
  const check = new Date(Date.UTC(y, m - 1, day));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day) return null;
  const d = new Date(`${v}T00:00:00+07:00`);
  if (Number.isNaN(d.getTime())) return null;
  return end ? new Date(d.getTime() + 86_400_000) : d;
}

/** Đơn / hoá đơn đã đồng bộ từ phần mềm bán hàng (KiotViet…) — chỉ đọc. Có chế độ đếm số đơn theo khách (kèm đơn trang bán hàng). */
export const listSalesOrdersTool: ToolDef = {
  name: 'list_sales_orders',
  title: 'Đơn hàng từ phần mềm bán hàng / List synced sales orders',
  description:
    'Đơn hàng và hoá đơn Trinity đã đồng bộ từ phần mềm bán hàng của doanh nghiệp (KiotViet, Sapo, WooCommerce…), mới nhất trước: mã, tổng tiền, trạng thái, tên khách, contact_id (khách CRM đã ghép theo SĐT), vài mặt hàng — tối đa 30 đơn. ' +
    'Lọc: provider, kind (order = đơn đặt, invoice = hoá đơn đã bán), một khách (contact_id, contact_code như KH012, hoặc phone), from/to (YYYY-MM-DD, theo ngày cập nhật đơn). ' +
    'group_by_contact = true: ĐẾM số đơn và tổng tiền theo từng khách trên TOÀN BỘ đơn khớp bộ lọc (không giới hạn 30), gồm cả đơn từ trang bán hàng của Trinity; min_orders để lấy khách mua từ N lần trở lên. Chỉ đọc. / ' +
    'Orders and invoices synced from the business POS, newest first (max 30). Filter by provider, kind, one customer (contact_id, contact_code or phone) and date range. ' +
    'group_by_contact = true counts orders and revenue per customer over ALL matching orders (including Trinity online-store orders); min_orders keeps repeat buyers. Read-only.',
  permissions: ['deals.view'],
  input: (z) => ({
    provider: z.enum(PROVIDERS).optional().describe('Nguồn / Source system'),
    kind: z.enum(['order', 'invoice']).optional().describe('order = đơn đặt, invoice = hoá đơn / order or invoice'),
    contact_id: z.number().int().min(1).max(2_147_483_647).optional().describe('Chỉ đơn của khách này / Only this contact'),
    contact_code: z.string().max(24).optional().describe('Mã khách, vd KH012 / Contact code'),
    phone: z.string().max(20).optional().describe('SĐT khách / Customer phone'),
    from: z.string().max(10).optional().describe('Từ ngày YYYY-MM-DD (giờ VN) / From date'),
    to: z.string().max(10).optional().describe('Đến hết ngày YYYY-MM-DD (giờ VN) / To date (inclusive)'),
    group_by_contact: z.boolean().optional().describe('Đếm số đơn + tổng tiền theo khách / Count orders per customer'),
    min_orders: z.number().int().min(1).max(1000).optional().describe('Chỉ khách có từ N đơn (khi group_by_contact) / Min orders per customer'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    if (!(await deps.orgFeatures.isEnabled('commerce_connectors'))) {
      throw new ToolUserError('Tính năng "Kết nối bán hàng" đang tắt (Cài đặt › Tính năng). / The sales connectors feature is turned off.');
    }
    const from = vnDay(args.from);
    const to = vnDay(args.to, true);
    if ((args.from && !from) || (args.to && !to)) throw new ToolUserError('from/to phải có dạng YYYY-MM-DD. / from/to must be YYYY-MM-DD.');
    // Cùng phạm vi với API: đơn của khách mình được xem; đơn chưa ghép khách chỉ người có phạm vi "tất cả".
    const ids = await deps.scope.ownerIds(principal.user, 'deals.view');
    const visible = ids === 'all' ? null : (await deps.prisma.contact.findMany({ where: { assigned_to: { in: ids ?? [] }, deleted_at: null }, select: { id: true }, take: 50_000 })).map((c) => c.id);

    // Một khách: id, mã (KH012) hoặc SĐT ⇒ tập contact_id (SĐT có thể trùng nhiều bản ghi).
    let only: number[] | null = typeof args.contact_id === 'number' ? [args.contact_id] : null;
    if (typeof args.contact_code === 'string' && args.contact_code.trim()) {
      const c = await deps.prisma.contact.findFirst({ where: { code: args.contact_code.trim().toUpperCase(), deleted_at: null }, select: { id: true } });
      only = intersect(only, c ? [c.id] : []);
    }
    if (typeof args.phone === 'string' && args.phone.trim()) {
      const phone = normalizePhone(args.phone) ?? args.phone.trim();
      const cs = await deps.prisma.contact.findMany({ where: { phone: { in: phoneVariants(phone) }, deleted_at: null }, select: { id: true }, take: 50 });
      only = intersect(only, cs.map((c) => c.id));
    }
    if (only && only.length === 0) {
      const note = 'Không tìm thấy khách khớp mã/SĐT. / No matching customer.';
      const out = args.group_by_contact === true
        ? wrapData({ customers: [], customers_matched: 0, shown: 0, min_orders: typeof args.min_orders === 'number' ? args.min_orders : 1, from: args.from ?? null, to: args.to ?? null, note })
        : wrapData({ orders: [], count: 0, note });
      return { structured: out, text: JSON.stringify(out) };
    }
    const contactIds = only && visible ? intersect(only, visible) : (only ?? visible);
    const contactWhere = contactIds ? { contact_id: { in: contactIds } } : {};
    const updated = from || to ? { external_updated_at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {};
    const base = {
      kind: typeof args.kind === 'string' ? args.kind : { in: ['order', 'invoice'] },
      ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
      status: { not: 'removed' },
      ...updated,
      ...contactWhere,
    };

    if (args.group_by_contact === true) {
      const synced = await deps.prisma.connectorRecord.groupBy({
        by: ['contact_id'],
        where: { ...base, contact_id: contactIds ? { in: contactIds } : { not: null } },
        _count: { _all: true },
        _sum: { amount: true },
      });
      // Đơn trang bán hàng của Trinity (khi không lọc theo nguồn/loại): cùng phạm vi khách, bỏ đơn đã huỷ.
      const store = typeof args.provider === 'string' || typeof args.kind === 'string' ? [] : await deps.prisma.storeOrder.groupBy({
        by: ['contact_id'],
        where: {
          contact_id: contactIds ? { in: contactIds } : { not: null },
          status: { not: 'cancelled' },
          ...(from || to ? { created_at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
        },
        _count: { _all: true },
        _sum: { total: true },
      });
      const agg = new Map<number, { orders: number; total: number; store_orders: number }>();
      for (const r of synced) {
        if (r.contact_id == null) continue;
        const a = agg.get(r.contact_id) ?? { orders: 0, total: 0, store_orders: 0 };
        a.orders += r._count._all;
        a.total += Number(r._sum.amount ?? 0);
        agg.set(r.contact_id, a);
      }
      for (const r of store) {
        if (r.contact_id == null) continue;
        const a = agg.get(r.contact_id) ?? { orders: 0, total: 0, store_orders: 0 };
        a.orders += r._count._all;
        a.store_orders += r._count._all;
        a.total += Number(r._sum.total ?? 0);
        agg.set(r.contact_id, a);
      }
      const min = typeof args.min_orders === 'number' ? args.min_orders : 1;
      const ranked = [...agg.entries()].filter(([, a]) => a.orders >= min).sort((x, y) => y[1].orders - x[1].orders || y[1].total - x[1].total);
      const top = ranked.slice(0, 100);
      const names = new Map((await deps.prisma.contact.findMany({ where: { id: { in: top.map(([id]) => id) } }, select: { id: true, code: true, full_name: true } })).map((c) => [c.id, c]));
      const customers = top.map(([id, a]) => ({ contact_id: id, code: names.get(id)?.code ?? null, name: names.get(id)?.full_name ?? null, orders: a.orders, store_orders: a.store_orders, total: a.total }));
      const out = wrapData({ customers, customers_matched: ranked.length, shown: customers.length, min_orders: min, from: args.from ?? null, to: args.to ?? null });
      return { structured: out, text: JSON.stringify(out) };
    }

    const rows = await deps.prisma.connectorRecord.findMany({
      where: base,
      orderBy: [{ external_updated_at: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: 30,
    });
    const orders = rows.map((r) => {
      const items = ((r.data as { items?: Array<{ name: string; quantity: number }> })?.items ?? []).slice(0, 5);
      return {
        provider: r.provider, kind: r.kind, code: r.code, total: r.amount == null ? null : Number(r.amount), status: r.status,
        customer_name: r.name, contact_id: r.contact_id, items, updated: r.external_updated_at ? vnWhen(r.external_updated_at) : null,
      };
    });
    const out = wrapData({ orders, count: orders.length });
    return { structured: out, text: JSON.stringify(out) };
  },
};

function intersect(a: number[] | null, b: number[]): number[] {
  if (a === null) return b;
  const s = new Set(b);
  return a.filter((x) => s.has(x));
}

export const SALES_RECORD_TOOLS: readonly ToolDef[] = [listSalesOrdersTool];
