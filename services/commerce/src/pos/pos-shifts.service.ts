import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
// ScopeService PHẢI import THẬT (không type-only) — DI của NestJS cần giá trị lúc chạy.
import { ScopeService, assertInScope, scopeWhere } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { CloseShiftDto, ListShiftsQueryDto, OpenShiftDto } from './dto/shift-catalog.dto';
import { num, numOrNull } from './pos-mapper';

type ShiftRow = Prisma.PosShiftGetPayload<object>;

export function toShiftDto(s: ShiftRow) {
  return {
    id: s.id, opened_by: s.opened_by, opened_at: s.opened_at, status: s.status,
    opening_cash: num(s.opening_cash), closed_by: s.closed_by, closed_at: s.closed_at,
    closing_cash_counted: numOrNull(s.closing_cash_counted),
    expected_cash: numOrNull(s.expected_cash), cash_diff: numOrNull(s.cash_diff), note: s.note,
  };
}

@Injectable()
export class PosShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** Ca đang mở của user, hoặc null. Dùng chung cho tạo/thu đơn. */
  findOpenShift(userId: number, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    return db.posShift.findFirst({ where: { opened_by: userId, status: 'open' } });
  }

  async requireOpenShift(userId: number, db?: Prisma.TransactionClient) {
    const shift = await this.findOpenShift(userId, db);
    if (!shift) throw new BadRequestException('Chưa mở ca. Hãy mở ca (nhập tiền đầu ca) trước khi bán hàng.');
    return shift;
  }

  async open(dto: OpenShiftDto, user: AuthUser) {
    try {
      const shift = await this.prisma.posShift.create({
        data: { opened_by: user.userId, opening_cash: BigInt(dto.opening_cash) },
      });
      return toShiftDto(shift);
    } catch (e) {
      // Unique từng phần `pos_shifts_one_open_per_user` — 2 request mở ca đồng thời.
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('Bạn đang có một ca mở');
      throw e;
    }
  }

  async current(user: AuthUser) {
    const shift = await this.findOpenShift(user.userId);
    if (!shift) return { shift: null, summary: null };
    return { shift: toShiftDto(shift), summary: await this.summarize(shift) };
  }

  async list(query: ListShiftsQueryDto, user: AuthUser) {
    const take = query.limit ?? 30;
    // Phạm vi `pos.sell`: own = ca của mình; team/subtree/all = thêm ca của người trong phạm vi.
    const owner = (await this.scope.ownerIds(user, 'pos.sell')) ?? [];
    const rows = await this.prisma.posShift.findMany({
      where: {
        AND: [
          scopeWhere(owner, ['opened_by']) as Prisma.PosShiftWhereInput,
          query.cursor ? { id: { lt: query.cursor } } : {},
        ],
      },
      orderBy: { id: 'desc' },
      take: take + 1,
    });
    const page = rows.slice(0, take);
    return { data: page.map(toShiftDto), next_cursor: rows.length > take ? page[page.length - 1].id : null };
  }

  async getOwned(id: number, user: AuthUser) {
    const shift = await this.prisma.posShift.findUnique({ where: { id } });
    if (!shift) throw new NotFoundException('Không tìm thấy ca');
    // Ngoài phạm vi `pos.sell` → 404 (không 403) để không xác nhận id tồn tại.
    await assertInScope(this.scope, user, 'pos.sell', [shift.opened_by]);
    return shift;
  }

  async summary(id: number, user: AuthUser) {
    const shift = await this.getOwned(id, user);
    return { shift: toShiftDto(shift), summary: await this.summarize(shift) };
  }

  /** Tiền theo phương thức của các đơn ĐÃ THU (loại đơn huỷ) + số đơn. */
  async summarize(shift: ShiftRow) {
    const [byMethod, paidOrders, voidOrders] = await Promise.all([
      this.prisma.posPayment.groupBy({
        by: ['method'], where: { shift_id: shift.id, order: { status: 'paid' } }, _sum: { amount: true },
      }),
      this.prisma.posOrder.count({ where: { status: 'paid', payments: { some: { shift_id: shift.id } } } }),
      this.prisma.posOrder.count({ where: { status: 'void', shift_id: shift.id } }),
    ]);
    const sum = (m: string) => num(byMethod.find((r) => r.method === m)?._sum.amount);
    const cash = sum('cash');
    return {
      paid_orders: paidOrders, void_orders: voidOrders,
      cash_sales: cash, transfer_sales: sum('bank_transfer'),
      expected_cash: num(shift.opening_cash) + cash,
    };
  }

  async close(id: number, dto: CloseShiftDto, user: AuthUser) {
    const shift = await this.getOwned(id, user);
    if (shift.status !== 'open') throw new ConflictException('Ca đã đóng');
    const openOrders = await this.prisma.posOrder.count({ where: { shift_id: id, status: 'open' } });
    if (openOrders > 0) {
      throw new BadRequestException(`Còn ${openOrders} đơn chưa thanh toán trong ca. Thu tiền hoặc huỷ trước khi đóng ca.`);
    }
    const { expected_cash } = await this.summarize(shift);
    const res = await this.prisma.posShift.updateMany({
      where: { id, status: 'open' }, // guard chống đóng đôi
      data: {
        status: 'closed', closed_by: user.userId, closed_at: new Date(),
        closing_cash_counted: BigInt(dto.closing_cash_counted), expected_cash: BigInt(expected_cash),
        cash_diff: BigInt(dto.closing_cash_counted - expected_cash), note: dto.note ?? null,
      },
    });
    if (res.count !== 1) throw new ConflictException('Ca đã đóng');
    return this.summary(id, user);
  }
}
