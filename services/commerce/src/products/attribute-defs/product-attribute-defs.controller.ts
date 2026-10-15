import { Controller, Patch, Delete, Param, Body, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Can } from '@trinity/rbac-nest';
import { ParseInt4Pipe } from '../../common/validation/int4';
import { ProductAttributeDefsService } from './product-attribute-defs.service';
import { UpdateAttributeDefDto } from './dto/update-attribute-def.dto';

/**
 * Sửa/xoá 1 định nghĩa thuộc tính động theo `id` — tách khỏi
 * `ProductCategoriesController` vì thao tác nhắm THẲNG `id` của def, không cần
 * biết `categoryId` (`PATCH /product-attribute-defs/:id` độc lập, tham số theo nhu cầu chứ không theo resource cha).
 *
 * RBAC = CÙNG quyền sửa sản phẩm (`products.manage`).
 */
@ApiTags('Product Categories')
@ApiBearerAuth()
@Can('products.manage')
@Controller('product-attribute-defs')
export class ProductAttributeDefsController {
  constructor(private readonly attributeDefsService: ProductAttributeDefsService) {}

  @Patch(':id')
  @ApiOperation({ summary: 'Sửa thuộc tính động — `key` KHÔNG sửa được' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Thuộc tính không tồn tại' })
  update(@Param('id', ParseInt4Pipe) id: number, @Body() dto: UpdateAttributeDefDto) {
    return this.attributeDefsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Xoá thuộc tính động (hard delete — bảng cấu hình, không phải dữ liệu khách)' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Thuộc tính không tồn tại' })
  async remove(@Param('id', ParseInt4Pipe) id: number): Promise<void> {
    await this.attributeDefsService.remove(id);
  }
}
