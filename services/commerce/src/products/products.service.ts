import { Injectable, BadRequestException, ConflictException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@trinity/rbac-nest';
// Commerce service không có `@prisma/client` trực tiếp trong package.json (chỉ CRM có)
// → import Prisma namespace qua re-export `@trinity/prisma`, mirror `ProjectsService`.
import { Prisma, PrismaService } from '@trinity/prisma';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { PRODUCT_SELECT, ProductDto, ProductRow, toProductDto } from './product.mapper';
import {
  buildListWhere,
  buildWritableData,
  ProductWritableData,
  rethrowProductWriteError,
} from './product-write.helper';
import { ProductAttributeDefsService } from './attribute-defs/product-attribute-defs.service';
import { hardDeleteProduct } from './product-delete.helper';
import { deleteProductImageFile } from './product-image-upload.helper';
import { validateProductAttributes } from './product-attributes.validator';

/** Cửa sổ Hoàn tác phía máy chủ (toast trên web chỉ 5 giây; để dư cho mạng chậm), giống khách hàng / card. */
export const RESTORE_WINDOW_MS = 10 * 60 * 1000;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attributeDefsService: ProductAttributeDefsService,
  ) {}

  /**
   * Danh mục sản phẩm. Sort `is_featured DESC, id ASC` (theme xếp sản phẩm nổi bật
   * lên đầu, còn lại theo thứ tự nhập).
   *
   * CỐ Ý KHÔNG có `take`/cursor: danh mục là bảng NHỎ (cỡ chục dòng, 1 dự án : N sản phẩm). Thêm cap kèm sort ASC chính là công thức cắt
   * im lặng dữ liệu mới; không đặt cap thì không có gì để cắt. Nếu về sau
   * danh mục phình tới cỡ nghìn thì phải phân trang cursor + sort DESC, KHÔNG chỉ
   * dán `take` vào query này.
   */
  async findAll(query: ListProductsQueryDto): Promise<ProductDto[]> {
    const rows = await this.prisma.product.findMany({
      where: buildListWhere(query),
      select: PRODUCT_SELECT,
      orderBy: [{ is_featured: 'desc' }, { id: 'asc' }],
    });
    return rows.map((r) => toProductDto(r as ProductRow));
  }

  async findOne(id: number): Promise<ProductDto> {
    // Sản phẩm đã xoá (lưu trữ) coi như không tồn tại với mọi đường đọc/sửa thường.
    const product = await this.prisma.product.findUnique({
      where: { id },
      select: { ...PRODUCT_SELECT, deleted_at: true },
    });
    if (!product || product.deleted_at) throw new NotFoundException('Sản phẩm không tồn tại');
    return toProductDto(product as ProductRow);
  }

  async create(dto: CreateProductDto, userId: number): Promise<ProductDto> {
    if (dto.project_id != null) await this.assertProjectUsable(dto.project_id);
    await this.assertCodeAvailable(dto.code);
    const attributes = await this.resolveAttributes(dto.category_id ?? null, dto.attributes);
    try {
      const product = await this.prisma.product.create({
        data: {
          ...buildWritableData(dto),
          // 3 field chỉ có ở đường TẠO: `name` bắt buộc (buildWritableData khai
          // optional vì dùng chung với update), `code`/`project_id` immutable
          // — `project_id` set THẲNG ở đây (KHÔNG qua buildWritableData, xem
          // docblock hàm đó) để `update()` không có đường nào ghi được field này.
          name: dto.name,
          code: dto.code,
          project_id: dto.project_id ?? null,
          attributes: attributes as Prisma.InputJsonValue,
          created_by: userId,
        },
        select: PRODUCT_SELECT,
      });
      return toProductDto(product as ProductRow);
    } catch (err) {
      rethrowProductWriteError(err, dto.code);
    }
  }

  /** `code`/`project_id` KHÔNG có trong `UpdateProductDto` — xem doc-comment ở DTO. */
  async update(id: number, dto: UpdateProductDto): Promise<ProductDto> {
    const existing = await this.findOne(id); // 404 nếu không tồn tại
    const data: ProductWritableData = buildWritableData(dto);
    if (dto.category_id !== undefined || dto.attributes !== undefined) {
      const effectiveCategoryId = dto.category_id !== undefined ? dto.category_id : existing.category_id;
      const effectiveAttributesInput =
        dto.attributes !== undefined ? dto.attributes : existing.attributes;
      data.attributes = (await this.resolveAttributes(
        effectiveCategoryId,
        effectiveAttributesInput,
      )) as Prisma.InputJsonValue;
    }
    const product = await this.prisma.product.update({
      where: { id },
      data,
      select: PRODUCT_SELECT,
    });
    return toProductDto(product as ProductRow);
  }

  /**
   * Ẩn sản phẩm (`is_active=false`, bật lại được, không mất dữ liệu) — đường PATCH `is_active`
   * của FE cũng đi qua `update()`; hàm này giữ cho các nơi gọi trực tiếp.
   */
  async hide(id: number): Promise<ProductDto> {
    await this.findOne(id);
    const product = await this.prisma.product.update({
      where: { id },
      data: { is_active: false },
      select: PRODUCT_SELECT,
    });
    return toProductDto(product as ProductRow);
  }

  /**
   * Xoá = LƯU TRỮ (xoá mềm): sản phẩm biến khỏi danh mục, POS, trang bán hàng; đơn cũ / liên hệ vẫn trỏ tới được.
   * Hoàn tác trong `RESTORE_WINDOW_MS` bằng `restore()`. Xoá hẳn là `purge()` (Quản trị).
   */
  async remove(id: number, user: AuthUser): Promise<{ id: number; archived: true }> {
    // Cập nhật CÓ ĐIỀU KIỆN `deleted_at IS NULL`: hai người xoá cùng lúc thì chỉ một lệnh ghi được, người kia nhận 404
    // (không ghi đè `deleted_by` ⇒ người xoá trước vẫn Hoàn tác được như đã hứa).
    const { count } = await this.prisma.product.updateMany({
      where: { id, deleted_at: null },
      data: { deleted_at: new Date(), deleted_by: user.userId },
    });
    if (count === 0) throw new NotFoundException('Sản phẩm không tồn tại');
    return { id, archived: true };
  }

  /**
   * Hoàn tác xoá: người đã xoá hoặc Quản trị, trong `RESTORE_WINDOW_MS`. Không có tool MCP tương ứng.
   */
  async restore(id: number, user: AuthUser): Promise<ProductDto> {
    const row = await this.prisma.product.findFirst({
      where: { id, deleted_at: { not: null } },
      select: { deleted_at: true, deleted_by: true },
    });
    if (!row || !row.deleted_at) throw new NotFoundException('Không có sản phẩm đang chờ khôi phục');
    if (row.deleted_by !== user.userId && !user.isAdmin) {
      throw new ForbiddenException('Chỉ người đã xoá hoặc Quản trị mới khôi phục được sản phẩm này');
    }
    if (Date.now() - row.deleted_at.getTime() > RESTORE_WINDOW_MS) {
      throw new GoneException('Đã quá thời gian hoàn tác — sản phẩm vẫn nằm trong mục đã xoá');
    }
    const product = await this.prisma.product.update({
      where: { id },
      data: { deleted_at: null, deleted_by: null },
      select: PRODUCT_SELECT,
    });
    return toProductDto(product as ProductRow);
  }

  /**
   * Xoá CỨNG — CHỈ Quản trị. 404 nếu không có; 409 + lý do tiếng Việt nếu còn đơn POS/liên hệ trỏ
   * tới. Xoá dòng trong transaction (khoá hàng chống race với đơn POS đang
   * tạo), rồi MỚI dọn file ảnh trên đĩa — sau commit, và chỉ khi không sản phẩm nào khác dùng chung URL.
   */
  async purge(id: number, user: AuthUser): Promise<{ id: number; deleted: true }> {
    if (!user.isAdmin) throw new ForbiddenException('Chỉ Quản trị mới xoá hẳn được sản phẩm');
    const { image_url } = await this.prisma.$transaction((tx) => hardDeleteProduct(tx, id));
    if (image_url) {
      const stillUsed = await this.prisma.product.count({ where: { image_url } });
      if (stillUsed === 0) await deleteProductImageFile(image_url);
    }
    return { id, deleted: true };
  }

  /**
   * validate `attributes` theo `ProductAttributeDef` của
   * `categoryId` bằng hàm TS whitelist `validateProductAttributes` (KHÔNG nội
   * suy tên cột/raw SQL). `categoryId=null` ⇒ defs rỗng ⇒ `rawAttributes` PHẢI
   * rỗng, không thì 400 ("chưa gán danh mục nên không thể nhập thuộc tính").
   */
  private async resolveAttributes(
    categoryId: number | null,
    rawAttributes: unknown,
  ): Promise<Record<string, unknown>> {
    if (categoryId != null) await this.assertCategoryUsable(categoryId);
    const defs =
      categoryId != null
        ? await this.attributeDefsService.findAllForCategoryAsValidatorDefs(categoryId)
        : [];
    return validateProductAttributes(defs, rawAttributes);
  }

  /** Dự án phải tồn tại VÀ đang hoạt động. */
  private async assertProjectUsable(projectId: number): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, is_active: true },
    });
    if (!project) throw new BadRequestException(`Dự án ID ${projectId} không tồn tại`);
    if (!project.is_active) {
      throw new BadRequestException(`Dự án "${project.name}" đã ngưng hoạt động`);
    }
  }

  /** Mirror `assertProjectUsable` — category PHẢI tồn tại VÀ đang hoạt động khi gán cho sản phẩm. */
  private async assertCategoryUsable(categoryId: number): Promise<void> {
    const category = await this.prisma.productCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, name: true, is_active: true },
    });
    if (!category) throw new BadRequestException(`Danh mục sản phẩm ID ${categoryId} không tồn tại`);
    if (!category.is_active) {
      throw new BadRequestException(`Danh mục "${category.name}" đã ngưng hoạt động`);
    }
  }

  /**
   * So `code` KHÔNG phân biệt hoa/thường: unique index DB là case-sensitive
   * (`REV-1` và `rev-1` cùng chèn được), trong khi `code` là khoá tham chiếu
   * do người gõ tay/đọc miệng — 2 mã chỉ khác hoa/thường là 1 tham chiếu mơ hồ. Race 2 request cùng lúc vẫn do unique index + P2002
   * (`rethrowProductWriteError`) chặn ở tầng ghi; hàm này chỉ chặn sớm + báo rõ mã trùng.
   */
  private async assertCodeAvailable(code: string): Promise<void> {
    const existing = await this.prisma.product.findFirst({
      where: { code: { equals: code, mode: 'insensitive' } },
      select: { id: true, code: true, deleted_at: true },
    });
    if (existing?.deleted_at) {
      throw new ConflictException(
        `Mã sản phẩm "${code}" đang thuộc một sản phẩm đã xoá (lưu trữ) — khôi phục sản phẩm đó, hoặc nhờ Quản trị xoá hẳn rồi dùng lại mã`,
      );
    }
    if (existing) {
      throw new ConflictException(
        `Mã sản phẩm "${code}" đã tồn tại (trùng "${existing.code}", không phân biệt hoa/thường)`,
      );
    }
  }
}
