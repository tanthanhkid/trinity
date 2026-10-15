import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateProductCategoryDto } from './create-product-category.dto';

/**
 * `code` KHÔNG sửa được sau khi tạo — mirror `UpdateProductDto` (là slug ổn
 * định, dùng làm khoá tham chiếu ngoài UI). `is_active=false` = ẨN khỏi
 * dropdown chọn danh mục khi tạo/sửa sản phẩm (mirror `Product.is_active`),
 * KHÔNG xoá — sản phẩm đang gán category vẫn đọc được category đó.
 */
export class UpdateProductCategoryDto extends PartialType(
  OmitType(CreateProductCategoryDto, ['code'] as const),
  { skipNullProperties: false },
) {}
