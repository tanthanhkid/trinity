import { BadRequestException } from '@nestjs/common';
import { wrapData } from '../ai-output';
import { vnWhen } from '../actions/action-social-tools';
import type { PaymentView } from '../../../connectors/payments.service';
import { ToolUserError, type McpDeps, type ToolDef } from './tool-types';

async function paymentsDeps(deps: Pick<McpDeps, 'payments' | 'orgFeatures'>) {
  if (!deps.payments) throw new ToolUserError('Máy chủ này chưa có tính năng thanh toán. / Payments are not available on this server.');
  if (!(await deps.orgFeatures.isEnabled('payments'))) {
    throw new ToolUserError('Tính năng "Thanh toán & đối soát" đang tắt (Cài đặt › Tính năng). / The Payments feature is turned off for this workspace.');
  }
  return deps.payments;
}

const MANAGE = '/connections?muc=payments';
const STATUS_VI: Record<string, string> = { pending: 'chờ thanh toán', paid: 'đã thanh toán', cancelled: 'đã huỷ', expired: 'quá hạn' };

function paymentForAi(p: PaymentView) {
  return {
    payment_id: p.id,
    code: p.code,
    amount: p.amount,
    description: p.description,
    status: p.status,
    status_text: STATUS_VI[p.status] ?? p.status,
    paid_amount: p.paid_amount,
    paid_via: p.paid_via,
    paid_at: p.paid_at ? vnWhen(new Date(p.paid_at)) : null,
    expires_at: p.expires_at ? vnWhen(new Date(p.expires_at)) : null,
    source: p.source_type === 'manual' ? null : { type: p.source_type, id: p.source_id },
    contact_id: p.contact_id,
    transfer_content: p.transfer_content,
    bank: p.bank,
    qr_image_url: p.qr_url,
    /** Link gửi khách để trả qua VNPay / MoMo (chỉ có khi cổng đã nối). */
    pay_links: p.pay_links,
  };
}

export const listPaymentRequestsTool: ToolDef = {
  name: 'list_payment_requests',
  title: 'Các yêu cầu thanh toán / List payment requests',
  description:
    'Các yêu cầu thanh toán đã tạo và trạng thái: pending = chờ khách chuyển, paid = đã nhận đủ tiền (Trinity tự khớp tiền chuyển khoản qua SePay), cancelled = đã huỷ, expired = quá hạn. ' +
    'Lọc status tuỳ chọn. Chỉ đọc. / Payment requests with status (pending, paid — auto-matched from bank transfers, cancelled, expired). Read-only.',
  permissions: ['deals.view'],
  input: (z) => ({
    status: z.enum(['pending', 'paid', 'cancelled', 'expired']).optional().describe('Lọc theo trạng thái / Filter by status'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const svc = await paymentsDeps(deps);
    const status = typeof args.status === 'string' ? args.status : undefined;
    const rows = await svc.list({ limit: 30, status }, principal.user);
    const out = wrapData({ payments: rows.slice(0, 30).map(paymentForAi), manage_url: `${baseUrl}${MANAGE}` });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const createPaymentRequestTool: ToolDef = {
  name: 'create_payment_request',
  title: 'Tạo yêu cầu thanh toán / Create payment request',
  description:
    'Tạo yêu cầu thanh toán chuyển khoản: Trinity sinh một mã (vd TRN7K2QXM) để khách ghi vào nội dung chuyển khoản; khi tiền về tài khoản đã nối SePay, Trinity tự đánh dấu đã thanh toán. ' +
    'Cần: amount (VND, ≥ 1.000). Tuỳ chọn: description (vd "Học phí tháng 11"), deal_id hoặc contact_id để gắn, expires_in_hours. ' +
    'Trả về transfer_content (nội dung khách phải ghi), bank (tài khoản nhận), qr_image_url (ảnh QR quét là điền sẵn số tiền + nội dung; null khi chưa nối SePay) và pay_links (link trả qua VNPay / MoMo khi đã nối cổng). Không gửi gì cho khách — đưa thông tin này cho người dùng tự gửi. Cần scope crm.write. / ' +
    'Creates a bank-transfer payment request with a unique code and VietQR image; payment is auto-matched when the money arrives (SePay). Does not message the customer.',
  permissions: ['deals.manage'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    amount: z.number().int().min(1000).max(10_000_000_000).describe('Số tiền VND / Amount in VND'),
    description: z.string().max(200).optional().describe('Ghi chú, vd "Học phí tháng 11 — bé An" / Note'),
    deal_id: z.number().int().min(1).max(2_147_483_647).optional().describe('Gắn với deal / Link to a deal'),
    contact_id: z.number().int().min(1).max(2_147_483_647).optional().describe('Gắn với khách / Link to a contact'),
    expires_in_hours: z.number().min(1).max(24 * 90).optional().describe('Hạn thanh toán (giờ) / Expiry in hours'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const svc = await paymentsDeps(deps);
    try {
      const dealId = typeof args.deal_id === 'number' ? args.deal_id : null;
      const p = await svc.create(
        {
          amount: Number(args.amount),
          description: typeof args.description === 'string' ? args.description : null,
          source_type: dealId ? 'deal' : 'manual',
          source_id: dealId,
          contact_id: typeof args.contact_id === 'number' ? args.contact_id : null,
          expires_in_hours: typeof args.expires_in_hours === 'number' ? args.expires_in_hours : null,
        },
        principal.user.userId,
      );
      const out = wrapData({
        created: true,
        ...paymentForAi(p),
        next_step: p.qr_url
          ? 'Đưa người dùng mã QR (qr_image_url) và nội dung chuyển khoản để gửi khách' + (p.pay_links.vnpay || p.pay_links.momo ? ', kèm link VNPay/MoMo (pay_links) nếu khách muốn trả bằng thẻ/ví' : '') + '. Tiền về là Trinity tự đánh dấu đã thanh toán; kiểm lại bằng list_payment_requests.'
          : p.pay_links.vnpay || p.pay_links.momo
            ? 'Đưa người dùng link thanh toán (pay_links) để gửi khách — khách trả qua VNPay/MoMo xong là Trinity tự đánh dấu đã thanh toán; kiểm lại bằng list_payment_requests.'
            : 'Chưa nối cổng nào nên chưa có QR/link và chưa tự khớp tiền: người dùng cần vào Cài đặt › Kết nối & AI › Thanh toán để nối SePay, VNPay hoặc MoMo.',
        manage_url: `${baseUrl}${MANAGE}`,
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      if (err instanceof BadRequestException) throw new ToolUserError(err.message);
      throw err;
    }
  },
};

export const PAYMENT_TOOLS: readonly ToolDef[] = [listPaymentRequestsTool, createPaymentRequestTool];
