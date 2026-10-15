import { ArgumentsHost, BadRequestException, Body, Catch, Controller, ExceptionFilter, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseFilters } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ExtensionInputError } from './extension-errors';
import { ExtensionsService } from './extensions.service';

export class VersionBodyDto {
  @IsOptional() @IsInt() @Min(1) @Max(2_147_483_647)
  version?: number;
}

export class ReasonBodyDto {
  @IsOptional() @IsString() @MaxLength(1000)
  reason?: string;
}

/** Lỗi đầu vào của chương trình con ⇒ 400 kèm thông điệp tiếng Việt nguyên văn (không rơi vào 500). */
@Catch(ExtensionInputError)
class InputErrorFilter implements ExceptionFilter {
  catch(err: ExtensionInputError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status(n: number): { json(b: unknown): void } }>();
    const e = new BadRequestException(err.message);
    res.status(400).json(e.getResponse());
  }
}

/**
 * Chương trình con (do trợ lý AI của khách viết): danh sách, xem mã + quyền xin, DUYỆT / TỪ CHỐI / TẮT, nhật ký chạy.
 * 🔴 Duyệt là hành động của NGƯỜI: route chỉ nhận JWT phiên web (token của AI là chuỗi opaque ⇒ 401) và cần quyền `extensions.approve`.
 * Cờ `EXTENSIONS_ENABLED` tắt ⇒ mọi route 404.
 */
@ApiTags('Chương trình con')
@ApiBearerAuth()
@UseFilters(InputErrorFilter)
@Controller('extensions')
export class ExtensionsController {
  constructor(private readonly svc: ExtensionsService) {}

  @Get()
  @Can('extensions.view')
  @ApiOperation({ summary: 'Danh sách chương trình con (`?status=`, `?kind=`)' })
  @ApiResponse({ status: 404, description: 'Tính năng chương trình con đang tắt' })
  async list(@Query('status') status?: string, @Query('kind') kind?: string) {
    this.svc.assertEnabled();
    return { data: await this.svc.list({ status, kind }) };
  }

  @Get(':id')
  @Can('extensions.view')
  @ApiOperation({ summary: 'Chi tiết + các phiên bản (không kèm mã)' })
  async get(@Param('id', ParseIntPipe) id: number) {
    this.svc.assertEnabled();
    return this.svc.get(id);
  }

  @Get(':id/versions/:version')
  @Can('extensions.view')
  @ApiOperation({ summary: 'Một phiên bản kèm MÃ NGUỒN + quyền xin — để người duyệt đọc' })
  async version(@Param('id', ParseIntPipe) id: number, @Param('version', ParseIntPipe) version: number) {
    this.svc.assertEnabled();
    return this.svc.getVersion(id, version);
  }

  @Get(':id/logs')
  @Can('extensions.view')
  @ApiOperation({ summary: 'Nhật ký chạy (mới nhất trước), `?cursor=`, `?limit=`' })
  async logs(@Param('id', ParseIntPipe) id: number, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    this.svc.assertEnabled();
    return this.svc.logs(id, Number(limit) || 20, cursor ? Number(cursor) || undefined : undefined);
  }

  @Post(':id/versions/:version/approve')
  @Can('extensions.approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'DUYỆT một phiên bản (hành động của người). Duyệt chưa có nghĩa là chạy — cần deploy.' })
  async approve(@Param('id', ParseIntPipe) id: number, @Param('version', ParseIntPipe) version: number, @CurrentUser() user: AuthUser) {
    this.svc.assertEnabled();
    return { extension: await this.svc.approve(user.userId, id, version) };
  }

  @Post(':id/versions/:version/reject')
  @Can('extensions.approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'TỪ CHỐI một phiên bản kèm lý do (agent đọc được qua logs/get)' })
  async reject(@Param('id', ParseIntPipe) id: number, @Param('version', ParseIntPipe) version: number, @Body() dto: ReasonBodyDto, @CurrentUser() user: AuthUser) {
    this.svc.assertEnabled();
    return { extension: await this.svc.reject(user.userId, id, version, dto?.reason ?? null) };
  }

  @Post(':id/deploy')
  @Can('extensions.approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Chạy một phiên bản ĐÃ DUYỆT (mặc định bản duyệt mới nhất)' })
  async deploy(@Param('id', ParseIntPipe) id: number, @Body() dto: VersionBodyDto) {
    this.svc.assertEnabled();
    return { extension: await this.svc.deploy(id, dto?.version) };
  }

  @Post(':id/rollback')
  @Can('extensions.approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Quay lui về một phiên bản đã duyệt trước đó' })
  async rollback(@Param('id', ParseIntPipe) id: number, @Body() dto: VersionBodyDto) {
    this.svc.assertEnabled();
    if (!dto?.version) throw new BadRequestException('Thiếu version');
    return { extension: await this.svc.rollback(id, dto.version) };
  }

  @Post(':id/disable')
  @Can('extensions.approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'TẮT chương trình con (dừng chạy ngay)' })
  async disable(@Param('id', ParseIntPipe) id: number, @Body() dto: ReasonBodyDto) {
    this.svc.assertEnabled();
    return { extension: await this.svc.disable(id, dto?.reason ?? 'Người dùng tắt') };
  }

  @Post(':id/enable')
  @Can('extensions.approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'BẬT LẠI chương trình con đã tắt (kể cả tự tắt vì lỗi liên tục)' })
  async enable(@Param('id', ParseIntPipe) id: number) {
    this.svc.assertEnabled();
    return { extension: await this.svc.enable(id) };
  }
}
