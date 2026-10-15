import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { CreateProductCategoryDto } from './dto/create-product-category.dto';
import { UpdateProductCategoryDto } from './dto/update-product-category.dto';

/** `select` tường minh — KHÔNG `SELECT *`/`include` (coding-standards). */
const CATEGORY_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  is_active: true,
  sort_order: true,
  created_by: true,
  created_at: true,
  updated_at: true,
} as const;

export type ProductCategoryDto = Prisma.ProductCategoryGetPayload<{ select: typeof CATEGORY_SELECT }>;

/**
 * CRUD danh mục/ngành sản phẩm. RBAC ghi = CÙNG quyền sửa sản phẩm
 * (`super_admin`/`operations`, xem `ProductCategoriesController`) — danh mục là
 * cấu hình khai báo cho khung sản phẩm, không phải dữ liệu khách.
 *
 * Danh mục là bảng NHỎ (cỡ chục dòng, như `pipeline_stages`/`setting_options`)
 * — CỐ Ý KHÔNG cursor/`take` trên `findAll` (cùng lý do `ProductsService.findAll`
 * không cap: thêm cap kèm sort ASC là công thức cắt im lặng dữ liệu).
 */
@Injectable()
export class ProductCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(includeInactive: boolean): Promise<ProductCategoryDto[]> {
    return this.prisma.productCategory.findMany({
      where: includeInactive ? {} : { is_active: true },
      select: CATEGORY_SELECT,
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });
  }

  async findOne(id: number): Promise<ProductCategoryDto> {
    const category = await this.prisma.productCategory.findUnique({
      where: { id },
      select: CATEGORY_SELECT,
    });
    if (!category) throw new NotFoundException('Danh mục sản phẩm không tồn tại');
    return category;
  }

  async create(dto: CreateProductCategoryDto, userId: number): Promise<ProductCategoryDto> {
    await this.assertCodeAvailable(dto.code);
    try {
      return await this.prisma.productCategory.create({
        data: {
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          sort_order: dto.sort_order ?? 0,
          is_active: dto.is_active ?? true,
          created_by: userId,
        },
        select: CATEGORY_SELECT,
      });
    } catch (err) {
      this.rethrowIfDuplicateCode(err, dto.code);
    }
  }

  /** `code` KHÔNG có trong `UpdateProductCategoryDto` — xem doc-comment ở DTO. */
  async update(id: number, dto: UpdateProductCategoryDto): Promise<ProductCategoryDto> {
    await this.findOne(id); // 404 nếu không tồn tại
    return this.prisma.productCategory.update({
      where: { id },
      data: buildCategoryWritableData(dto),
      select: CATEGORY_SELECT,
    });
  }

  /**
   * Sản phẩm PHẢI gán được category (exists) — dùng bởi `ProductsService`.
   * KHÔNG bắt buộc `is_active` (khác `assertProjectUsable`): xem lại danh mục
   * đã tắt vẫn hợp lệ để giữ dữ liệu cũ, chỉ ẨN khỏi dropdown tạo mới ở FE.
   */
  async assertCategoryExists(categoryId: number): Promise<void> {
    const exists = await this.prisma.productCategory.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!exists) {
      throw new BadRequestException(`Danh mục sản phẩm ID ${categoryId} không tồn tại`);
    }
  }

  private async assertCodeAvailable(code: string): Promise<void> {
    const existing = await this.prisma.productCategory.findFirst({
      where: { code: { equals: code, mode: 'insensitive' } },
      select: { id: true, code: true },
    });
    if (existing) {
      throw new ConflictException(
        `Mã danh mục "${code}" đã tồn tại (trùng "${existing.code}", không phân biệt hoa/thường)`,
      );
    }
  }

  private rethrowIfDuplicateCode(err: unknown, code: string): never {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      duplicateTargetIncludesCode(err.meta?.target)
    ) {
      throw new ConflictException(`Mã danh mục "${code}" đã tồn tại`);
    }
    throw err;
  }
}

function duplicateTargetIncludesCode(target: unknown): boolean {
  if (Array.isArray(target)) return target.includes('code');
  return typeof target === 'string' && target.includes('code');
}

/**
 * Chỉ nhặt field CÓ GỬI (`!== undefined`) — mirror `product-write.helper.ts`.
 * TUYỆT ĐỐI KHÔNG viết lại bằng `Object.keys(dto)`/spread.
 */
function buildCategoryWritableData(dto: UpdateProductCategoryDto): Prisma.ProductCategoryUpdateInput {
  const data: Prisma.ProductCategoryUpdateInput = {};
  if (dto.name !== undefined) data.name = dto.name;
  if (dto.description !== undefined) data.description = dto.description;
  if (dto.sort_order !== undefined) data.sort_order = dto.sort_order;
  if (dto.is_active !== undefined) data.is_active = dto.is_active;
  return data;
}
