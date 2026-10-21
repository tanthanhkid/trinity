import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { AuthUser, Can, CurrentUser } from '@trinity/rbac-nest';
import { PRODUCT_IMAGE_MAX_BYTES, saveProductImage } from './product-image-upload.helper';
import { ParseInt4Pipe } from '../common/validation/int4';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';

/**
 * Sản phẩm — khung khai báo chung đa ngành (tạo, tổng quát
 * hoá). Đặt ở Commerce service — KHÔNG phải CRM — vì CRUD
 * `projects` (thực thể cha, optional) do Commerce sở hữu (`ProjectsController`);
 * CRM chỉ ĐỌC.
 *
 * RBAC quyền + phạm vi: 2 route GET đòi `products.view` (xem sản
 * phẩm/dự án — admin tick cho vai trò cần chọn sản phẩm); ghi (tạo/sửa/xoá hẳn) đòi `products.manage`.
 */
@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @Can('products.view')
  @ApiOperation({
    summary: 'Danh sách sản phẩm/dịch vụ — cần quyền products.view (cần chọn khi tạo đơn/khách hàng)',
  })
  @ApiResponse({ status: 200, description: 'Danh sách sản phẩm, nổi bật xếp trước' })
  findAll(@Query() query: ListProductsQueryDto) {
    return this.productsService.findAll(query);
  }

  @Get(':id')
  @Can('products.view')
  @ApiOperation({ summary: 'Chi tiết sản phẩm — cần quyền products.view' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Sản phẩm không tồn tại' })
  findOne(@Param('id', ParseInt4Pipe) id: number) {
    return this.productsService.findOne(id);
  }

  @Post('upload-image')
  @Can('products.manage')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Tải ảnh minh hoạ sản phẩm từ máy — cùng quyền tạo/sửa sản phẩm',
  })
  @ApiResponse({ status: 201, description: 'Trả { image_url } để gán vào sản phẩm' })
  @ApiResponse({ status: 400, description: 'Sai định dạng (chỉ JPG/PNG/WebP/GIF) hoặc quá 5MB' })
  @ApiResponse({ status: 403, description: 'Không có quyền products.manage' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: PRODUCT_IMAGE_MAX_BYTES },
      fileFilter: (
        _req: unknown,
        file: { mimetype: string },
        cb: (err: Error | null, accept: boolean) => void,
      ) => {
        if (!file.mimetype.startsWith('image/')) {
          cb(new BadRequestException('File phải là ảnh (JPG, PNG, WebP, GIF)'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    return saveProductImage(file);
  }

  @Post()
  @Can('products.manage')
  @ApiOperation({ summary: 'Tạo sản phẩm mới — mirror RBAC POST /projects' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 400, description: 'Dự án không tồn tại hoặc đã ngưng hoạt động' })
  @ApiResponse({ status: 403, description: 'Không có quyền — cần products.manage' })
  @ApiResponse({ status: 409, description: 'Mã sản phẩm đã tồn tại' })
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    return this.productsService.create(dto, user.userId);
  }

  @Patch(':id')
  @Can('products.manage')
  @ApiOperation({
    summary: 'Cập nhật sản phẩm — `code` và `project_id` KHÔNG sửa được (xem UpdateProductDto)',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'Không có quyền — cần products.manage' })
  @ApiResponse({ status: 404, description: 'Sản phẩm không tồn tại' })
  update(@Param('id', ParseInt4Pipe) id: number, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  @Can('products.manage')
  @ApiOperation({ summary: 'Xoá sản phẩm = lưu trữ (xoá mềm); Hoàn tác trong 10 phút qua POST /products/:id/restore' })
  @ApiResponse({ status: 200, description: 'Đã lưu trữ: { id, archived: true }' })
  @ApiResponse({ status: 403, description: 'Không có quyền — cần products.manage' })
  @ApiResponse({ status: 404, description: 'Sản phẩm không tồn tại' })
  remove(@Param('id', ParseInt4Pipe) id: number, @CurrentUser() user: AuthUser) {
    return this.productsService.remove(id, user);
  }

  /** Nút "Hoàn tác" trên web sau khi xoá. Không có tool MCP tương ứng. */
  @Post(':id/restore')
  @Can('products.manage')
  @ApiOperation({ summary: 'Khôi phục sản phẩm vừa xoá — người đã xoá hoặc Quản trị, trong 10 phút' })
  @ApiResponse({ status: 403, description: 'Không phải người đã xoá / Quản trị' })
  @ApiResponse({ status: 404, description: 'Không có sản phẩm đang chờ khôi phục' })
  @ApiResponse({ status: 410, description: 'Quá thời gian hoàn tác' })
  restore(@Param('id', ParseInt4Pipe) id: number, @CurrentUser() user: AuthUser) {
    return this.productsService.restore(id, user);
  }

  @Delete(':id/permanent')
  @Can('products.manage')
  @ApiOperation({
    summary: 'Xoá HẲN sản phẩm — CHỈ Quản trị, chỉ khi chưa có đơn bán hàng/liên hệ nào dùng; ngược lại 409',
  })
  @ApiResponse({ status: 200, description: 'Đã xoá hẳn: { id, deleted: true }' })
  @ApiResponse({ status: 403, description: 'Không phải Quản trị' })
  @ApiResponse({ status: 404, description: 'Sản phẩm không tồn tại' })
  @ApiResponse({ status: 409, description: 'Sản phẩm đã có trong đơn bán hàng/liên hệ' })
  purge(@Param('id', ParseInt4Pipe) id: number, @CurrentUser() user: AuthUser) {
    return this.productsService.purge(id, user);
  }
}
