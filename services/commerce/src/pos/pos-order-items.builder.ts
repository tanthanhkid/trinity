import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { OrderItemInputDto } from './dto/order.dto';
import { calcLineTotal, ModifierSnapshot } from './pos-money.util';

export interface BuiltItem {
  product_id: number;
  product_name: string;
  unit_price: number;
  quantity: number;
  options: ModifierSnapshot[];
  note: string | null;
  line_total: number;
}

/**
 * Dựng dòng đơn từ input client: tra GIÁ + TUỲ CHỌN từ DB (không tin client), snapshot tên/giá.
 * Chỉ bán sản phẩm đang bán (`is_active`) có giá và nằm trong menu cấu hình (`menu_category_ids`).
 */
/**
 * Khoá CHIA SẺ (`FOR SHARE`) các dòng `products` mà đơn sắp tham chiếu, TRONG CÙNG transaction ghi
 * `pos_order_items`. `DELETE /products/:id` khoá `FOR UPDATE` rồi đếm tham chiếu — 2 phía
 * loại trừ nhau: hoặc đơn ghi xong trước (xoá thấy tham chiếu → 409) hoặc xoá xong trước (đơn thấy
 * thiếu sản phẩm → 409 ở đây). Không có khoá này, `build()` (chạy NGOÀI transaction) xác nhận sản phẩm
 * còn, xoá cứng lọt vào giữa, đơn ghi dòng trỏ vào sản phẩm đã mất.
 */
export async function lockProductsForOrder(tx: Prisma.TransactionClient, items: BuiltItem[]): Promise<void> {
  const ids = [...new Set(items.map((i) => i.product_id))];
  if (ids.length === 0) return;
  const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM products WHERE id IN (${Prisma.join(ids)}) FOR SHARE`;
  if (rows.length !== ids.length) {
    throw new ConflictException('Có món vừa bị xoá khỏi danh mục sản phẩm — tải lại menu rồi tạo lại đơn');
  }
}

@Injectable()
export class PosOrderItemsBuilder {
  constructor(private readonly prisma: PrismaService) {}

  async build(items: OrderItemInputDto[], db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<BuiltItem[]> {
    const productIds = [...new Set(items.map((i) => i.product_id))];
    const modIds = [...new Set(items.flatMap((i) => i.modifier_ids ?? []))];
    const [products, mods, settings] = await Promise.all([
      db.product.findMany({
        where: { id: { in: productIds }, is_active: true, price: { not: null } },
        select: { id: true, name: true, price: true, category_id: true },
      }),
      modIds.length
        ? db.posModifier.findMany({ where: { id: { in: modIds }, is_active: true } })
        : Promise.resolve([]),
      db.posSettings.findUnique({ where: { id: 1 }, select: { menu_category_ids: true } }),
    ]);
    const menuCats = settings?.menu_category_ids ?? [];
    const pMap = new Map(products.map((p) => [p.id, p]));
    const mMap = new Map(mods.map((m) => [m.id, m]));
    return items.map((it) => {
      const p = pMap.get(it.product_id);
      if (!p || (menuCats.length > 0 && (p.category_id == null || !menuCats.includes(p.category_id)))) {
        throw new BadRequestException(`Món #${it.product_id} không tồn tại, đã ngừng bán hoặc không có trong menu POS`);
      }
      const options: ModifierSnapshot[] = (it.modifier_ids ?? []).map((id) => {
        const m = mMap.get(id);
        if (!m) throw new BadRequestException(`Tuỳ chọn #${id} không tồn tại hoặc đã tắt`);
        return { id: m.id, group_name: m.group_name, name: m.name, price_delta: Number(m.price_delta) };
      });
      const unit = Number(p.price);
      return {
        product_id: p.id, product_name: p.name, unit_price: unit, quantity: it.quantity, options,
        note: it.note?.trim() || null, line_total: calcLineTotal(unit, options, it.quantity),
      };
    });
  }
}
