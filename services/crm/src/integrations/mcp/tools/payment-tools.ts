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
    'Các yêu cầu thanh toán đã tạo trước đây (Trinity không tạo yêu cầu mới nữa) và trạng thái đối soát: pending = chờ khách chuyển, paid = đã nhận đủ tiền (Trinity tự khớp tiền chuyển khoản qua SePay), cancelled = đã huỷ, expired = quá hạn. ' +
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

/**
 * Chỉ còn tool ĐỌC (G07a #105: Trinity ngừng tạo yêu cầu thanh toán mới; `create_payment_request` đã gỡ). Giữ tới G07b
 * để trợ lý vẫn xem được yêu cầu cũ đã được đối soát tới đâu.
 */
export const PAYMENT_TOOLS: readonly ToolDef[] = [listPaymentRequestsTool];
