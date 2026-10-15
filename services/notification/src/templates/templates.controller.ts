import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger'
import { Can } from '@trinity/rbac-nest'
import { TemplatesService } from './templates.service'
import { CreateTemplateDto } from './dto/create-template.dto'
import { UpdateTemplateDto } from './dto/update-template.dto'

// Cấu hình mẫu thông báo hệ thống — không có quyền dành riêng cho "template
// thông báo" trong danh mục @trinity/rbac; dùng `settings.integrations`
// (nhóm Hệ thống, gần nhất với "cấu hình hệ thống nội bộ").
@ApiTags('Notification Templates')
@ApiBearerAuth()
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  @Can('settings.integrations')
  @ApiOperation({ summary: 'Danh sach template thong bao' })
  @ApiResponse({ status: 200, description: 'Tra ve danh sach templates' })
  @ApiResponse({ status: 401, description: 'Chua xac thuc' })
  @ApiResponse({ status: 403, description: 'Khong co quyen' })
  findAll() {
    return this.templatesService.findAll()
  }

  @Get(':id')
  @Can('settings.integrations')
  @ApiOperation({ summary: 'Chi tiet template' })
  @ApiResponse({ status: 200, description: 'Tra ve template' })
  @ApiResponse({ status: 404, description: 'Khong tim thay' })
  findById(@Param('id', ParseIntPipe) id: number) {
    return this.templatesService.findById(id)
  }

  @Post()
  @Can('settings.integrations')
  @ApiOperation({ summary: 'Tao template moi' })
  @ApiResponse({ status: 201, description: 'Tao thanh cong' })
  @ApiResponse({ status: 401, description: 'Chua xac thuc' })
  @ApiResponse({ status: 403, description: 'Khong co quyen' })
  create(@Body() dto: CreateTemplateDto) {
    return this.templatesService.create(dto)
  }

  @Patch(':id')
  @Can('settings.integrations')
  @ApiOperation({ summary: 'Cap nhat template' })
  @ApiResponse({ status: 200, description: 'Cap nhat thanh cong' })
  @ApiResponse({ status: 404, description: 'Khong tim thay' })
  @ApiResponse({ status: 403, description: 'Khong co quyen' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templatesService.update(id, dto)
  }

  @Delete(':id')
  @Can('settings.integrations')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Xoa template' })
  @ApiResponse({ status: 204, description: 'Xoa thanh cong' })
  @ApiResponse({ status: 404, description: 'Khong tim thay' })
  @ApiResponse({ status: 403, description: 'Khong co quyen' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.templatesService.remove(id)
  }
}
