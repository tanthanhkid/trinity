import { PartialType, OmitType, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, ValidateIf } from 'class-validator';
import { CreateProductDto, isDefined } from './create-product.dto';

/**
 * 2 field CỐ Ý KHÔNG cho sửa (đừng "mở cho tiện"):
 *
 * 1. `code` — mã sản phẩm dùng làm khoá tham chiếu bên ngoài (link, tài liệu đã phát);
 *    đổi mã là làm chết tham chiếu đang chạy mà không có gì cảnh báo. Mirror
 *    `UpdateProjectDto` (cũng không có `code`).
 *
 * 2. `project_id` — di sản phẩm sang dự án khác sẽ HỒI TỐ phá bất biến
 *    bất biến "bản ghi tham chiếu sản phẩm phải cùng dự án với sản phẩm" lúc tạo
 *    đơn/hồ sơ: các hồ sơ ĐÃ LƯU trỏ tới sản phẩm này bỗng mang sản phẩm
 *    ngoài dự án, và vì đường ghi không đụng lại field đó nên KHÔNG guard nào
 *    phát hiện — đúng lớp bug. Cần đổi dự án thì tạo sản phẩm mới + tắt cái cũ.
 *    (`project_id` giờ OPTIONAL ở create, nhưng VẪN immutable sau tạo.)
 *
 * `skipNullProperties: false`: mapped type gắn
 * `ValidateIf(v => v !== undefined)` thay `IsOptional()` cho từng field kế thừa →
 * `null` KHÔNG còn được bỏ qua mặc định. Hệ quả đúng ý cho 2 nhóm cột:
 *  - cột NOT NULL (`name`, `tags`, `is_featured`): `null` chạy validator gốc
 *    (`IsString`/`IsArray`/`IsBoolean`) → 400, thay vì lọt tới Prisma thành 500;
 *  - cột nullable (`brand`, `color`, `category_id`, `description`, `price`…):
 *    vẫn nhận `null` nhờ `@IsOptional()` khai ở `CreateProductDto` = "xoá giá
 *    trị" — `buildWritableData` ghi
 *    `null` thật thay vì `BigInt(null)` (ném lỗi runtime = 500).
 */
export class UpdateProductDto extends PartialType(
  OmitType(CreateProductDto, ['code', 'project_id'] as const),
  { skipNullProperties: false },
) {
  @ApiPropertyOptional({
    example: true,
    description:
      'Bật/tắt sản phẩm. `false` = ẩn khỏi dropdown chọn sản phẩm (mirror `projects.is_active`). ' +
      'Dùng field này để BẬT LẠI sản phẩm đang ẩn (`true`). DELETE /products/:id là xoá HẲN, không phải xoá mềm.',
  })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma (xem `isDefined`).
  @ValidateIf(isDefined)
  @IsBoolean({ message: 'is_active phải là boolean' })
  is_active?: boolean;
}
