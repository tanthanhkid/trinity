import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthOnly, Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { SettingsOptionsService } from './settings-options.service';
import { CreateOptionDto } from './dto/create-option.dto';
import { UpdateOptionDto } from './dto/update-option.dto';
import { QueryOptionsDto } from './dto/query-options.dto';

/**
 * RBAC quyền + phạm vi: danh mục nguồn/giai đoạn/trạng thái — đọc
 * `@AuthOnly()` (mọi user đăng nhập, phục vụ dropdown), ghi `contacts.catalog`
 * (mirror `tags`).
 */
@ApiTags('Settings Options')
@ApiBearerAuth()
@Controller('settings/options')
export class SettingsOptionsController {
  constructor(private readonly service: SettingsOptionsService) {}

  @Get()
  @AuthOnly()
  @ApiOperation({
    summary: 'Danh sách option cấu hình động',
    description:
      'Trả về danh sách option theo `group`, sắp xếp theo sort_order ASC. ' +
      'Mọi user đăng nhập đều có quyền đọc (dùng cho dropdown).',
  })
  @ApiResponse({ status: 200, description: 'Danh sách options' })
  async findAll(@Query() query: QueryOptionsDto) {
    return this.service.findAll(query);
  }

  @Post()
  @Can('contacts.catalog')
  @ApiOperation({
    summary: 'Tạo option mới',
    description: 'Cần quyền contacts.catalog.',
  })
  @ApiResponse({ status: 201, description: 'Option đã tạo' })
  @ApiResponse({ status: 409, description: 'group_key + value đã tồn tại' })
  async create(@Body() dto: CreateOptionDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user.userId);
  }

  @Patch(':id')
  @Can('contacts.catalog')
  @ApiOperation({
    summary: 'Cập nhật option',
    description:
      'Cập nhật label / sort_order / is_active / metadata. ' +
      'KHÔNG cho đổi group_key + value.',
  })
  @ApiResponse({ status: 200, description: 'Option đã cập nhật' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy option' })
  @ApiParam({ name: 'id', type: Number, description: 'Option ID' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOptionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user.userId);
  }

  @Delete(':id')
  @Can('contacts.catalog')
  @ApiOperation({
    summary: 'Xoá mềm option',
    description:
      'Soft delete: set is_active=false. ' +
      'Nếu is_system=true → 400 (giá trị hệ thống).',
  })
  @ApiResponse({ status: 200, description: 'Option đã ẩn khỏi dropdown' })
  @ApiResponse({ status: 400, description: 'is_system=true không xoá được' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy option' })
  @ApiParam({ name: 'id', type: Number, description: 'Option ID' })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.remove(id, user.userId);
  }
}
