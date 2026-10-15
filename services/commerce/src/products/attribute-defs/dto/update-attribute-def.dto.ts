import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateAttributeDefDto } from './create-attribute-def.dto';

/**
 * `key` KHÔNG sửa được sau khi tạo — nó là khoá trong `Product.attributes`
 * JSON của MỌI sản phẩm đã gán giá trị cho def này; đổi key sẽ mồ côi dữ liệu
 * đã lưu (mirror bất biến `code` của `Product`/`ProductCategory`).
 */
export class UpdateAttributeDefDto extends PartialType(
  OmitType(CreateAttributeDefDto, ['key'] as const),
  { skipNullProperties: false },
) {}
