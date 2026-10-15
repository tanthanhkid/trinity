import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { misaAppId } from './misa';
import { shopeeConfig } from './shopee';
import { lazadaConfig } from './lazada';
import { decryptSecret, encryptSecret, generateWebhookSecret, isSecretKeyConfigured, loadSecretKey } from '../integrations/webhooks/secret-crypto';

/** Nhà cung cấp đã làm. Thêm connector mới = thêm vào đây + một provider riêng. */
export const CONNECTOR_PROVIDERS = ['sepay', 'vnpay', 'momo', 'kiotviet', 'sapo', 'misa', 'woocommerce', 'shopee', 'lazada'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export const DEFAULT_CODE_PREFIX = 'TRN';

export interface SepaySettings {
  account_number: string;
  /** Mã ngân hàng theo SePay/VietQR, vd "MBBank", "Vietcombank", "ACB". */
  bank: string;
  account_name?: string;
  code_prefix: string;
}

export interface VnpaySettings {
  tmn_code: string;
  sandbox: boolean;
}

export interface MomoSettings {
  partner_code: string;
  sandbox: boolean;
}

export interface ConnectorStatus {
  provider: ConnectorProvider;
  connected: boolean;
  status: 'not_connected' | 'active' | 'error';
  settings: Record<string, unknown> | null;
  last_event_at: string | null;
  last_error: string | null;
  webhook_path: string;
  /** Máy chủ có INTEGRATIONS_SECRET_KEY để mã hoá khoá chưa. */
  secret_key_configured: boolean;
  /** Máy chủ đủ cấu hình riêng của nhà cung cấp chưa (vd MISA cần MISA_APP_ID). */
  server_configured: boolean;
}

const webhookPath = (p: ConnectorProvider) => (p === 'sepay' ? '/api/v1/connectors/sepay/webhook' : p === 'kiotviet' || p === 'sapo' || p === 'woocommerce' ? `/api/v1/connectors/${p}/webhook` : p === 'shopee' || p === 'lazada' ? `/api/v1/connectors/${p}/push` : `/api/v1/connectors/${p}/ipn`);

export function cleanSepaySettings(input: Record<string, unknown>): SepaySettings {
  const acc = String(input.account_number ?? '').replace(/\s+/g, '');
  const bank = String(input.bank ?? '').trim();
  const name = String(input.account_name ?? '').trim();
  const prefix = String(input.code_prefix ?? DEFAULT_CODE_PREFIX).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[0-9A-Za-z]{4,30}$/.test(acc)) throw new BadRequestException('Số tài khoản không hợp lệ (4–30 chữ số/chữ cái).');
  if (!/^[A-Za-z0-9 ._-]{2,40}$/.test(bank)) throw new BadRequestException('Thiếu tên ngân hàng (vd MBBank, Vietcombank, ACB).');
  if (!/^[A-Z]{2,5}$/.test(prefix)) throw new BadRequestException('Tiền tố mã thanh toán phải là 2–5 chữ cái, vd TRN.');
  return { account_number: acc, bank, code_prefix: prefix, ...(name ? { account_name: name.slice(0, 80) } : {}) };
}

/** Khung connector chung: lưu khoá (mã hoá), cấu hình, trạng thái của từng nhà cung cấp. */
@Injectable()
export class ConnectorsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ConnectorStatus[]> {
    const rows = await this.prisma.connectorAccount.findMany({ where: { provider: { in: [...CONNECTOR_PROVIDERS] } } });
    return CONNECTOR_PROVIDERS.map((p) => {
      const r = rows.find((x) => x.provider === p);
      return {
        provider: p,
        connected: !!r && r.status !== 'disconnected',
        status: !r || r.status === 'disconnected' ? 'not_connected' : r.status === 'error' ? 'error' : 'active',
        settings: r ? (r.settings as Record<string, unknown>) : null,
        last_event_at: r?.last_event_at?.toISOString() ?? null,
        last_error: r?.last_error ?? null,
        webhook_path: webhookPath(p),
        secret_key_configured: isSecretKeyConfigured(),
        server_configured: p === 'misa' ? misaAppId() !== null : p === 'shopee' ? shopeeConfig() !== null : p === 'lazada' ? lazadaConfig() !== null : true,
      };
    });
  }

  /** Lưu cấu hình SePay. Lần đầu (hoặc `rotate`) sinh khoá webhook mới và trả về ĐÚNG MỘT LẦN để khách dán vào SePay. */
  async saveSepay(input: Record<string, unknown>, userId: number, rotate = false): Promise<{ status: ConnectorStatus; api_key: string | null }> {
    const settings = cleanSepaySettings(input);
    if (!isSecretKeyConfigured()) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_SECRET_KEY nên chưa lưu được khoá.');
    const existing = await this.prisma.connectorAccount.findUnique({ where: { provider: 'sepay' } });
    let apiKey: string | null = null;
    let credentials_enc = existing?.credentials_enc;
    if (!existing || rotate || existing.status === 'disconnected' || !credentials_enc) {
      apiKey = generateWebhookSecret().replace(/^whsec_/, 'sepay_');
      credentials_enc = encryptSecret(JSON.stringify({ webhook_api_key: apiKey }), loadSecretKey());
    }
    const data = { status: 'active', credentials_enc, settings: settings as object, last_error: null, connected_by: userId };
    await this.prisma.connectorAccount.upsert({ where: { provider: 'sepay' }, update: data, create: { provider: 'sepay', ...data } });
    const status = (await this.list()).find((s) => s.provider === 'sepay')!;
    return { status, api_key: apiKey };
  }

  /**
   * Lưu cổng VNPay / MoMo — khoá do khách dán (lấy ở trang quản trị của cổng). Sửa mà để trống ô khoá ⇒ giữ khoá cũ.
   */
  async saveGateway(provider: 'vnpay' | 'momo', input: Record<string, unknown>, userId: number): Promise<ConnectorStatus> {
    if (!isSecretKeyConfigured()) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_SECRET_KEY nên chưa lưu được khoá.');
    const str = (k: string) => String(input[k] ?? '').trim();
    const sandbox = input.sandbox !== false;
    const existing = await this.prisma.connectorAccount.findUnique({ where: { provider } });
    const old = existing?.credentials_enc && existing.status !== 'disconnected' ? (JSON.parse(decryptSecret(existing.credentials_enc, loadSecretKey())) as Record<string, string>) : {};
    let settings: VnpaySettings | MomoSettings;
    let creds: Record<string, string>;
    if (provider === 'vnpay') {
      const tmn = str('tmn_code').toUpperCase();
      if (!/^[A-Z0-9]{4,20}$/.test(tmn)) throw new BadRequestException('Mã website (vnp_TmnCode) không hợp lệ.');
      const secret = str('hash_secret') || old.hash_secret || '';
      if (!/^[A-Za-z0-9]{8,128}$/.test(secret)) throw new BadRequestException('Thiếu chuỗi bí mật (vnp_HashSecret).');
      settings = { tmn_code: tmn, sandbox };
      creds = { hash_secret: secret };
    } else {
      const partner = str('partner_code').toUpperCase();
      if (!/^[A-Z0-9]{2,40}$/.test(partner)) throw new BadRequestException('Partner code không hợp lệ.');
      const accessKey = str('access_key') || old.access_key || '';
      const secretKey = str('secret_key') || old.secret_key || '';
      if (!/^[A-Za-z0-9]{6,128}$/.test(accessKey) || !/^[A-Za-z0-9]{8,128}$/.test(secretKey)) throw new BadRequestException('Thiếu Access key hoặc Secret key.');
      settings = { partner_code: partner, sandbox };
      creds = { access_key: accessKey, secret_key: secretKey };
    }
    const data = { status: 'active', credentials_enc: encryptSecret(JSON.stringify(creds), loadSecretKey()), settings: settings as object, last_error: null, connected_by: userId };
    await this.prisma.connectorAccount.upsert({ where: { provider }, update: data, create: { provider, ...data } });
    return (await this.list()).find((s) => s.provider === provider)!;
  }

  async disconnect(provider: ConnectorProvider): Promise<void> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider } });
    if (!r) throw new NotFoundException('Chưa kết nối.');
    // Xoá khoá; giữ dòng để còn lịch sử sự kiện. Kết nối lại sẽ sinh khoá mới.
    await this.prisma.connectorAccount.update({ where: { provider }, data: { status: 'disconnected', credentials_enc: '' } });
  }

  /** Khoá + cấu hình của kết nối đang chạy; chưa kết nối ⇒ null. */
  async active<T = Record<string, unknown>>(provider: ConnectorProvider): Promise<{ credentials: Record<string, string>; settings: T } | null> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider } });
    if (!r || r.status === 'disconnected' || !r.credentials_enc || !isSecretKeyConfigured()) return null;
    const credentials = JSON.parse(decryptSecret(r.credentials_enc, loadSecretKey())) as Record<string, string>;
    return { credentials, settings: r.settings as T };
  }

  async touch(provider: ConnectorProvider, error: string | null = null): Promise<void> {
    await this.prisma.connectorAccount
      .updateMany({ where: { provider, status: { not: 'disconnected' } }, data: error ? { last_error: error.slice(0, 300) } : { last_event_at: new Date(), last_error: null, status: 'active' } })
      .catch(() => undefined);
  }
}
