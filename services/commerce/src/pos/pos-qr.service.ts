import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { buildVietQr } from './vietqr.util';

/** Dựng chuỗi VietQR cho 1 đơn (số tiền = tổng đơn TRONG DB). Không gọi API ngân hàng. */
@Injectable()
export class PosQrService {
  constructor(private readonly prisma: PrismaService) {}

  async forOrder(id: number, _user: AuthUser, requestedAmount?: number) {
    const [order, settings] = await Promise.all([
      this.prisma.posOrder.findUnique({ where: { id }, select: { code: true, total: true, status: true } }),
      this.prisma.posSettings.findUnique({ where: { id: 1 } }),
    ]);
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== 'open') throw new BadRequestException('Chỉ tạo QR cho đơn đang mở');
    if (!settings?.bank_bin || !settings.bank_account_no) {
      throw new BadRequestException('Chưa cấu hình tài khoản nhận tiền (Cài đặt POS > Ngân hàng)');
    }
    const total = Number(order.total);
    const amount = requestedAmount ?? total;
    if (amount < 1 || amount > total) throw new BadRequestException('Số tiền QR phải trong khoảng 1 → tổng đơn');
    const content = `HD${order.code.replace('-', '')}`;
    return {
      payload: buildVietQr({ bin: settings.bank_bin, accountNo: settings.bank_account_no, amount, message: content }),
      amount, content, bank_bin: settings.bank_bin, account_no: settings.bank_account_no,
      account_name: settings.bank_account_name,
    };
  }
}
