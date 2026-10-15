import { ConflictException } from '@nestjs/common';
import { Prisma } from '@trinity/prisma';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';

/**
 * Shape dữ liệu ghi, khai TƯỜNG MINH thay vì dùng `Prisma.Product*Input` làm type
 * trung gian — cùng lý do đã ghi ở `ProjectsService.update`: `ProductUncheckedUpdateInput`
 * cho phép `id`/`FieldUpdateOperationsInput` nên KHÔNG assign được vào `create.data`,
 * và commerce service resolve `@prisma/client` từ node_modules khác CRM (dual-instance).
 * Object này dùng được cho CẢ `create` LẪN `update`.
 *
 * Gồm `category_id`/`description`/`price`; `attributes`
 * KHÔNG có ở đây — validate+set riêng trong `ProductsService` (cần load defs từ
 * DB nên không thể là hàm thuần của `product-write.helper.ts`).
 */
export interface ProductWritableData {
  name?: string;
  /**
   * KHÔNG được `buildWritableData` set (xem docblock hàm đó) — CHỈ
   * `ProductsService.create()` gán tường minh field này. Khai ở interface để
   * `create()` gán thẳng vào cùng object literal `ProductWritableData` mà
   * không cần type ép buộc riêng.
   */
  project_id?: number | null;
  category_id?: number | null;
  description?: string | null;
  price?: bigint | null;
  brand?: string | null;
  color?: string | null;
  tags?: { set: string[] };
  is_featured?: boolean;
  image_url?: string | null;
  is_active?: boolean;
  /**
   * KHÔNG được `buildWritableData` set — cần load `ProductAttributeDef` từ DB
   * để validate nên chỉ `ProductsService` (có `PrismaService`) mới gán field
   * này, SAU KHI gọi `validateProductAttributes()`. Khai ở đây để service gán
   * thẳng vào `ProductWritableData` mà không cần cast `as Record<string,unknown>`.
   */
  attributes?: Prisma.InputJsonValue;
}

export function buildListWhere(query: ListProductsQueryDto): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  if (query.project_id != null) and.push({ project_id: query.project_id });
  if (query.category_id != null) and.push({ category_id: query.category_id });
  // `!= null` chứ KHÔNG truthy-check: `is_active=false` là bộ lọc HỢP LỆ
  // ("chỉ sản phẩm đã tắt"), truthy-check sẽ im lặng bỏ qua nó.
  if (query.is_active != null) and.push({ is_active: query.is_active });
  if (query.q) {
    // `mode:'insensitive'` — dữ liệu nhập tay hoa/thường lẫn lộn.
    and.push({
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { code: { contains: query.q, mode: 'insensitive' } },
        { brand: { contains: query.q, mode: 'insensitive' } },
      ],
    });
  }
  // Ghép bằng `AND`, KHÔNG spread — không key nào ghi đè key khác.
  return and.length > 0 ? { AND: and } : {};
}

/**
 * Chỉ nhặt field CÓ GỬI (`!== undefined`) — dùng chung cho create + update nên
 * update không bao giờ ghi `null` lên field client không đụng tới.
 *
 * `null` GỬI TƯỜNG MINH trên cột nullable = xoá giá trị (về "chưa nhập"), Cột NOT NULL không
 * bao giờ nhận `null` tới đây — DTO đã chặn 400 bằng `ValidateIf(isDefined)` /
 * `skipNullProperties:false`.
 *
 * ⚠️ TUYỆT ĐỐI KHÔNG viết lại hàm này bằng `Object.keys(dto)` hay spread `...dto`:
 * `tsconfig.base.json` đặt `target: ES2022` nên MỌI field khai trên class DTO trở
 * thành own property `= undefined` ngay khi `class-transformer` dựng instance ⇒
 * spread sẽ ghi `undefined` đè giá trị cũ, và `Object.keys` luôn trả ĐỦ field bất
 * kể client gửi gì (dễ gây lỗi khi merge DTO).
 */
/**
 * ⚠️ CỐ Ý KHÔNG xử lý `project_id` ở đây, kể cả khi `dto` mang key đó (vd bị
 * ép kiểu `as unknown as UpdateProductDto` từ 1 object literal tay) — đây là
 * bất biến BẢO VỆ THEO CẤU TRÚC (structural), KHÔNG chỉ dựa vào TypeScript
 * `OmitType`: `project_id` CHỈ được set tường minh tại `ProductsService.create()`,
 * ngoài hàm THUẦN dùng chung này. Nếu thêm nhánh `if ('project_id' in dto)`
 * generic ở đây, `update()` sẽ ghi được `project_id` bất cứ khi nào caller đưa
 * vào 1 object thô bỏ qua `ValidationPipe` — đúng lớp lỗ hổng test
 * `products.service.spec.ts` § "KHÔNG BAO GIỜ ghi code/project_id" dựng ra để bắt.
 */
export function buildWritableData(
  dto: CreateProductDto | UpdateProductDto,
): ProductWritableData {
  const data: ProductWritableData = {};
  if (dto.name !== undefined) data.name = dto.name;
  if (dto.category_id !== undefined) data.category_id = dto.category_id;
  if (dto.description !== undefined) data.description = dto.description;
  if (dto.price !== undefined) data.price = dto.price === null ? null : BigInt(dto.price);
  if (dto.brand !== undefined) data.brand = dto.brand;
  if (dto.color !== undefined) data.color = dto.color;
  if (dto.tags !== undefined) data.tags = { set: dto.tags };
  if (dto.is_featured !== undefined) data.is_featured = dto.is_featured;
  if (dto.image_url !== undefined) data.image_url = dto.image_url;
  if ('is_active' in dto && dto.is_active !== undefined) data.is_active = dto.is_active;
  return data;
}

/**
 * Race 2 request cùng `code`: guard đọc-rồi-ghi trong service KHÔNG atomic, unique
 * index `products_code_key` mới là thứ chặn thật → đổi P2002 thành 409 thay vì để
 * rơi ra 500. Constraint khác vẫn rethrow nguyên vẹn để không che lỗi data thật.
 */
export function rethrowProductWriteError(err: unknown, code: string): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    duplicateTargetIncludesCode(err.meta?.target)
  ) {
    throw new ConflictException(`Mã sản phẩm "${code}" đã tồn tại`);
  }
  throw err;
}

/**
 * Prisma 6 trả `meta.target` dạng MẢNG tên field (`['code']`) cho unique index
 * thường và dạng CHUỖI tên index cho partial index — match cả 2 shape, nếu chỉ
 * match 1 shape thì lỗi trùng sẽ thành 500.
 */
function duplicateTargetIncludesCode(target: unknown): boolean {
  if (Array.isArray(target)) return target.includes('code');
  return typeof target === 'string' && target.includes('code');
}
