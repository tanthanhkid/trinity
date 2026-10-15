import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Res,
  ParseIntPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiProduces,
  ApiQuery,
} from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { ContactsService } from './contacts.service';
import { RecordLinksService } from '../custom-objects/refs/record-links.service';
import { ContactsExportService } from './contacts-export.service';
import { ContactTransferService } from './contact-transfer.service';
import { ContactRecentViewsService } from './contact-recent-views.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { QueryContactDto } from './dto/query-contact.dto';
import { TransferContactDto } from './dto/transfer-contact.dto';
import { BulkTransferContactsDto } from './dto/bulk-transfer-contacts.dto';

/**
 * RBAC quyền + phạm vi (`@Can`).
 *
 * `contacts.view` (scoped): danh sách + chi tiết — owner = `assigned_to` HOẶC
 * `created_by_id` (cùng một định nghĩa "own" cho mọi người giữ quyền).
 * `contacts.update`: sửa; cần thêm `contacts.phone_full` (phủ owner) nếu
 * `dto.phone !== undefined`.
 * `contacts.delete`: xoá.
 * `contacts.transfer`: chuyển quyền phụ trách (1 hoặc nhiều), danh sách
 * người nhận assignable-users / assignable-sales.
 * `contacts.export` + `contacts.phone_full`: xuất Excel (SĐT che theo phone_full).
 * `contacts.create`: tạo mới, tra cứu nhanh trước khi tạo
 * (`/search` — BYPASS scope có chủ đích).
 * `contacts.catalog`: không dùng ở controller này (xem `settings-options`).
 *
 * Không còn khái niệm "role bị deny cứng" (`CONTACT_DENIED_ROLES` cũ) — admin
 * không cấp `contacts.view` cho 1 vai trò là vai trò đó tự 403 (deny-by-default).
 */
@ApiTags('Contacts')
@ApiBearerAuth()
@Controller('contacts')
export class ContactsController {
  constructor(
    private readonly contactsService: ContactsService,
    private readonly contactsExportService: ContactsExportService,
    private readonly contactTransferService: ContactTransferService,
    private readonly contactRecentViewsService: ContactRecentViewsService,
    private readonly recordLinks: RecordLinksService,
  ) {}

  @Get()
  @Can('contacts.view')
  @ApiOperation({
    summary: 'Danh sách contacts (cursor pagination)',
    description:
      'Trả về contacts trong phạm vi quyền `contacts.view` (own/team/subtree/all).',
  })
  @ApiResponse({ status: 200, description: 'Trả về danh sách contacts và next_cursor' })
  @ApiResponse({ status: 403, description: 'Không có quyền contacts.view' })
  async findAll(@Query() query: QueryContactDto, @CurrentUser() user: AuthUser) {
    return this.contactsService.findAll(query, user);
  }

  /**
   * Xuất Excel danh bạ trong phạm vi `contacts.view`, ÁP filter UI đang chọn
   *. Cột SĐT/SĐT phụ che theo `contacts.phone_full`
   * per-row (Mẫu C) — KHÔNG còn "chỉ super_admin mới thấy cột" như hệ cũ; ai
   * có `contacts.phone_full` phủ đúng owner của dòng đó thì thấy dòng đó.
   */
  @Get('export')
  @Can('contacts.export')
  @ApiOperation({
    summary: 'Xuất file Excel khách hàng theo bộ lọc đang chọn (trong phạm vi quyền)',
    description:
      'Tối đa 20.000 bản ghi MỚI NHẤT trong phạm vi đã lọc. SĐT/SĐT phụ che theo ' +
      '`contacts.phone_full` (per-row, không phải per-role).',
  })
  @ApiResponse({ status: 200, description: 'Trả về file Excel (.xlsx)' })
  @ApiResponse({ status: 403, description: 'Không có quyền contacts.export' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportExcel(
    @Query() query: QueryContactDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.contactsExportService.exportToExcel(user, query);
    const fileName = `khach-hang-${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  /**
   * BYPASS phạm vi `contacts.view` có chủ đích —
   * cần `contacts.create` để dùng: người sắp tạo contact cần tra SĐT/
   * tên bất kể đang thuộc phạm vi ai, tránh tạo trùng. Trả tối thiểu
   * {id, phone, full_name, source_id} — không lộ dữ liệu chi tiết.
   */
  @Get('search')
  @Can('contacts.create')
  @ApiOperation({
    summary: 'Tìm kiếm contact theo SĐT hoặc tên',
    description:
      'Tìm kiếm nhanh theo SĐT (digits) hoặc tên (insensitive). ' +
      'BYPASS phạm vi contacts.view có chủ đích. Giới hạn 20 kết quả.',
  })
  @ApiResponse({ status: 200, description: 'Trả về danh sách contacts phù hợp' })
  async search(@Query('q') q: string, @CurrentUser() user: AuthUser) {
    return this.contactsService.search(q ?? '', user);
  }

  /**
   * Thay `GET /contacts/filter-users` cũ (hack riêng cho 1 vai trò) — Mẫu D:
   * trả người trong phạm vi `contacts.view` của CHÍNH người gọi, dùng cho mọi
   * dropdown lọc nhân sự trên Danh bạ, không phân biệt vai trò.
   */
  @Get('assignable-users')
  @Can('contacts.view')
  @ApiOperation({
    summary: 'Danh sách nhân sự trong phạm vi contacts.view (Mẫu D, thay /filter-users cũ)',
  })
  @ApiResponse({ status: 200, description: 'Danh sách nhân sự trong phạm vi' })
  async assignableUsers(@CurrentUser() user: AuthUser) {
    return this.contactsService.listAssignableUsers(user);
  }

  /**
   * danh sách nhân sự ACTIVE trong phạm vi `contacts.transfer`
   * để chọn khi chuyển quyền phụ trách liên hệ.
   */
  @Get('assignable-sales')
  @Can('contacts.transfer')
  @ApiOperation({
    summary: 'Danh sách nhân sự được phép nhận chuyển liên hệ',
    description: 'Trả người ACTIVE trong phạm vi contacts.transfer của người gọi.',
  })
  @ApiResponse({ status: 200, description: 'Danh sách nhân sự active trong phạm vi' })
  async assignableSales(@CurrentUser() user: AuthUser) {
    return this.contactTransferService.getAssignableSales(user);
  }

  /**
   * chuyển quyền phụ trách NHIỀU liên hệ cùng lúc.
   */
  @Post('bulk-transfer')
  @Can('contacts.transfer')
  @ApiOperation({
    summary: 'Chuyển quyền phụ trách nhiều liên hệ cùng lúc',
    description:
      'CHỈ đổi contacts.assigned_to.',
  })
  @ApiResponse({ status: 200, description: 'Kết quả chuyển: transferredIds + failed[]' })
  @ApiResponse({ status: 400, description: 'Không chuyển được khách hàng nào' })
  async bulkTransfer(@Body() dto: BulkTransferContactsDto, @CurrentUser() user: AuthUser) {
    return this.contactTransferService.bulkTransfer(
      dto.contact_ids,
      dto.new_assigned_to,
      dto.reason ?? '',
      user,
    );
  }

  /**
   * chuyển quyền phụ trách 1 liên hệ cho người khác.
   */
  @Post(':id/transfer')
  @Can('contacts.transfer')
  @ApiOperation({ summary: 'Chuyển quyền phụ trách 1 liên hệ' })
  @ApiResponse({ status: 200, description: 'Chuyển thành công' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy khách hàng / ngoài phạm vi' })
  @ApiResponse({ status: 400, description: 'Người được chọn không hợp lệ' })
  @ApiParam({ name: 'id', type: Number, description: 'Contact ID' })
  async transferContact(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TransferContactDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.contactTransferService.transfer(id, dto.new_assigned_to, dto.reason ?? '', user);
  }

  /**
   * "KHÁCH GẦN ĐÂY" ở sidebar — mirror gate TRANG CHI TIẾT
   * (`contacts.view`, đánh giá LẠI tại thời điểm đọc), KHÔNG hiện SĐT.
   */
  @Get('recent')
  @Can('contacts.view')
  @ApiOperation({ summary: 'Khách hàng vừa mở gần đây' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Mặc định 5, tối đa 10' })
  @ApiResponse({ status: 200, description: 'Danh sách khách gần đây trong phạm vi hiện tại' })
  async recent(@Query('limit') limit: string | undefined, @CurrentUser() user: AuthUser) {
    const parsedLimit = limit !== undefined ? Number(limit) : undefined;
    return this.contactRecentViewsService.listRecent(
      user,
      Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    );
  }

  /**
   * Ghi nhận user vừa mở trang chi tiết 1 khách hàng — nguồn cho "KHÁCH GẦN
   * ĐÂY".
   */
  @Post(':id/viewed')
  @Can('contacts.view')
  @ApiOperation({ summary: 'Ghi nhận vừa xem khách hàng' })
  @ApiResponse({ status: 200, description: 'Đã ghi nhận' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy khách hàng / ngoài phạm vi' })
  @ApiParam({ name: 'id', type: Number, description: 'Contact ID' })
  async markViewed(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ success: true }> {
    await this.contactRecentViewsService.recordView(user, id);
    return { success: true };
  }

  @Get(':id')
  @Can('contacts.view')
  @ApiOperation({
    summary: 'Chi tiết contact',
    description:
      'SĐT đầy đủ hiện theo `contacts.phone_full` (Mẫu C) — không còn set vai trò riêng cho list/detail.',
  })
  @ApiResponse({ status: 200, description: 'Trả về chi tiết contact' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy hoặc ngoài phạm vi' })
  @ApiParam({ name: 'id', type: Number, description: 'Contact ID' })
  async findById(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.contactsService.findById(id, user);
  }

  @Post()
  @Can('contacts.create')
  @ApiOperation({
    summary: 'Tạo contact mới',
    description:
      'CHẶN SĐT trùng THEO người phụ trách — 409 nếu trùng cùng người phụ trách.',
  })
  @ApiResponse({ status: 201, description: 'Contact đã được tạo' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  @ApiResponse({ status: 409, description: 'SĐT đã có khách hàng khác CÙNG người phụ trách' })
  async create(@Body() dto: CreateContactDto, @CurrentUser() user: AuthUser) {
    return this.contactsService.create(dto, user);
  }

  @Patch(':id')
  @Can('contacts.update')
  @ApiOperation({
    summary: 'Cập nhật contact',
    description:
      'Lock 3 field: phone/full_name/source_id ngoài luật backfill. Sửa `phone` cần thêm ' +
      '`contacts.phone_full` phủ owner. Đổi `assigned_to` cần `contacts.transfer` phủ đích.',
  })
  @ApiResponse({ status: 200, description: 'Contact đã được cập nhật' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy hoặc ngoài phạm vi' })
  @ApiResponse({ status: 403, description: 'Thiếu quyền phone_full/transfer cho thay đổi này' })
  @ApiParam({ name: 'id', type: Number, description: 'Contact ID' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateContactDto,
    @CurrentUser() user: AuthUser,
  ) {
    const updated = await this.contactsService.update(id, dto, user);
    // Thẻ @ trong "Ghi chú nhắc" → "Được nhắc tới ở" của bản ghi được nhắc (chỉ khi lần sửa này có đụng tới ô đó).
    if (dto.reminder_notes !== undefined) await this.recordLinks.syncMentions({ type: 'contact', id }, 'reminder_notes', dto.reminder_notes, user);
    return updated;
  }

  @Delete(':id')
  @Can('contacts.delete')
  @ApiOperation({ summary: 'Xoá contact' })
  @ApiResponse({ status: 200, description: 'Đã xoá contact thành công' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy hoặc ngoài phạm vi' })
  @ApiParam({ name: 'id', type: Number, description: 'Contact ID' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.contactsService.remove(id, user);
  }
}
