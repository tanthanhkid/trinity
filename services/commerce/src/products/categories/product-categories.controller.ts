import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AuthUser, Can, CurrentUser } from '@trinity/rbac-nest';
import { ParseInt4Pipe } from '../../common/validation/int4';
import { ProductCategoriesService } from './product-categories.service';
import { CreateProductCategoryDto } from './dto/create-product-category.dto';
import { UpdateProductCategoryDto } from './dto/update-product-category.dto';
import { ProductAttributeDefsService } from '../attribute-defs/product-attribute-defs.service';
import { CreateAttributeDefDto } from '../attribute-defs/dto/create-attribute-def.dto';

/**
 * Danh mục/ngành sản phẩm. RBAC quyền + phạm vi: GET
 * đòi `products.view` (FE liệt kê danh mục để dựng dropdown lọc/tạo sản
 * phẩm), ghi (POST/PATCH) đòi
 * `products.manage` (CÙNG quyền sửa sản phẩm — yêu cầu "quản lý
 * danh mục/thuộc tính = cùng quyền sửa sản phẩm").
 */
@ApiTags('Product Categories')
@ApiBearerAuth()
@Controller('product-categories')
export class ProductCategoriesController {
  constructor(
    private readonly categoriesService: ProductCategoriesService,
    private readonly attributeDefsService: ProductAttributeDefsService,
  ) {}

  @Get()
  @Can('products.view')
  @ApiOperation({ summary: 'Danh mục sản phẩm — cần quyền products.view' })
  @ApiQuery({ name: 'include_inactive', required: false, type: Boolean })
  @ApiResponse({ status: 200 })
  findAll(@Query('include_inactive') includeInactive?: string) {
    return this.categoriesService.findAll(includeInactive === 'true');
  }

  @Get(':id')
  @Can('products.view')
  @ApiOperation({ summary: 'Chi tiết danh mục — cần quyền products.view' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Danh mục không tồn tại' })
  findOne(@Param('id', ParseInt4Pipe) id: number) {
    return this.categoriesService.findOne(id);
  }

  @Post()
  @Can('products.manage')
  @ApiOperation({ summary: 'Tạo danh mục mới — mirror RBAC POST /products' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 403, description: 'Không có quyền — cần products.manage' })
  @ApiResponse({ status: 409, description: 'Mã danh mục đã tồn tại' })
  create(@Body() dto: CreateProductCategoryDto, @CurrentUser() user: AuthUser) {
    return this.categoriesService.create(dto, user.userId);
  }

  @Patch(':id')
  @Can('products.manage')
  @ApiOperation({ summary: 'Cập nhật danh mục — `code` KHÔNG sửa được' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'Không có quyền — cần products.manage' })
  @ApiResponse({ status: 404, description: 'Danh mục không tồn tại' })
  update(@Param('id', ParseInt4Pipe) id: number, @Body() dto: UpdateProductCategoryDto) {
    return this.categoriesService.update(id, dto);
  }

  @Get(':categoryId/attribute-defs')
  @Can('products.view')
  @ApiOperation({ summary: 'Định nghĩa thuộc tính động của danh mục — cần quyền products.view' })
  @ApiResponse({ status: 200 })
  findAttributeDefs(@Param('categoryId', ParseInt4Pipe) categoryId: number) {
    return this.attributeDefsService.findAllForCategory(categoryId);
  }

  @Post(':categoryId/attribute-defs')
  @Can('products.manage')
  @ApiOperation({ summary: 'Thêm thuộc tính động cho danh mục — mirror RBAC POST /products' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 400, description: 'Danh mục không tồn tại' })
  @ApiResponse({ status: 409, description: 'key đã tồn tại trong danh mục này' })
  createAttributeDef(
    @Param('categoryId', ParseInt4Pipe) categoryId: number,
    @Body() dto: CreateAttributeDefDto,
  ) {
    return this.attributeDefsService.create(categoryId, dto);
  }
}
