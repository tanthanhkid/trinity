import { Prisma } from '@trinity/prisma';
import { num, numOrNull } from './pos-mapper';

export const ORDER_INCLUDE = {
  items: { orderBy: { id: 'asc' } },
  payments: { orderBy: { id: 'asc' } },
} satisfies Prisma.PosOrderInclude;

export type OrderWithRels = Prisma.PosOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export function toOrderDto(o: OrderWithRels) {
  return {
    id: o.id, code: o.code, shift_id: o.shift_id, table_id: o.table_id, order_type: o.order_type,
    status: o.status, note: o.note, subtotal: num(o.subtotal), discount_type: o.discount_type,
    discount_value: num(o.discount_value), discount_amount: num(o.discount_amount), total: num(o.total),
    created_by: o.created_by, created_at: o.created_at, paid_by: o.paid_by, paid_at: o.paid_at,
    voided_by: o.voided_by, voided_at: o.voided_at, void_reason: o.void_reason,
    items: o.items.map((i) => ({
      id: i.id, product_id: i.product_id, product_name: i.product_name, unit_price: num(i.unit_price),
      quantity: i.quantity, options: i.options, note: i.note, line_total: num(i.line_total),
    })),
    payments: o.payments.map((p) => ({
      id: p.id, method: p.method, amount: num(p.amount), tendered: numOrNull(p.tendered),
      change: num(p.change), reference: p.reference, shift_id: p.shift_id, created_at: p.created_at,
    })),
  };
}
