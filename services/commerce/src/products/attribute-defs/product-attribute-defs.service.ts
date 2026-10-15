import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { ProductCategoriesService } from '../categories/product-categories.service';
import { CreateAttributeDefDto } from './dto/create-attribute-def.dto';
import { UpdateAttributeDefDto } from './dto/update-attribute-def.dto';
import type { AttributeDefLike } from '../product-attributes.validator';

/** `select` tường minh — dùng CHUNG cho controller lẫn `ProductsService` (validate attributes). */
export const ATTRIBUTE_DEF_SELECT = {
  id: true,
  category_id: true,
  key: true,
  label: true,
  type: true,
  options: true,
  is_required: true,
  sort_order: true,
  created_at: true,
  updated_at: true,
} as const;

export type AttributeDefDto = Prisma.ProductAttributeDefGetPayload<{
  select: typeof ATTRIBUTE_DEF_SELECT;
}>;

/**
 * CRUD định nghĩa thuộc tính động của 1 danh mục. RBAC ghi = CÙNG
 * quyền sửa sản phẩm (`super_admin`/`operations`, xem controller).
 *
 * Bảng NHỎ theo từng danh mục (cỡ chục field/danh mục) — CỐ Ý KHÔNG cursor,
 * mirror `ProductCategoriesService`.
 */
@Injectable()
export class ProductAttributeDefsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categoriesService: ProductCategoriesService,
  ) {}

  /** Dùng bởi `ProductsService.resolveAttributes` — nguồn `defs` cho `validateProductAttributes`. */
  async findAllForCategory(categoryId: number): Promise<AttributeDefDto[]> {
    return this.prisma.productAttributeDef.findMany({
      where: { category_id: categoryId },
      select: ATTRIBUTE_DEF_SELECT,
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });
  }

  /** Rút gọn field cần cho `validateProductAttributes` — tránh caller phải biết shape Prisma. */
  async findAllForCategoryAsValidatorDefs(categoryId: number): Promise<AttributeDefLike[]> {
    const rows = await this.findAllForCategory(categoryId);
    return rows.map((r) => ({
      key: r.key,
      label: r.label,
      type: r.type,
      options: r.options,
      is_required: r.is_required,
    }));
  }

  async create(categoryId: number, dto: CreateAttributeDefDto): Promise<AttributeDefDto> {
    await this.categoriesService.assertCategoryExists(categoryId);
    await this.assertKeyAvailable(categoryId, dto.key);
    assertSelectHasOptions(dto.type, dto.options);
    try {
      return await this.prisma.productAttributeDef.create({
        data: {
          category_id: categoryId,
          key: dto.key,
          label: dto.label,
          type: dto.type,
          options: dto.options as Prisma.InputJsonValue | undefined,
          is_required: dto.is_required ?? false,
          sort_order: dto.sort_order ?? 0,
        },
        select: ATTRIBUTE_DEF_SELECT,
      });
    } catch (err) {
      this.rethrowIfDuplicateKey(err, dto.key);
    }
  }

  /** `key` KHÔNG có trong `UpdateAttributeDefDto` — xem doc-comment ở DTO. */
  async update(id: number, dto: UpdateAttributeDefDto): Promise<AttributeDefDto> {
    const existing = await this.findOneOrThrow(id);
    // Kiểm theo trạng thái SAU khi sửa: đổi type sang select, hoặc xoá options của def đang là select.
    assertSelectHasOptions(
      dto.type ?? existing.type,
      dto.options !== undefined ? dto.options : existing.options,
    );
    return this.prisma.productAttributeDef.update({
      where: { id },
      data: buildDefWritableData(dto),
      select: ATTRIBUTE_DEF_SELECT,
    });
  }

  /**
   * Hard delete — bảng CẤU HÌNH (không phải dữ liệu khách/audit). Sản phẩm đã
   * gán giá trị cho key này giữ nguyên trong `Product.attributes` JSON (mồ côi
   * vô hại — key lạ không còn def sẽ không hiển thị/validate lại được ở lần
   * sửa kế tiếp, nhưng KHÔNG mất dữ liệu ngầm nào khác).
   */
  async remove(id: number): Promise<void> {
    await this.findOneOrThrow(id);
    await this.prisma.productAttributeDef.delete({ where: { id } });
  }

  private async findOneOrThrow(id: number) {
    const exists = await this.prisma.productAttributeDef.findUnique({
      where: { id },
      select: { id: true, type: true, options: true },
    });
    if (!exists) throw new NotFoundException('Thuộc tính không tồn tại');
    return exists;
  }

  private async assertKeyAvailable(categoryId: number, key: string): Promise<void> {
    const existing = await this.prisma.productAttributeDef.findFirst({
      where: { category_id: categoryId, key },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`Thuộc tính key "${key}" đã tồn tại trong danh mục này`);
    }
  }

  private rethrowIfDuplicateKey(err: unknown, key: string): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictException(`Thuộc tính key "${key}" đã tồn tại trong danh mục này`);
    }
    throw err;
  }
}

/** type=select|multiselect mà không có lựa chọn nào ⇒ mọi sản phẩm dùng key này bị 400 — chặn từ lúc khai báo. */
function assertSelectHasOptions(type: string | undefined, options: unknown): void {
  if ((type === 'select' || type === 'multiselect') && !(Array.isArray(options) && options.length > 0)) {
    throw new BadRequestException('Thuộc tính kiểu select/multiselect phải có ít nhất một lựa chọn (options)');
  }
}

/** Chỉ nhặt field CÓ GỬI (`!== undefined`) — mirror `product-write.helper.ts`. */
function buildDefWritableData(dto: UpdateAttributeDefDto): Prisma.ProductAttributeDefUpdateInput {
  const data: Prisma.ProductAttributeDefUpdateInput = {};
  if (dto.label !== undefined) data.label = dto.label;
  if (dto.type !== undefined) data.type = dto.type;
  if (dto.options !== undefined) {
    // `AttributeOptionDto[]` là class instance, không cấu trúc khớp thẳng
    // `Prisma.InputJsonValue` (TS đòi qua `unknown` trước — nó chỉ là JSON
    // literal `{value,label}[]` tại runtime nên ép kiểu này AN TOÀN).
    data.options =
      dto.options === null ? Prisma.JsonNull : (dto.options as unknown as Prisma.InputJsonValue);
  }
  if (dto.is_required !== undefined) data.is_required = dto.is_required;
  if (dto.sort_order !== undefined) data.sort_order = dto.sort_order;
  return data;
}
