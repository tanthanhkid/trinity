import { Injectable } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { MenuQueryDto, UpdateSettingsDto } from './dto/shift-catalog.dto';

/** Cấu hình quán + menu (đọc từ `products`/`product_categories` — POS không có bảng món riêng). */
@Injectable()
export class PosCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  getSettings() {
    // Migration đã seed dòng id=1; upsert phòng khi env dựng bằng `db push`.
    return this.prisma.posSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  }

  async updateSettings(dto: UpdateSettingsDto) {
    const data: Prisma.PosSettingsUpdateInput = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v !== undefined) (data as Record<string, unknown>)[k] = v === '' ? null : v;
    }
    return this.prisma.posSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...(data as object) } });
  }

  /**
   * Menu: sản phẩm đang bán có giá (+ lọc danh mục menu POS nếu cấu hình). Bảng NHỎ (cỡ trăm món)
   * nên KHÔNG đặt `take` — cùng lập luận `ProductsService.findAll` (cap + sort ASC từng cắt im lặng).
   */
  async menu(q: MenuQueryDto) {
    const settings = await this.getSettings();
    const cats = settings.menu_category_ids;
    const catWhere: Prisma.ProductCategoryWhereInput = { is_active: true, ...(cats.length ? { id: { in: cats } } : {}) };
    const [categories, products] = await Promise.all([
      this.prisma.productCategory.findMany({
        where: catWhere, select: { id: true, code: true, name: true }, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.product.findMany({
        where: {
          is_active: true, price: { not: null },
          // Lọc theo danh mục không được vượt ra ngoài danh mục menu đã cấu hình.
          ...(q.category_id
            ? { category_id: cats.length && !cats.includes(q.category_id) ? { in: [] as number[] } : q.category_id }
            : cats.length
              ? { category_id: { in: cats } }
              : {}),
          ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { code: { contains: q.q, mode: 'insensitive' } }] } : {}),
        },
        select: { id: true, code: true, name: true, price: true, image_url: true, category_id: true },
        orderBy: [{ is_featured: 'desc' }, { name: 'asc' }],
      }),
    ]);
    return {
      categories,
      products: products.map((p) => ({ ...p, price: Number(p.price) })),
    };
  }
}
