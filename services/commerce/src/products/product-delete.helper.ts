import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@trinity/prisma';

/**
 * Xoá CỨNG sản phẩm — CHỈ khi không còn dữ liệu nghiệp vụ nào trỏ tới.
 *
 * Các tham chiếu là SOFT-FK (không có ràng buộc DB), nên DB KHÔNG tự chặn: toàn bộ an toàn nằm ở đây.
 *  - `pos_order_items.product_id` — mọi trạng thái đơn (mở/đã thu/huỷ): đơn đã thu là sổ sách, đơn mở
 *    đang bán dở; cả hai đều không được mất sản phẩm gốc.
 *  - `contacts.product_id` — liên hệ gắn sản phẩm quan tâm.
 * Dữ liệu CON thuộc riêng sản phẩm (giá trị thuộc tính `attributes`, tags...) nằm ngay trên dòng
 * `products` nên đi cùng dòng; danh mục/định nghĩa thuộc tính KHÔNG thuộc sản phẩm (không đụng).
 *
 * Chống race với tạo/sửa đơn POS: khoá `FOR UPDATE` dòng sản phẩm TRƯỚC khi đếm; phía POS khoá
 * `FOR SHARE` cùng dòng trong transaction ghi dòng đơn (`lockProductsForOrder`).
 */
export async function hardDeleteProduct(
  tx: Prisma.TransactionClient,
  id: number,
): Promise<{ image_url: string | null }> {
  const locked = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundException('Sản phẩm không tồn tại');

  const orders = await tx.$queryRaw<{ n: number }[]>`
    SELECT COUNT(DISTINCT order_id)::int AS n FROM pos_order_items WHERE product_id = ${id}`;
  const orderCount = orders[0]?.n ?? 0;
  const contactCount = await tx.contact.count({ where: { product_id: id } });

  const reasons: string[] = [];
  if (orderCount > 0) reasons.push(`${orderCount} đơn bán hàng`);
  if (contactCount > 0) reasons.push(`${contactCount} liên hệ`);
  if (reasons.length > 0) {
    throw new ConflictException(
      `Sản phẩm đã có trong ${reasons.join(' và ')} — không thể xoá hẳn, chỉ có thể ẩn`,
    );
  }

  const row = await tx.product.findUnique({ where: { id }, select: { image_url: true } });
  await tx.product.delete({ where: { id } });
  return { image_url: row?.image_url ?? null };
}
