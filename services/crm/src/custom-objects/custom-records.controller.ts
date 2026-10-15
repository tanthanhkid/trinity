import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import type { Response } from 'express';
import { CustomRecordsExportService } from './custom-records-export.service';
import { CustomRecordsListService } from './custom-records-list.service';
import { CustomRecordsService } from './custom-records.service';
import { CustomRecordBodyDto, ListCustomRecordsQueryDto, LookupQueryDto } from './dto/custom-record.dto';

/**
 * Dữ liệu (bản ghi) của tính năng tuỳ biến. Phạm vi theo `owner_id ∪ created_by`:
 * ngoài phạm vi theo id → 404. SĐT che theo `custom_records.phone_full`.
 */
@ApiTags('Custom Records')
@ApiBearerAuth()
@Controller('custom-objects')
export class CustomRecordsController {
  constructor(
    private readonly records: CustomRecordsService,
    private readonly lists: CustomRecordsListService,
    private readonly exporter: CustomRecordsExportService,
  ) {}

  @Get(':key/records')
  @Can('custom_records.view')
  @ApiOperation({ summary: 'Danh sách bản ghi (cursor, tìm theo tiêu đề, lọc, sắp xếp)' })
  list(@Param('key') key: string, @Query() q: ListCustomRecordsQueryDto, @CurrentUser() user: AuthUser) {
    return this.lists.list(user, key, q);
  }

  @Get(':key/records/export')
  @Can('custom_records.view', 'custom_records.export')
  @ApiOperation({ summary: 'Xuất CSV (mới → cũ, cắt ở 20.000 dòng và báo rõ)' })
  async export(
    @Param('key') key: string,
    @Query() q: ListCustomRecordsQueryDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const out = await this.exporter.exportCsv(user, key, q);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${out.filename}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
      'Cache-Control': 'private, no-store',
      'X-Total-Rows': String(out.total),
      'X-Exported-Rows': String(out.exported),
      'X-Truncated': String(out.truncated),
      'Access-Control-Expose-Headers': 'X-Total-Rows, X-Exported-Rows, X-Truncated, Content-Disposition',
    });
    return new StreamableFile(Buffer.from(out.body, 'utf8'));
  }

  @Get(':key/lookup')
  @Can('custom_records.view')
  @ApiOperation({ summary: 'Tìm bản ghi để chọn trong trường liên kết (chỉ {id, title} trong phạm vi xem)' })
  lookup(@Param('key') key: string, @Query() q: LookupQueryDto, @CurrentUser() user: AuthUser) {
    return this.lists.lookup(user, key, q);
  }

  @Post(':key/records')
  @Can('custom_records.view', 'custom_records.manage')
  @ApiOperation({ summary: 'Tạo bản ghi' })
  @ApiResponse({ status: 400, description: '{errors:{khoá_trường: thông báo}}' })
  create(@Param('key') key: string, @Body() dto: CustomRecordBodyDto, @CurrentUser() user: AuthUser) {
    return this.records.create(user, key, dto);
  }

  @Get(':key/records/:id')
  @Can('custom_records.view')
  @ApiOperation({ summary: 'Chi tiết bản ghi' })
  @ApiResponse({ status: 404, description: 'Không tồn tại hoặc ngoài phạm vi' })
  get(@Param('key') key: string, @Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.lists.getOne(user, key, id);
  }

  @Get(':key/records/:id/related')
  @Can('custom_records.view')
  @ApiOperation({ summary: 'Bản ghi của tính năng khác đang liên kết tới bản ghi này' })
  related(@Param('key') key: string, @Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.lists.related(user, key, id);
  }

  @Patch(':key/records/:id')
  @Can('custom_records.view', 'custom_records.manage')
  @ApiOperation({ summary: 'Sửa bản ghi (chỉ trường gửi lên đổi; null = xoá giá trị)' })
  update(
    @Param('key') key: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CustomRecordBodyDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.records.update(user, key, id, dto);
  }

  @Delete(':key/records/:id')
  @Can('custom_records.view', 'custom_records.delete')
  @ApiOperation({ summary: 'Xoá (mềm) bản ghi' })
  remove(@Param('key') key: string, @Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.records.remove(user, key, id);
  }
}
