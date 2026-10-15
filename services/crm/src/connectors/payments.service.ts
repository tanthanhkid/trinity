import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService, publishIntegrationEvent } from '@trinity/prisma';
import type { PaymentIntent } from '@prisma/client';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { randomInt } from 'node:crypto';
import { ConnectorsService, DEFAULT_CODE_PREFIX, type MomoSettings, type SepaySettings, type VnpaySettings } from './connectors.service';
import { publicBaseUrl } from '../integrations/oauth/oauth-config';
import { VNPAY_IPN, codeFromTxnRef, txnRefFor, verifyVnpay, vnpayPayUrl } from './vnpay';
import { MOMO_URLS, momoCreateBody, verifyMomoResult, type MomoResult } from './momo';
import { PAYMENT_CODE_BODY, findPaymentCodes, sepayDate, sepayQrUrl, type SepayTransaction } from './sepay';

export const PAYMENT_SOURCE_TYPES = ['manual', 'deal', 'pos_order', 'store_order'] as const;
export type PaymentSourceType = (typeof PAYMENT_SOURCE_TYPES)[number];

export interface CreatePaymentInput {
  amount: number;
  description?: string | null;
  source_type?: PaymentSourceType;
  source_id?: number | null;
  contact_id?: number | null;
  expires_in_hours?: number | null;
}

export interface PaymentView {
  id: number;
  code: string;
  amount: number;
  description: string | null;
  status: string;
  source_type: string;
  source_id: number | null;
  contact_id: number | null;
  paid_amount: number | null;
  paid_via: string | null;
  paid_at: string | null;
  expires_at: string | null;
  created_at: string;
  /** Nội dung khách cần ghi khi chuyển khoản (= mã). */
  transfer_content: string;
  /** Ảnh QR VietQR qua SePay; null khi chưa kết nối SePay. */
  qr_url: string | null;
  bank: { account_number: string; bank: string; account_name: string | null } | null;
  /** Link thanh toán gửi khách (mở là chuyển sang cổng); chỉ có khi cổng đã nối + còn chờ trả + máy chủ có địa chỉ công khai. */
  pay_links: { vnpay?: string; momo?: string };
}

export type GatewayOutcome = { status: 'paid' | 'duplicate' | 'failed' | 'not_found' | 'invalid_amount' | 'invalid_signature' | 'already_paid' };

/** Không dùng 0/O/1/I để khách gõ tay không nhầm. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newPaymentCode(prefix = DEFAULT_CODE_PREFIX): string {
  let s = prefix;
  for (let i = 0; i < PAYMENT_CODE_BODY; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export type SepayOutcome = { status: 'duplicate' | 'ignored' | 'unmatched' | 'underpaid' | 'matched'; payment_intent_id?: number };

/** Yêu cầu thanh toán + tự khớp tiền về (SePay). VNPay/MoMo sẽ dùng chung `markPaid`. */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * Phạm vi theo quyền deal của người gọi (own/team/subtree/all — người tạo yêu cầu là "chủ").
   * Không truyền `user` = gọi nội bộ (webhook, IPN) ⇒ không lọc.
   */
  private async scopeWhere(user: AuthUser | undefined, perm: 'deals.view' | 'deals.manage'): Promise<Prisma.PaymentIntentWhereInput> {
    if (!user) return {};
    const ids = await this.scope.ownerIds(user, perm);
    if (ids === 'all') return {};
    return { created_by: { in: ids ?? [] } };
  }

  async create(input: CreatePaymentInput, userId: number | null): Promise<PaymentView> {
    const amount = Math.round(Number(input.amount));
    if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 10_000_000_000) throw new BadRequestException('Số tiền phải từ 1.000đ tới 10 tỷ.');
    const source_type = input.source_type ?? 'manual';
    if (!PAYMENT_SOURCE_TYPES.includes(source_type)) throw new BadRequestException('source_type không hợp lệ.');
    const hours = input.expires_in_hours == null ? null : Number(input.expires_in_hours);
    if (hours != null && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90)) throw new BadRequestException('Hạn thanh toán từ 1 giờ tới 90 ngày.');
    const sepay = await this.connectors.active<SepaySettings>('sepay');
    const prefix = sepay?.settings.code_prefix || DEFAULT_CODE_PREFIX;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const row = await this.prisma.paymentIntent.create({
          data: {
            code: newPaymentCode(prefix),
            amount: BigInt(amount),
            description: input.description?.trim().slice(0, 200) || null,
            source_type,
            source_id: input.source_id ?? null,
            contact_id: input.contact_id ?? null,
            expires_at: hours ? new Date(Date.now() + hours * 3_600_000) : null,
            created_by: userId,
          },
        });
        return this.view(row, sepay?.settings ?? null, await this.gateways());
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // trùng mã — sinh lại
        throw err;
      }
    }
    throw new BadRequestException('Không sinh được mã thanh toán, thử lại.');
  }

  async list(opts: { status?: string; limit?: number } = {}, user?: AuthUser): Promise<PaymentView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const now = new Date();
    // "quá hạn" không lưu trong DB — suy từ expires_at (đang chờ mà đã qua hạn).
    const byStatus: Prisma.PaymentIntentWhereInput =
      opts.status === 'expired' ? { status: 'pending', expires_at: { lt: now } }
      : opts.status === 'pending' ? { status: 'pending', OR: [{ expires_at: null }, { expires_at: { gte: now } }] }
      : opts.status ? { status: opts.status } : {};
    const rows = await this.prisma.paymentIntent.findMany({ where: { AND: [byStatus, await this.scopeWhere(user, 'deals.view')] }, orderBy: { id: 'desc' }, take: limit });
    const sepay = await this.connectors.active<SepaySettings>('sepay').catch(() => null);
    const gw = await this.gateways();
    return rows.map((r) => this.view(r, sepay?.settings ?? null, gw));
  }

  async get(id: number, user?: AuthUser): Promise<PaymentView> {
    const r = await this.prisma.paymentIntent.findFirst({ where: { id, ...(await this.scopeWhere(user, 'deals.view')) } });
    if (!r) throw new NotFoundException('Không có yêu cầu thanh toán này.');
    const sepay = await this.connectors.active<SepaySettings>('sepay').catch(() => null);
    return this.view(r, sepay?.settings ?? null, await this.gateways());
  }

  async cancel(id: number, user?: AuthUser): Promise<PaymentView> {
    const scoped = await this.scopeWhere(user, 'deals.manage');
    if (!(await this.prisma.paymentIntent.findFirst({ where: { id, ...scoped }, select: { id: true } }))) throw new NotFoundException('Không có yêu cầu thanh toán này.');
    const r = await this.prisma.paymentIntent.updateMany({ where: { id, status: 'pending', ...scoped }, data: { status: 'cancelled' } });
    if (!r.count) throw new BadRequestException('Chỉ huỷ được yêu cầu đang chờ thanh toán.');
    return this.get(id, user);
  }

  /** Giao dịch SePay đã xác thực → lưu (một lần) và khớp vào yêu cầu thanh toán. */
  async handleSepay(tx: SepayTransaction, prefix: string): Promise<SepayOutcome> {
    const base = {
      provider: 'sepay',
      external_id: String(tx.id),
      kind: tx.transferType === 'in' ? 'bank_in' : 'bank_out',
      amount: BigInt(tx.transferType === 'in' ? tx.transferAmount : -tx.transferAmount),
      content: tx.content.slice(0, 500) || null,
      reference: tx.referenceCode || null,
      occurred_at: sepayDate(tx.transactionDate),
      raw: tx as unknown as object,
    };
    let event: { id: number };
    try {
      event = await this.prisma.connectorEvent.create({ data: { ...base, status: 'unmatched' }, select: { id: true } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      // Đã nhận trước đó: xong rồi ⇒ bỏ; lần trước dở dang (lỗi giữa chừng, SePay gửi lại) ⇒ khớp tiếp.
      const prev = await this.prisma.connectorEvent.findUnique({ where: { provider_external_id: { provider: 'sepay', external_id: String(tx.id) } }, select: { id: true, status: true } });
      if (!prev || prev.status !== 'unmatched') return { status: 'duplicate' };
      event = { id: prev.id };
    }
    await this.connectors.touch('sepay');
    if (tx.transferType !== 'in') {
      await this.prisma.connectorEvent.update({ where: { id: event.id }, data: { status: 'ignored' } });
      return { status: 'ignored' };
    }
    // Khớp cả mã tạo dưới tiền tố cũ (đổi tiền tố khi còn yêu cầu đang chờ).
    const codes = findPaymentCodes(tx, await this.activePrefixes(prefix));
    if (!codes.length) return { status: 'unmatched' };
    const intent = await this.prisma.paymentIntent.findFirst({ where: { code: { in: codes }, status: { in: ['pending', 'expired'] } }, orderBy: { id: 'asc' } });
    if (!intent) return { status: 'unmatched' };
    if (BigInt(tx.transferAmount) < intent.amount) {
      await this.prisma.connectorEvent.update({ where: { id: event.id }, data: { payment_intent_id: intent.id } });
      return { status: 'underpaid', payment_intent_id: intent.id };
    }
    const ok = await this.markPaid(intent, BigInt(tx.transferAmount), 'sepay', event.id);
    if (!ok) await this.prisma.connectorEvent.update({ where: { id: event.id }, data: { payment_intent_id: intent.id } });
    return ok ? { status: 'matched', payment_intent_id: intent.id } : { status: 'unmatched' };
  }

  /** Đánh dấu đã thanh toán (chỉ khi còn chờ) + phát sự kiện `payment.received`. false = đã được xử lý trước đó. */
  async markPaid(intent: PaymentIntent, paid: bigint, via: string, eventId?: number): Promise<boolean> {
    const paid_at = new Date();
    // Một giao dịch: đánh dấu đã trả + ghi sự kiện cùng commit — không có trạng thái "đã trả mà mất sự kiện".
    return this.prisma.$transaction(async (db) => {
    const r = await db.paymentIntent.updateMany({
      where: { id: intent.id, status: { in: ['pending', 'expired'] } },
      data: { status: 'paid', paid_amount: paid, paid_via: via, paid_at },
    });
    if (!r.count) return false;
    // Đơn từ trang bán hàng online: tiền về ⇒ đơn chuyển "đã thanh toán" cùng commit.
    if (intent.source_type === 'store_order' && intent.source_id) {
      await db.storeOrder.updateMany({ where: { id: intent.source_id, status: { in: ['new', 'confirmed'] } }, data: { status: 'paid' } });
    }
    // Sự kiện cổng chốt "matched" cùng commit ⇒ không còn cảnh đã trả mà sự kiện kẹt "unmatched".
    if (eventId) await db.connectorEvent.update({ where: { id: eventId }, data: { status: 'matched', payment_intent_id: intent.id } });
    await publishIntegrationEvent(
      db,
      'payment.received',
      {
        payment_intent_id: intent.id, code: intent.code, amount: Number(intent.amount), paid_amount: Number(paid), paid_via: via,
        source_type: intent.source_type, source_id: intent.source_id, contact_id: intent.contact_id, paid_at: paid_at.toISOString(),
      },
      { resourceId: intent.id, actorUserId: intent.created_by },
    );
    return true;
    });
  }

  /**
   * Tiền tố đang dùng + tiền tố của các yêu cầu còn chờ (mã = tiền tố + 6 ký tự).
   * `::int` bắt buộc: Prisma gửi số dạng bigint, Postgres không có `left(varchar, bigint)` (đã gây 500 cho webhook SePay).
   */
  private async activePrefixes(current: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ p: string }[]>`
      SELECT DISTINCT left(code, length(code) - ${PAYMENT_CODE_BODY}::int) AS p FROM payment_intents WHERE status = 'pending' LIMIT 20`;
    return [...new Set([current, ...rows.map((r) => r.p).filter(Boolean)])];
  }

  private async gateways(): Promise<{ vnpay: boolean; momo: boolean }> {
    const [v, m] = await Promise.all([this.connectors.active('vnpay').catch(() => null), this.connectors.active('momo').catch(() => null)]);
    return { vnpay: !!v, momo: !!m };
  }

  private payLinks(r: PaymentIntent, g: { vnpay: boolean; momo: boolean }, expired: boolean): PaymentView['pay_links'] {
    const base = publicBaseUrl();
    if (!base || r.status !== 'pending' || expired) return {};
    return {
      ...(g.vnpay ? { vnpay: `${base}/api/v1/pay/${r.code}/vnpay` } : {}),
      ...(g.momo ? { momo: `${base}/api/v1/pay/${r.code}/momo` } : {}),
    };
  }

  /** Yêu cầu còn trả được (đang chờ, chưa quá hạn) theo mã — dùng cho link thanh toán công khai. */
  private async payable(code: string): Promise<PaymentIntent> {
    const r = await this.prisma.paymentIntent.findUnique({ where: { code: String(code ?? '').toUpperCase() } });
    if (!r) throw new NotFoundException('Không có yêu cầu thanh toán này.');
    if (r.status === 'paid') throw new BadRequestException('Yêu cầu này đã được thanh toán.');
    if (r.status !== 'pending' || (r.expires_at && r.expires_at.getTime() < Date.now())) throw new BadRequestException('Yêu cầu thanh toán đã huỷ hoặc quá hạn.');
    return r;
  }

  private base(): string {
    const b = publicBaseUrl();
    if (!b) throw new BadRequestException('Máy chủ chưa đặt INTEGRATIONS_PUBLIC_BASE_URL nên chưa tạo được link thanh toán.');
    return b;
  }

  /** Link sang VNPay cho yêu cầu `code` (mỗi lần mở một TxnRef mới — VNPay không nhận lại TxnRef cũ). */
  async vnpayRedirect(code: string, ip: string): Promise<string> {
    const r = await this.payable(code);
    const conn = await this.connectors.active<VnpaySettings>('vnpay');
    if (!conn) throw new BadRequestException('Chưa kết nối VNPay.');
    return vnpayPayUrl({
      tmnCode: conn.settings.tmn_code,
      secret: conn.credentials.hash_secret,
      sandbox: conn.settings.sandbox !== false,
      amount: Number(r.amount),
      txnRef: txnRefFor(r.code),
      orderInfo: `Thanh toan ${r.code}${r.description ? ` ${r.description}` : ''}`,
      returnUrl: `${this.base()}/api/v1/pay/vnpay/return`,
      ipAddr: ip,
    });
  }

  /** IPN VNPay (GET). Trả mã RspCode theo tài liệu; chỉ IPN mới đánh dấu đã trả (trang return chỉ hiển thị). */
  async handleVnpayIpn(q: Record<string, string>): Promise<{ RspCode: string; Message: string }> {
    const conn = await this.connectors.active<VnpaySettings>('vnpay');
    if (!conn || !verifyVnpay(q, conn.credentials.hash_secret)) return VNPAY_IPN.invalidSignature;
    const ref = String(q.vnp_TxnRef ?? '');
    const amount = Math.round(Number(q.vnp_Amount) / 100);
    const ok = q.vnp_ResponseCode === '00' && q.vnp_TransactionStatus === '00';
    const out = await this.recordGatewayEvent('vnpay', String(q.vnp_TransactionNo || ref), ref, amount, ok, q, codeFromTxnRef(ref), q.vnp_PayDate);
    return out.status === 'paid' || out.status === 'failed' ? VNPAY_IPN.ok
      : out.status === 'already_paid' || out.status === 'duplicate' ? VNPAY_IPN.alreadyConfirmed
      : out.status === 'not_found' ? VNPAY_IPN.notFound
      : out.status === 'invalid_amount' ? VNPAY_IPN.invalidAmount : VNPAY_IPN.unknown;
  }

  /** Trang return VNPay: chỉ kiểm chữ ký để hiện kết quả cho khách. */
  async vnpayReturn(q: Record<string, string>): Promise<{ ok: boolean; valid: boolean; code: string }> {
    const conn = await this.connectors.active<VnpaySettings>('vnpay');
    const valid = !!conn && verifyVnpay(q, conn.credentials.hash_secret);
    return { valid, ok: valid && q.vnp_ResponseCode === '00', code: codeFromTxnRef(String(q.vnp_TxnRef ?? '')) };
  }

  /** Tạo giao dịch MoMo (gọi API create) rồi trả payUrl để chuyển khách sang. */
  async momoRedirect(code: string, fetchFn: typeof fetch = fetch): Promise<string> {
    const r = await this.payable(code);
    const conn = await this.connectors.active<MomoSettings>('momo');
    if (!conn) throw new BadRequestException('Chưa kết nối MoMo.');
    const base = this.base();
    const orderId = txnRefFor(r.code);
    const body = momoCreateBody({
      partnerCode: conn.settings.partner_code,
      accessKey: conn.credentials.access_key,
      secretKey: conn.credentials.secret_key,
      amount: Number(r.amount),
      orderId,
      requestId: orderId,
      orderInfo: `Thanh toán ${r.code}${r.description ? ` — ${r.description}` : ''}`.slice(0, 200),
      redirectUrl: `${base}/api/v1/pay/momo/return`,
      ipnUrl: `${base}/api/v1/connectors/momo/ipn`,
    });
    const res = await fetchFn(conn.settings.sandbox !== false ? MOMO_URLS.sandbox : MOMO_URLS.production, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { resultCode?: number; message?: string; payUrl?: string };
    if (j.resultCode !== 0 || !j.payUrl) {
      await this.connectors.touch('momo', `MoMo từ chối tạo giao dịch: ${j.message ?? res.status}`);
      throw new BadRequestException(`MoMo chưa tạo được giao dịch: ${j.message ?? `HTTP ${res.status}`}`);
    }
    return j.payUrl;
  }

  /** IPN MoMo (POST JSON). true = chữ ký đúng (trả 204); false = sai chữ ký. */
  async handleMomoIpn(body: MomoResult): Promise<GatewayOutcome> {
    const conn = await this.connectors.active<MomoSettings>('momo');
    if (!conn || !verifyMomoResult(body, conn.credentials.access_key, conn.credentials.secret_key)) return { status: 'invalid_signature' };
    const ok = Number(body.resultCode) === 0;
    return this.recordGatewayEvent('momo', String(body.transId || body.orderId), String(body.orderId), Number(body.amount), ok, body as unknown as Record<string, unknown>, codeFromTxnRef(String(body.orderId)), null);
  }

  async momoReturn(q: Record<string, string>): Promise<{ ok: boolean; valid: boolean; code: string }> {
    const conn = await this.connectors.active<MomoSettings>('momo');
    const valid = !!conn && verifyMomoResult(q as unknown as MomoResult, conn.credentials.access_key, conn.credentials.secret_key);
    return { valid, ok: valid && Number(q.resultCode) === 0, code: codeFromTxnRef(String(q.orderId ?? '')) };
  }

  /** Lưu sự kiện cổng (một lần theo external_id) rồi đối chiếu số tiền và đánh dấu đã trả. */
  private async recordGatewayEvent(
    provider: 'vnpay' | 'momo', externalId: string, reference: string, amount: number, success: boolean,
    raw: Record<string, unknown>, code: string, payDate: string | null | undefined,
  ): Promise<GatewayOutcome> {
    const intent = await this.prisma.paymentIntent.findUnique({ where: { code } });
    let eventId: number;
    try {
      const e = await this.prisma.connectorEvent.create({
        data: {
          provider, external_id: externalId.slice(0, 100), kind: success ? 'payment' : 'payment_failed', amount: BigInt(Math.round(amount) || 0),
          content: null, reference: reference.slice(0, 100), status: 'unmatched', payment_intent_id: intent?.id ?? null, raw: raw as object,
          occurred_at: payDate && /^\d{14}$/.test(payDate) ? new Date(`${payDate.slice(0, 4)}-${payDate.slice(4, 6)}-${payDate.slice(6, 8)}T${payDate.slice(8, 10)}:${payDate.slice(10, 12)}:${payDate.slice(12, 14)}+07:00`) : new Date(),
        },
        select: { id: true },
      });
      eventId = e.id;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      const prev = await this.prisma.connectorEvent.findUnique({ where: { provider_external_id: { provider, external_id: externalId.slice(0, 100) } }, select: { id: true, status: true } });
      if (!prev || prev.status !== 'unmatched') return { status: 'duplicate' };
      eventId = prev.id; // lần trước dở dang ⇒ xử lý tiếp
    }
    await this.connectors.touch(provider);
    if (!intent) return { status: 'not_found' };
    if (BigInt(Math.round(amount)) !== intent.amount) return { status: 'invalid_amount' };
    if (intent.status === 'paid') {
      await this.prisma.connectorEvent.update({ where: { id: eventId }, data: { status: 'matched' } });
      return { status: 'already_paid' };
    }
    if (!success) {
      await this.prisma.connectorEvent.update({ where: { id: eventId }, data: { status: 'ignored' } });
      return { status: 'failed' };
    }
    const paid = await this.markPaid(intent, BigInt(Math.round(amount)), provider, eventId);
    if (!paid) await this.prisma.connectorEvent.update({ where: { id: eventId }, data: { status: 'matched' } });
    return { status: paid ? 'paid' : 'already_paid' };
  }

  view(r: PaymentIntent, sepay: SepaySettings | null, gateways: { vnpay: boolean; momo: boolean } = { vnpay: false, momo: false }): PaymentView {
    const expired = r.status === 'pending' && r.expires_at && r.expires_at.getTime() < Date.now();
    return {
      id: r.id,
      code: r.code,
      amount: Number(r.amount),
      description: r.description,
      status: expired ? 'expired' : r.status,
      source_type: r.source_type,
      source_id: r.source_id,
      contact_id: r.contact_id,
      paid_amount: r.paid_amount == null ? null : Number(r.paid_amount),
      paid_via: r.paid_via,
      paid_at: r.paid_at?.toISOString() ?? null,
      expires_at: r.expires_at?.toISOString() ?? null,
      created_at: r.created_at.toISOString(),
      transfer_content: r.code,
      qr_url: sepay && r.status === 'pending' ? sepayQrUrl({ accountNumber: sepay.account_number, bank: sepay.bank, amount: Number(r.amount), content: r.code }) : null,
      bank: sepay ? { account_number: sepay.account_number, bank: sepay.bank, account_name: sepay.account_name ?? null } : null,
      pay_links: this.payLinks(r, gateways, !!expired),
    };
  }
}
