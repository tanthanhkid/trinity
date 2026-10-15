import { BadRequestException, Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CanAny, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { RecordLinksService } from './record-links.service';
import { RecordRefsService, SUGGEST_MAX } from './record-refs.service';
import { RefPreviewService } from './ref-preview.service';
import { REF_TYPES, type RefType } from './ref-types';

export class RefSuggestQueryDto {
  @ApiPropertyOptional({ description: 'Chữ sau dấu @: đầu mã (HS, HS001) hoặc tên (Nguyễn)' })
  @IsOptional() @IsString() @MaxLength(60)
  q?: string;

  @ApiPropertyOptional({ default: 8, maximum: SUGGEST_MAX })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(SUGGEST_MAX)
  limit?: number;
}

export class RefResolveQueryDto {
  @ApiProperty({ description: 'Danh sách mã, cách nhau dấu phẩy (tối đa 50), vd HS001,KH002' })
  @IsString() @MaxLength(600)
  codes!: string;
}

const READ = ['custom_records.view', 'contacts.view', 'deals.view', 'kanban.view'] as const;

function refType(raw: string): RefType {
  if (!(REF_TYPES as readonly string[]).includes(raw)) throw new BadRequestException('Loại bản ghi không hợp lệ');
  return raw as RefType;
}

/**
 * Gắn thẻ @ giữa các màn: gợi ý theo mã/tên trên mọi bảng, giải mã → bản ghi, truy ngược, xem nhanh. MỌI kết quả lọc theo quyền
 * xem của người hỏi (bảng nào không có quyền ⇒ không xuất hiện); bản ghi ngoài phạm vi theo id ⇒ 404.
 */
@ApiTags('Record refs')
@ApiBearerAuth()
@Controller('refs')
export class RecordRefsController {
  constructor(private readonly refs: RecordRefsService, private readonly links: RecordLinksService, private readonly previews: RefPreviewService) {}

  @Get('suggest')
  @CanAny(...READ)
  @ApiOperation({ summary: 'Gợi ý bản ghi cho @ (mã khớp trước, rồi tên)' })
  suggest(@Query() q: RefSuggestQueryDto, @CurrentUser() user: AuthUser) {
    return this.refs.suggest(user, q.q ?? '', q.limit ?? 8);
  }

  @Get('resolve')
  @CanAny(...READ)
  @ApiOperation({ summary: 'Mã → bản ghi người xem thấy (mã cũ qua tiền tố cũ vẫn ra); mã không thấy thì không có trong kết quả' })
  async resolve(@Query() q: RefResolveQueryDto, @CurrentUser() user: AuthUser) {
    const codes = q.codes.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 50);
    const map = await this.refs.resolveCodes(user, codes);
    return [...map.entries()].map(([code, v]) => ({ ...v, requested: code }));
  }

  @Get(':type/:id/backlinks')
  @CanAny(...READ)
  @ApiOperation({ summary: '“Được nhắc tới ở”: bản ghi đang gắn thẻ / liên kết tới bản ghi này (chỉ phần người xem thấy)' })
  @ApiResponse({ status: 404, description: 'Không tồn tại hoặc ngoài phạm vi' })
  backlinks(@Param('type') type: string, @Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.links.backlinks(user, { type: refType(type), id });
  }

  @Get(':type/:id/preview')
  @CanAny(...READ)
  @ApiOperation({ summary: 'Xem nhanh bản ghi (rê chuột vào thẻ @)' })
  @ApiResponse({ status: 404, description: 'Không tồn tại hoặc ngoài phạm vi' })
  preview(@Param('type') type: string, @Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.previews.preview(user, { type: refType(type), id });
  }
}
