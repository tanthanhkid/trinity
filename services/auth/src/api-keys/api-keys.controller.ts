import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest'
import { ApiKeysService } from './api-keys.service'
import { CreateApiKeyDto } from './dto/create-api-key.dto'

/**
 * Quản lý API key cấp cho bên thứ 3.
 * RBAC: `settings.integrations` (nhóm Hệ thống — khoá API và các kết nối
 * tích hợp). Khoá nguyên bản chỉ hiển thị 1 lần duy nhất khi tạo hoặc
 * xoay — DB chỉ lưu SHA-256 hash.
 */
@ApiTags('API Keys')
@Controller('api-keys')
@Can('settings.integrations')
@ApiBearerAuth()
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách khoá API (settings.integrations)' })
  @ApiResponse({
    status: 200,
    description: 'Danh sách khoá API (chỉ prefix hiển thị, không lộ key gốc)',
  })
  async findAll() {
    return this.apiKeys.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Chi tiết khoá API' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({ status: 200, description: 'Chi tiết khoá API' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy khoá' })
  async findById(@Param('id', ParseIntPipe) id: number) {
    return this.apiKeys.findById(id)
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Tạo khoá API mới (settings.integrations)',
    description:
      'Trả về `plain_key` — CHỈ hiển thị 1 lần duy nhất. Sau khi đóng dialog, ' +
      'không cách nào xem lại (DB chỉ lưu hash). Mất key → bấm Xoay khoá.',
  })
  @ApiBody({ type: CreateApiKeyDto })
  @ApiResponse({ status: 201, description: 'Tạo thành công — plain_key duy nhất' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  @ApiResponse({ status: 403, description: 'Không có quyền (thiếu settings.integrations)' })
  async create(
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.apiKeys.create(dto, user.userId)
  }

  @Post(':id/rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Xoay khoá API — sinh key mới, key cũ vô hiệu ngay lập tức',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({ status: 200, description: 'Trả về plain_key mới' })
  @ApiResponse({ status: 400, description: 'Khoá đã bị thu hồi' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy khoá' })
  async rotate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.apiKeys.rotate(id, user.userId)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Thu hồi khoá API (soft delete)',
    description:
      'Khoá bị set revoked_at. Mọi request sử dụng key này sẽ nhận 401 ngay sau đó.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({ status: 200, description: 'Đã thu hồi' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy khoá' })
  async revoke(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.apiKeys.revoke(id, user.userId)
  }
}
