import { Injectable, Logger } from '@nestjs/common';
import { can, type Grants, type OrgFeatureKey, type Permission } from '@trinity/rbac';
import { PrismaService } from '@trinity/prisma';
import { OrgFeaturesService } from '../settings/org-features.service';
import { STORE_SETTING_KEY } from '../store/store.service';
import { vnTodayRange } from './dashboard-overview.util';

/** ok = đang chạy · attention = cần liên kết lại / lỗi · off = đã tắt. */
export type ChannelState = 'ok' | 'attention' | 'off';
export type ChannelKind = 'facebook_page' | 'zalo_oa' | 'social' | 'payment' | 'commerce' | 'store';

export interface ConnectedChannel {
  key: string;
  kind: ChannelKind;
  /** facebook, youtube, zalo, sepay, vnpay, momo, kiotviet… — để FE chọn biểu tượng. */
  network: string;
  name: string;
  state: ChannelState;
  /** Một dòng giải thích trạng thái (tiếng Việt, không thuật ngữ kỹ thuật). */
  note: string;
  /** Số liệu hôm nay (giờ VN) của kênh, null nếu kênh không có số đếm. */
  today: { label: string; value: number } | null;
  /** Màn quản lý kênh trong app. */
  href: string;
}

/** Tính năng đang bật nhưng chưa nối kênh nào — gợi ý "Nối thêm". */
export interface AvailableChannel {
  kind: ChannelKind;
  label: string;
  href: string;
}

export interface DashboardChannels {
  channels: ConnectedChannel[];
  available: AvailableChannel[];
}

const PAYMENT_PROVIDERS = new Set(['sepay', 'vnpay', 'momo']);
const PROVIDER_LABELS: Record<string, string> = {
  sepay: 'SePay', vnpay: 'VNPay', momo: 'MoMo', kiotviet: 'KiotViet', sapo: 'Sapo', ipos: 'iPOS', woocommerce: 'WooCommerce',
  shopee: 'Shopee', lazada: 'Lazada', misa: 'MISA',
};
const NETWORK_LABELS: Record<string, string> = { facebook: 'Fanpage', youtube: 'YouTube', tiktok: 'TikTok', zalo: 'Zalo OA' };

const INTEGRATIONS = '/settings?tab=integrations';

/**
 * "Kênh đã kết nối" cho trang Tổng quan (và tool get_connected_channels): Fanpage, Zalo OA, kênh đăng bài, thanh toán,
 * kết nối bán hàng, trang bán hàng — mỗi kênh một trạng thái + số liệu hôm nay. Chỉ trả nhóm kênh mà tính năng đang bật
 * VÀ người xem có quyền liên quan; không lộ khoá/token.
 */
@Injectable()
export class DashboardChannelsService {
  private readonly logger = new Logger(DashboardChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly features: OrgFeaturesService,
  ) {}

  async get(grants: Grants, now = new Date()): Promise<DashboardChannels> {
    const f = await this.features.get();
    const any = (...p: Permission[]) => p.some((x) => can(grants, x));
    const on = (k: OrgFeatureKey) => f[k] !== false;
    const { start, end } = vnTodayRange(now);
    const today = { gte: start, lt: end };

    const channels: ConnectedChannel[] = [];
    const available: AvailableChannel[] = [];
    const tasks: Promise<void>[] = [];

    if (on('facebook_page') && any('integrations.webhooks', 'contacts.update')) {
      tasks.push((async () => {
        const pages = await this.prisma.facebookPage.findMany({ orderBy: { id: 'asc' }, take: 20, select: { id: true, page_id: true, name: true, is_active: true, token_status: true, subscribed: true } });
        if (pages.length === 0) available.push({ kind: 'facebook_page', label: 'Fanpage Facebook', href: `${INTEGRATIONS}&muc=facebook` });
        const counts = await this.inboundByPage(pages.map((p) => p.page_id), today);
        for (const p of pages) {
          const broken = p.token_status === 'invalid' || p.token_status === 'expired';
          const state: ChannelState = !p.is_active ? 'off' : broken || !p.subscribed ? 'attention' : 'ok';
          channels.push({
            key: `facebook_page:${p.id}`, kind: 'facebook_page', network: 'facebook', name: p.name, state,
            note: state === 'off' ? 'Đã tắt' : broken ? 'Cần kết nối lại' : !p.subscribed ? 'Chưa nhận tin nhắn' : 'Đang nhận tin',
            today: { label: 'tin nhắn mới', value: counts.get(p.page_id) ?? 0 },
            href: `${INTEGRATIONS}&muc=facebook`,
          });
        }
      })());
    }

    if (on('zalo_oa') && any('integrations.webhooks', 'contacts.update')) {
      tasks.push((async () => {
        const conns = await this.prisma.zaloOaConnection.findMany({ orderBy: { id: 'asc' }, take: 5, select: { id: true, oa_id: true, status: true } });
        if (conns.length === 0) available.push({ kind: 'zalo_oa', label: 'Zalo OA', href: `${INTEGRATIONS}&muc=zalo-oa` });
        for (const c of conns) {
          const inbound = await this.prisma.zaloOaMessage.count({ where: { direction: 'in', created_at: today, thread: { oa_id: c.oa_id } } });
          const state: ChannelState = c.status === 'active' ? 'ok' : c.status === 'disconnected' ? 'off' : 'attention';
          channels.push({
            key: `zalo_oa:${c.id}`, kind: 'zalo_oa', network: 'zalo', name: 'Zalo OA', state,
            note: state === 'ok' ? 'Đang nhận tin' : state === 'off' ? 'Đã ngắt kết nối' : 'Cần kết nối lại',
            today: { label: 'tin nhắn mới', value: inbound },
            href: `${INTEGRATIONS}&muc=zalo-oa`,
          });
        }
      })());
    }

    if (on('social_posting') && any('social.post')) {
      tasks.push((async () => {
        const accounts = await this.prisma.socialAccount.findMany({ orderBy: { id: 'asc' }, take: 20, select: { id: true, network: true, name: true, status: true } });
        if (accounts.length === 0) available.push({ kind: 'social', label: 'Kênh đăng bài (Fanpage, YouTube)', href: '/social?tab=channels' });
        const published = await this.prisma.socialPostTarget.groupBy({
          by: ['account_id'], where: { status: 'published', published_at: today, account_id: { in: accounts.map((a) => a.id) } }, _count: { _all: true },
        });
        const byAccount = new Map(published.map((r) => [r.account_id, r._count._all]));
        for (const a of accounts) {
          const state: ChannelState = a.status === 'active' ? 'ok' : a.status === 'disabled' ? 'off' : 'attention';
          channels.push({
            key: `social:${a.id}`, kind: 'social', network: a.network, name: a.name, state,
            note: state === 'ok' ? `Đăng bài lên ${NETWORK_LABELS[a.network] ?? a.network}` : state === 'off' ? 'Đã tắt' : 'Cần liên kết lại',
            today: { label: 'bài đã đăng', value: byAccount.get(a.id) ?? 0 },
            href: '/social?tab=channels',
          });
        }
      })());
    }

    const wantPayments = on('payments') && any('integrations.webhooks', 'deals.view');
    const wantCommerce = on('commerce_connectors') && any('integrations.webhooks', 'deals.view');
    if (wantPayments || wantCommerce) {
      tasks.push((async () => {
        const accounts = await this.prisma.connectorAccount.findMany({ orderBy: { id: 'asc' }, select: { id: true, provider: true, status: true, last_event_at: true } });
        const pay = accounts.filter((a) => PAYMENT_PROVIDERS.has(a.provider));
        const shop = accounts.filter((a) => !PAYMENT_PROVIDERS.has(a.provider));
        if (wantPayments && pay.length === 0) available.push({ kind: 'payment', label: 'Thanh toán (SePay, VNPay, MoMo)', href: `${INTEGRATIONS}&muc=payments` });
        if (wantPayments && pay.length) {
          const paid = await this.prisma.paymentIntent.groupBy({ by: ['paid_via'], where: { status: 'paid', paid_at: today }, _count: { _all: true } });
          const byVia = new Map(paid.map((r) => [r.paid_via ?? '', r._count._all]));
          for (const a of pay) channels.push(this.connector(a, 'payment', { label: 'lượt thanh toán', value: byVia.get(a.provider) ?? 0 }, `${INTEGRATIONS}&muc=payments`));
        }
        if (wantCommerce) for (const a of shop) channels.push(this.connector(a, 'commerce', null, `${INTEGRATIONS}&muc=ban-hang`));
      })());
    }

    if (on('online_store') && any('pos.manage', 'deals.view')) {
      tasks.push((async () => {
        const row = await this.prisma.setting.findUnique({ where: { key: STORE_SETTING_KEY }, select: { value: true } });
        let store: { name?: string; slug?: string; published?: boolean } = {};
        try { store = row?.value ? JSON.parse(row.value) : {}; } catch { store = {}; }
        if (!store.slug) {
          available.push({ kind: 'store', label: 'Trang bán hàng', href: `${INTEGRATIONS}&muc=ban-online` });
          return;
        }
        const orders = await this.prisma.storeOrder.count({ where: { created_at: today } });
        channels.push({
          key: 'store', kind: 'store', network: 'store', name: store.name || 'Trang bán hàng', state: store.published ? 'ok' : 'off',
          note: store.published ? 'Đang mở bán' : 'Chưa mở bán', today: { label: 'đơn mới', value: orders }, href: `${INTEGRATIONS}&muc=ban-online`,
        });
      })());
    }

    await Promise.all(tasks.map((t) => t.catch((e: Error) => this.logger.warn(`Kênh Tổng quan lỗi: ${e.message}`))));
    const order: ChannelKind[] = ['facebook_page', 'zalo_oa', 'social', 'payment', 'store', 'commerce'];
    channels.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    available.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    return { channels, available };
  }

  private connector(a: { id: number; provider: string; status: string; last_event_at: Date | null }, kind: 'payment' | 'commerce', today: ConnectedChannel['today'], href: string): ConnectedChannel {
    const state: ChannelState = a.status === 'active' ? 'ok' : a.status === 'disconnected' ? 'off' : 'attention';
    return {
      key: `${kind}:${a.id}`, kind, network: a.provider, name: PROVIDER_LABELS[a.provider] ?? a.provider, state,
      note: state === 'ok' ? (kind === 'payment' ? 'Đang nhận tiền' : 'Đang đồng bộ') : state === 'off' ? 'Đã ngắt kết nối' : 'Có lỗi, cần kiểm tra',
      today, href,
    };
  }

  /** Số tin khách gửi tới hôm nay theo Fanpage: gom theo hội thoại (ít, chỉ trong ngày) rồi tra Page của hội thoại. */
  private async inboundByPage(pageIds: string[], today: { gte: Date; lt: Date }): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (pageIds.length === 0) return out;
    const byConv = await this.prisma.facebookMessage.groupBy({ by: ['conversation_id'], where: { direction: 'in', sent_at: today }, _count: { _all: true } });
    if (byConv.length === 0) return out;
    const convs = await this.prisma.facebookConversation.findMany({ where: { id: { in: byConv.map((r) => r.conversation_id) }, page_id: { in: pageIds } }, select: { id: true, page_id: true } });
    const pageOf = new Map(convs.map((c) => [c.id, c.page_id]));
    for (const r of byConv) {
      const page = pageOf.get(r.conversation_id);
      if (page) out.set(page, (out.get(page) ?? 0) + r._count._all);
    }
    return out;
  }
}
