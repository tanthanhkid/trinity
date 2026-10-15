import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { num, todayVn, vnDayRange } from './pos-mapper';

@Injectable()
export class PosReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Báo cáo doanh thu 1 ngày (giờ VN) theo `paid_at`, chỉ đơn `paid`.
   * ⚠️ `by_product.revenue` = Σ thành tiền dòng (TRƯỚC giảm giá cấp đơn); `revenue` toàn đơn là SAU giảm giá.
   * Quần thể 1 ngày của 1 quán nhỏ (≤ vài nghìn đơn) — mọi truy vấn là aggregate ở DB, không kéo dòng thô về.
   */
  async daily(date?: string) {
    const day = date ?? todayVn();
    if (Number.isNaN(new Date(`${day}T00:00:00+07:00`).getTime())) throw new BadRequestException('Ngày không hợp lệ');
    const { from, to } = vnDayRange(day);
    const paidWhere = { status: 'paid', paid_at: { gte: from, lt: to } };
    const [agg, methods, products, hours] = await Promise.all([
      this.prisma.posOrder.aggregate({
        where: paidWhere, _count: { _all: true }, _sum: { total: true, subtotal: true, discount_amount: true },
      }),
      this.prisma.posPayment.groupBy({ by: ['method'], where: { order: paidWhere }, _sum: { amount: true } }),
      this.prisma.posOrderItem.groupBy({
        by: ['product_id', 'product_name'], where: { order: paidWhere },
        _sum: { quantity: true, line_total: true }, orderBy: { _sum: { line_total: 'desc' } }, take: 50,
      }),
      this.prisma.$queryRaw<Array<{ hour: number; orders: number; revenue: bigint }>>`
        SELECT EXTRACT(HOUR FROM paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS hour,
               COUNT(*)::int AS orders, COALESCE(SUM(total), 0)::bigint AS revenue
        FROM pos_orders WHERE status = 'paid' AND paid_at >= ${from} AND paid_at < ${to}
        GROUP BY 1 ORDER BY 1`,
    ]);
    const orderCount = agg._count._all;
    const revenue = num(agg._sum.total);
    return {
      date: day, order_count: orderCount, revenue, subtotal: num(agg._sum.subtotal),
      discount: num(agg._sum.discount_amount), avg_order_value: orderCount ? Math.floor(revenue / orderCount) : 0,
      by_method: methods.map((m) => ({ method: m.method, amount: num(m._sum.amount) })),
      by_product: products.map((p) => ({
        product_id: p.product_id, product_name: p.product_name, quantity: num(p._sum.quantity), revenue: num(p._sum.line_total),
      })),
      by_hour: hours.map((h) => ({ hour: h.hour, orders: h.orders, revenue: num(h.revenue) })),
      by_product_truncated: products.length === 50,
    };
  }
}
