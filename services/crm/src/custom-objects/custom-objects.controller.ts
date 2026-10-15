import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CanAny, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { CustomFieldsService } from './custom-fields.service';
import { CustomObjectsService } from './custom-objects.service';
import { CustomObjectTemplatesService } from './custom-object-templates.service';
import { CustomRecordsListService } from './custom-records-list.service';
import { CustomViewsService } from './custom-views.service';
import { ApplyTemplateDto, CreateCustomObjectDto, UpdateCustomObjectDto } from './dto/custom-object.dto';
import { CreateCustomFieldDto, FormulaPreviewDto, ReorderCustomFieldsDto, UpdateCustomFieldDto } from './dto/custom-field.dto';
import { LookupQueryDto } from './dto/custom-record.dto';

/**
 * Định nghĩa “tính năng tuỳ biến”. Cấu hình = `custom_objects.manage`; menu/tra cứu = quyền xem dữ liệu.
 * 🔴 Thứ tự khai báo quan trọng: các đường TĨNH (`nav`, `lookup/*`, `formula/preview`) PHẢI đứng trước `:key`.
 */
@ApiTags('Custom Objects')
@ApiBearerAuth()
@Controller('custom-objects')
export class CustomObjectsController {
  constructor(
    private readonly objects: CustomObjectsService,
    private readonly fields: CustomFieldsService,
    private readonly lookups: CustomRecordsListService,
    private readonly templates: CustomObjectTemplatesService,
    private readonly views: CustomViewsService,
  ) {}

  @Get()
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Danh sách tính năng tuỳ biến (cấu hình)' })
  list() {
    return this.objects.list();
  }

  @Post()
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Thêm tính năng tuỳ biến' })
  @ApiResponse({ status: 409, description: 'Mã đã dùng' })
  create(@Body() dto: CreateCustomObjectDto, @CurrentUser() user: AuthUser) {
    return this.objects.create(dto, user);
  }

  @Get('nav')
  @Can('custom_records.view')
  @ApiOperation({ summary: 'Các tính năng hiện trên menu của người dùng hiện tại' })
  nav(@CurrentUser() user: AuthUser) {
    return this.objects.nav(user);
  }

  @Get('lookup/users')
  @CanAny('custom_records.view', 'custom_records.manage')
  @ApiOperation({ summary: 'Chọn người (trường “người dùng”, người phụ trách) — chỉ người trong phạm vi' })
  lookupUsers(@Query() q: LookupQueryDto, @CurrentUser() user: AuthUser) {
    return this.lookups.lookupUsers(user, q);
  }

  @Get('lookup/contacts')
  @CanAny('custom_records.view', 'custom_records.manage')
  @ApiOperation({ summary: 'Chọn khách hàng (trường liên kết → Danh bạ) — chỉ khách trong phạm vi contacts.view' })
  lookupContacts(@Query() q: LookupQueryDto, @CurrentUser() user: AuthUser) {
    return this.lookups.lookupContacts(user, q);
  }

  @Post('formula/preview')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Xem trước / kiểm tra biểu thức công thức' })
  previewFormula(@Body() dto: FormulaPreviewDto, @CurrentUser() user: AuthUser) {
    return this.fields.previewFormula(dto, user);
  }

  @Get('templates')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Mẫu tính năng dựng sẵn (vd Trung tâm giáo dục) + đã áp chưa' })
  listTemplates() {
    return this.templates.list();
  }

  @Post('templates/:template/apply')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Áp mẫu: tạo thực thể + trường + liên kết (idempotent theo key); with_sample_data tạo thêm dữ liệu GIẢ' })
  @ApiResponse({ status: 404, description: 'Không có mẫu này' })
  applyTemplate(@Param('template') template: string, @Body() dto: ApplyTemplateDto, @CurrentUser() user: AuthUser) {
    return this.templates.apply(user, template, dto.with_sample_data === true);
  }

  @Get(':key')
  @CanAny('custom_records.view', 'custom_objects.manage')
  @ApiOperation({ summary: 'Định nghĩa 1 tính năng + các trường' })
  @ApiResponse({ status: 404, description: 'Không tồn tại hoặc vai trò của bạn không được thấy' })
  get(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.objects.getDefinition(user, key);
  }

  @Get(':key/views')
  @Can('custom_records.view')
  @ApiOperation({ summary: 'Các màn xem (danh sách/kanban) của bảng; tạo/sửa qua AI (MCP) theo quyền của người kết nối' })
  listViews(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.views.list(user, key);
  }

  @Get(':key/views/:view')
  @Can('custom_records.view')
  @ApiOperation({ summary: 'Một màn xem của bảng' })
  @ApiResponse({ status: 404, description: 'Không có / không được thấy' })
  getView(@Param('key') key: string, @Param('view') view: string, @CurrentUser() user: AuthUser) {
    return this.views.get(user, key, view);
  }

  @Patch(':key')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Sửa tính năng (tên, icon, menu, vai trò được thấy…)' })
  update(@Param('key') key: string, @Body() dto: UpdateCustomObjectDto, @CurrentUser() user: AuthUser) {
    return this.objects.update(key, dto, user);
  }

  @Delete(':key')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Xoá (mềm) tính năng' })
  remove(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.objects.remove(key, user);
  }

  @Post(':key/fields')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Thêm trường' })
  addField(@Param('key') key: string, @Body() dto: CreateCustomFieldDto, @CurrentUser() user: AuthUser) {
    return this.fields.create(key, dto, user);
  }

  @Put(':key/fields/order')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Đổi thứ tự trường' })
  reorder(@Param('key') key: string, @Body() dto: ReorderCustomFieldsDto, @CurrentUser() user: AuthUser) {
    return this.fields.reorder(key, dto, user);
  }

  @Patch(':key/fields/:fieldKey')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Sửa trường' })
  updateField(
    @Param('key') key: string,
    @Param('fieldKey') fieldKey: string,
    @Body() dto: UpdateCustomFieldDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fields.update(key, fieldKey, dto, user);
  }

  @Delete(':key/fields/:fieldKey')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Xoá (mềm) trường' })
  removeField(@Param('key') key: string, @Param('fieldKey') fieldKey: string, @CurrentUser() user: AuthUser) {
    return this.fields.remove(key, fieldKey, user);
  }
}
