import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService, publishIntegrationEvent, snapshotPosOrder } from '@trinity/prisma';
import { can } from '@trinity/rbac';
// ScopeService PHẢI import THẬT (không type-only) — DI của NestJS cần giá trị lúc chạy.
import { ScopeService, scopeWhere } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { CreateOrderDto, ListOrdersQueryDto, PayOrderDto, UpdateOrderDto, VoidOrderDto } from './dto/order.dto';
import { DiscountType } from './pos.constants';
import { buildPaymentRows, calcTotals } from './pos-money.util';
import { BuiltItem, lockProductsForOrder, PosOrderItemsBuilder } from './pos-order-items.builder';
import { ORDER_INCLUDE, toOrderDto } from './pos-order.mapper';
import { todayVn } from './pos-mapper';
import { PosShiftsService } from './pos-shifts.service';

const itemData = (orderId: number, i: BuiltItem): Prisma.PosOrderItemCreateManyInput => ({
  order_id: orderId, product_id: i.product_id, product_name: i.product_name, unit_price: BigInt(i.unit_price),
  quantity: i.quantity, options: i.options as unknown as Prisma.InputJsonValue, note: i.note,
  line_total: BigInt(i.line_total),
});

@Injectable()
export class PosOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shifts: PosShiftsService,
    private readonly builder: PosOrderItemsBuilder,
    private readonly scope: ScopeService,
  ) {}

  async create(dto: CreateOrderDto, user: AuthUser) {
    const shift = await this.shifts.requireOpenShift(user.userId);
    const built = await this.builder.build(dto.items);
    const dType = (dto.discount_type ?? 'none') as DiscountType;
    const totals = calcTotals(built.map((b) => b.line_total), dType, dto.discount_value ?? 0);
    await this.assertTable(dto.table_id);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const id = await this.prisma.$transaction(async (tx) => {
          await lockProductsForOrder(tx, built);
          const order = await tx.posOrder.create({
            data: {
              code: await this.nextCode(tx, attempt), shift_id: shift.id, table_id: dto.table_id ?? null,
              order_type: dto.order_type ?? 'dine_in', note: dto.note || null, subtotal: BigInt(totals.subtotal),
              discount_type: dType, discount_value: BigInt(dType === 'none' ? 0 : dto.discount_value ?? 0),
              discount_amount: BigInt(totals.discount_amount), total: BigInt(totals.total), created_by: user.userId,
            },
          });
          await tx.posOrderItem.createMany({ data: built.map((b) => itemData(order.id, b)) });
          return order.id;
        });
        return this.getById(id, user);
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e; // trùng `code` (đơn đồng thời) → thử lại
      }
    }
    throw new ConflictException('Không sinh được mã đơn, thử lại');
  }

  private async nextCode(tx: Prisma.TransactionClient, attempt: number): Promise<string> {
    const ymd = todayVn().replace(/-/g, '');
    const last = await tx.posOrder.findFirst({
      where: { code: { startsWith: `${ymd}-` } }, orderBy: { code: 'desc' }, select: { code: true },
    });
    const n = (last ? parseInt(last.code.slice(9), 10) : 0) + 1 + attempt;
    return `${ymd}-${String(n).padStart(4, '0')}`;
  }

  private async assertTable(tableId?: number | null): Promise<void> {
    if (!tableId) return;
    const t = await this.prisma.posTable.findFirst({ where: { id: tableId, is_active: true }, select: { id: true } });
    if (!t) throw new BadRequestException('Bàn không tồn tại hoặc đã tắt');
  }

  /**
   * Đơn `open` là "sàn chung" (mọi người có `pos.sell` thấy); đơn đã thu/huỷ chỉ khi người tạo/thu
   * nằm trong phạm vi `pos.sell` của actor (own = chỉ mình; `all` = mọi đơn). Compose bằng AND (không spread).
   */
  private async visibleWhere(user: AuthUser): Promise<Prisma.PosOrderWhereInput> {
    const owner = (await this.scope.ownerIds(user, 'pos.sell')) ?? [];
    if (owner === 'all') return {};
    return { OR: [{ status: 'open' }, scopeWhere(owner, ['created_by', 'paid_by']) as Prisma.PosOrderWhereInput] };
  }

  async getById(id: number, user: AuthUser) {
    const o = await this.prisma.posOrder.findFirst({
      where: { AND: [{ id }, await this.visibleWhere(user)] }, include: ORDER_INCLUDE,
    });
    if (!o) throw new NotFoundException('Không tìm thấy đơn');
    return toOrderDto(o);
  }

  async list(q: ListOrdersQueryDto, user: AuthUser) {
    const take = q.limit ?? 50;
    const where: Prisma.PosOrderWhereInput = {
      AND: [
        await this.visibleWhere(user),
        q.status ? { status: q.status } : {},
        q.table_id ? { table_id: q.table_id } : {},
        q.shift_id ? { shift_id: q.shift_id } : {},
        q.cursor ? { id: { lt: q.cursor } } : {},
      ],
    };
    const rows = await this.prisma.posOrder.findMany({ where, include: ORDER_INCLUDE, orderBy: { id: 'desc' }, take: take + 1 });
    const page = rows.slice(0, take);
    return { data: page.map(toOrderDto), next_cursor: rows.length > take ? page[page.length - 1].id : null };
  }

  async update(id: number, dto: UpdateOrderDto, user: AuthUser) {
    const cur = await this.prisma.posOrder.findUnique({ where: { id }, include: { items: true } });
    if (!cur) throw new NotFoundException('Không tìm thấy đơn');
    if (cur.status !== 'open') throw new ConflictException('Chỉ sửa được đơn đang mở');
    if (dto.table_id !== undefined) await this.assertTable(dto.table_id);
    const built = dto.items ? await this.builder.build(dto.items) : null;
    const lines = built ? built.map((b) => b.line_total) : cur.items.map((i) => Number(i.line_total));
    const dType = (dto.discount_type ?? cur.discount_type) as DiscountType;
    const dValue = dto.discount_value ?? Number(cur.discount_value);
    const totals = calcTotals(lines, dType, dType === 'none' ? 0 : dValue);
    await this.prisma.$transaction(async (tx) => {
      // Guard: chỉ ghi khi đơn CÒN `open` (chống sửa đè đơn vừa được thu ở máy khác).
      const res = await tx.posOrder.updateMany({
        where: { id, status: 'open' },
        data: {
          ...(dto.table_id !== undefined ? { table_id: dto.table_id } : {}),
          ...(dto.order_type ? { order_type: dto.order_type } : {}),
          ...(dto.note !== undefined ? { note: dto.note || null } : {}),
          subtotal: BigInt(totals.subtotal), discount_type: dType,
          discount_value: BigInt(dType === 'none' ? 0 : dValue),
          discount_amount: BigInt(totals.discount_amount), total: BigInt(totals.total),
        },
      });
      if (res.count !== 1) throw new ConflictException('Đơn không còn ở trạng thái mở');
      if (built) {
        await lockProductsForOrder(tx, built);
        await tx.posOrderItem.deleteMany({ where: { order_id: id } });
        await tx.posOrderItem.createMany({ data: built.map((b) => itemData(id, b)) });
      }
    });
    return this.getById(id, user);
  }

  async pay(id: number, dto: PayOrderDto, user: AuthUser) {
    const shift = await this.shifts.requireOpenShift(user.userId);
    await this.prisma.$transaction(async (tx) => {
      const order = await tx.posOrder.findUnique({ where: { id }, select: { total: true, status: true } });
      if (!order) throw new NotFoundException('Không tìm thấy đơn');
      if (order.status !== 'open') throw new ConflictException('Đơn đã được thanh toán hoặc đã huỷ');
      const rows = buildPaymentRows(dto.payments, Number(order.total)); // tổng lấy từ DB, không từ client
      const res = await tx.posOrder.updateMany({
        // Guard chống thu đôi + chống sửa đơn (đổi tổng) chen giữa lúc đọc `total` và lúc ghi.
        where: { id, status: 'open', total: order.total },
        data: { status: 'paid', paid_by: user.userId, paid_at: new Date() },
      });
      if (res.count !== 1) throw new ConflictException('Đơn đã được thanh toán, huỷ hoặc vừa bị sửa — tải lại rồi thử lại');
      if (rows.length) {
        await tx.posPayment.createMany({
          data: rows.map((r) => ({
            order_id: id, shift_id: shift.id, method: r.method, amount: BigInt(r.amount),
            tendered: r.tendered == null ? null : BigInt(r.tendered), change: BigInt(r.change),
            reference: r.reference, created_by: user.userId,
          })),
        });
      }
      // outbox `pos.order.completed` CÙNG transaction với việc chuyển đơn sang `paid` — rollback (409
      // thu đôi, lỗi ghi payment…) thì không bắn sự kiện ảo. Đọc lại đơn SAU khi ghi để payload có payments.
      const paid = await tx.posOrder.findUniqueOrThrow({
        where: { id },
        include: { items: true, payments: true },
      });
      await publishIntegrationEvent(
        tx,
        'pos.order.completed',
        { order: snapshotPosOrder(paid) },
        { resourceId: id, actorUserId: user.userId },
      );
    });
    return this.getById(id, user);
  }

  /** Huỷ đơn `open`: mọi người có `pos.sell`. Huỷ đơn ĐÃ THU: cần `pos.manage` (tiền không còn tính vào doanh thu/đối soát ca). */
  async voidOrder(id: number, dto: VoidOrderDto, user: AuthUser) {
    const cur = await this.prisma.posOrder.findFirst({
      where: { AND: [{ id }, await this.visibleWhere(user)] }, select: { status: true },
    });
    if (!cur) throw new NotFoundException('Không tìm thấy đơn');
    if (cur.status === 'void') throw new ConflictException('Đơn đã huỷ');
    if (cur.status === 'paid' && !can(user.grants, 'pos.manage')) {
      throw new ForbiddenException('Cần quyền quản lý POS (pos.manage) để huỷ đơn đã thu tiền');
    }
    const res = await this.prisma.posOrder.updateMany({
      where: { id, status: cur.status },
      data: { status: 'void', voided_by: user.userId, voided_at: new Date(), void_reason: dto.reason },
    });
    if (res.count !== 1) throw new ConflictException('Trạng thái đơn vừa thay đổi, tải lại');
    return this.getById(id, user);
  }
}
