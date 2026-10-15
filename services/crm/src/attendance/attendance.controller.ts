import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { scopeOf } from '@trinity/rbac';
import { AuthOnly, Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { AttendanceService } from './attendance.service';
import { AttendanceExportService } from './attendance-export.service';
import { AttendanceMatrixExportService } from './attendance-matrix-export.service';
import { AttendanceAbsentExportService } from './attendance-absent-export.service';
import { AttendanceStatsExportService } from './attendance-stats-export.service';
import { DeviceCheckDto } from './dto/device-check.dto';
import { QueryAttendanceDto, QueryTodaySummaryDto } from './dto/query-attendance.dto';
import { QueryAttendanceStatsDto } from './dto/query-attendance-stats.dto';
import { QueryAttendanceExportDto } from './dto/query-attendance-export.dto';
import { PatchAttendanceDto } from './dto/patch-attendance.dto';
import { UpdateAttendanceSettingsDto } from './dto/update-attendance-settings.dto';
import { UpdateWorkingSaturdaysDto } from './dto/update-working-saturdays.dto';
import { CreateOfficeDto, UpdateOfficeDto } from './dto/office.dto';
import { CreateAttendanceRequestDto } from './dto/create-attendance-request.dto';
import { UpdateRequestConfigDto } from './dto/update-request-config.dto';
import { QueryAttendanceRequestsDto } from './dto/query-attendance-requests.dto';
import { RejectRequestDto } from './dto/reject-request.dto';
import { SELFIE_MAX_SIZE, SELFIE_ALLOWED_MIME } from './attendance.constants';

/** Cấu hình FileInterceptor cho ảnh selfie chấm công (memoryStorage mặc định → file.buffer sẵn có). */
const selfieInterceptor = FileInterceptor('selfie', {
  limits: { fileSize: SELFIE_MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    // cb(Error) → multer reject với 400 RÕ RÀNG. Nếu cb(null,false) (drop silent) thì service
    // nhận selfie=undefined → báo nhầm "thiếu ảnh" dù user đã đính kèm (vd file .heic của iOS).
    if ((SELFIE_ALLOWED_MIME as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new BadRequestException('Định dạng ảnh không hợp lệ. Chỉ chấp nhận JPEG, PNG, WebP.'),
        false,
      );
    }
  },
});

/**
 * Phạm vi quyền `attendance.view` của user hiện tại — nguồn DUY NHẤT cho mọi
 * quyết định "xem toàn công ty hay chỉ của mình" trong controller này.
 * Vai trò nào được admin cấp scope `all` cho `attendance.view` thì được coi là
 * "quản trị chấm công" — KHÔNG hardcode theo tên vai trò.
 */
function attendanceViewScope(user: AuthUser) {
  return scopeOf(user.grants, 'attendance.view');
}

/** Xem được TOÀN CÔNG TY (scope `all` của attendance.view). */
function isAttendanceFullView(user: AuthUser): boolean {
  return attendanceViewScope(user) === 'all';
}

/** date param YYYY-MM-DD hợp lệ → giữ nguyên; thiếu/sai format → hôm nay (giờ VN). */
function resolveVnDateParam(date?: string): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('management/attendance')
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly attendanceExportService: AttendanceExportService,
    private readonly attendanceMatrixExportService: AttendanceMatrixExportService,
    private readonly attendanceAbsentExportService: AttendanceAbsentExportService,
    private readonly attendanceStatsExportService: AttendanceStatsExportService,
  ) {}

  // ============================================================
  // CẤU HÌNH CA LÀM VIỆC
  // ============================================================

  @Get('settings')
  @AuthOnly()
  @ApiOperation({ summary: 'Lấy cấu hình ca làm việc (giờ vào/ra + mốc đi muộn) — mọi người đã đăng nhập' })
  getSettings() {
    return this.attendanceService.getShiftConfig();
  }

  @Patch('settings')
  @Can('attendance.config')
  @ApiOperation({ summary: 'Cập nhật cấu hình ca làm việc + ngưỡng trạng thái (quyền attendance.config)' })
  updateSettings(@CurrentUser() user: AuthUser, @Body() dto: UpdateAttendanceSettingsDto) {
    return this.attendanceService.updateShiftConfig(dto, user.userId);
  }

  @Get('working-saturdays')
  @AuthOnly()
  @ApiOperation({ summary: 'Danh sách thứ 7 được tính đi làm (mọi người đã đăng nhập — lịch cá nhân cần)' })
  async getWorkingSaturdays() {
    return { dates: await this.attendanceService.getWorkingSaturdays() };
  }

  @Patch('working-saturdays')
  @Can('attendance.config')
  @ApiOperation({ summary: 'Cấu hình thứ 7 đi làm (quyền attendance.config)' })
  updateWorkingSaturdays(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateWorkingSaturdaysDto,
  ) {
    return this.attendanceService.setWorkingSaturdays(dto.dates, user.userId);
  }

  // ============================================================
  // ĐƠN CHẤM CÔNG (ATTENDANCE REQUESTS)
  // ============================================================

  @Get('request-config')
  @AuthOnly()
  @ApiOperation({
    summary:
      'Lấy cấu hình đơn chấm công (mọi người đã đăng nhập — form đơn cần default giờ vào/ra để prefill)',
  })
  getRequestConfig() {
    return this.attendanceService.getRequestConfig();
  }

  @Patch('request-config')
  @Can('attendance.config')
  @ApiOperation({ summary: 'Cập nhật cấu hình giới hạn đơn chấm công (quyền attendance.config)' })
  updateRequestConfig(@CurrentUser() user: AuthUser, @Body() dto: UpdateRequestConfigDto) {
    return this.attendanceService.updateRequestConfig(dto, user.userId);
  }

  @Post('requests')
  @AuthOnly()
  @ApiOperation({ summary: 'Gửi đơn chấm công (mọi nhân viên — chỉ đơn của mình)' })
  @ApiResponse({ status: 201, description: 'Đơn đã được tạo' })
  createRequest(@CurrentUser() user: AuthUser, @Body() dto: CreateAttendanceRequestDto) {
    return this.attendanceService.createRequest(user.userId, dto);
  }

  @Get('requests')
  @Can('attendance.view')
  @ApiOperation({ summary: 'Danh sách đơn chấm công (theo phạm vi attendance.view; ngoài phạm vi: của mình)' })
  async listRequests(@CurrentUser() user: AuthUser, @Query() dto: QueryAttendanceRequestsDto) {
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.view');
    return this.attendanceService.listRequests(user.userId, owner, dto);
  }

  @Post('requests/:id/approve')
  @Can('attendance.manage')
  @ApiOperation({ summary: 'Duyệt đơn chấm công và cập nhật bản ghi (quyền attendance.manage)' })
  async approveRequest(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.manage');
    return this.attendanceService.approveRequest(id, user.userId, owner);
  }

  @Post('requests/:id/reject')
  @Can('attendance.manage')
  @ApiOperation({ summary: 'Từ chối đơn chấm công (quyền attendance.manage)' })
  async rejectRequest(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Body() dto: RejectRequestDto,
  ) {
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.manage');
    return this.attendanceService.rejectRequest(id, user.userId, dto, owner);
  }

  // ============================================================
  // CHECK-IN / CHECK-OUT (IP + Device Token)
  // ============================================================

  @Post('check-in')
  @AuthOnly()
  @UseInterceptors(selfieInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Chấm công vào — xác thực IP văn phòng + ảnh selfie (bắt buộc)' })
  @ApiResponse({ status: 201, description: 'Chấm công vào thành công' })
  checkIn(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeviceCheckDto,
    @UploadedFile() selfie: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    return this.attendanceService.checkIn(user.userId, dto.device_id, req, dto.note, selfie, user.isAdmin);
  }

  @Post('check-out')
  @AuthOnly()
  @UseInterceptors(selfieInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Chấm công ra — xác thực IP văn phòng + thiết bị + ảnh selfie (bắt buộc)' })
  @ApiResponse({ status: 201, description: 'Chấm công ra thành công' })
  checkOut(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeviceCheckDto,
    @UploadedFile() selfie: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    return this.attendanceService.checkOut(user.userId, dto.device_id, req, dto.note, selfie, user.isAdmin);
  }

  // ============================================================
  // STREAM ẢNH SELFIE (proof) — IDOR guard ở service
  // ============================================================

  @Get(':id(\\d+)/proof/:slot')
  @Can('attendance.view')
  @ApiOperation({ summary: 'Xem ảnh selfie chấm công (vào/ra) — stream qua BE proxy, IDOR-guarded' })
  @ApiResponse({ status: 200, description: 'Ảnh selfie (image stream)' })
  @ApiResponse({ status: 403, description: 'Không có quyền xem bản ghi này' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy bản ghi hoặc ảnh' })
  async getProof(
    @Param('id', ParseIntPipe) id: number,
    @Param('slot') slot: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (slot !== 'in' && slot !== 'out') {
      throw new BadRequestException("slot phải là 'in' hoặc 'out'.");
    }
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.view');
    const { body, contentType, contentLength } =
      await this.attendanceService.streamProof(id, slot, user.userId, owner);
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      ...(contentLength != null ? { 'Content-Length': String(contentLength) } : {}),
    });
    return new StreamableFile(body);
  }

  // ============================================================
  // OFFICE MANAGEMENT
  // ============================================================

  @Get('offices')
  @Can('attendance.view')
  @ApiOperation({ summary: 'Danh sách văn phòng (quyền attendance.view)' })
  listOffices() {
    return this.attendanceService.listOffices();
  }

  @Post('offices')
  @Can('attendance.config')
  @ApiOperation({ summary: 'Thêm văn phòng mới (quyền attendance.config)' })
  @ApiResponse({ status: 201, description: 'Văn phòng đã tạo' })
  createOffice(@Body() dto: CreateOfficeDto) {
    return this.attendanceService.createOffice(dto);
  }

  @Patch('offices/:id')
  @Can('attendance.config')
  @ApiOperation({ summary: 'Cập nhật văn phòng (quyền attendance.config)' })
  updateOffice(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateOfficeDto) {
    return this.attendanceService.updateOffice(id, dto);
  }

  @Delete('offices/:id')
  @Can('attendance.config')
  @ApiOperation({ summary: 'Xóa văn phòng (quyền attendance.config)' })
  deleteOffice(@Param('id', ParseIntPipe) id: number) {
    return this.attendanceService.deleteOffice(id);
  }

  // ============================================================
  // RESET DEVICE
  // ============================================================

  @Post('reset-device/:userId')
  @Can('attendance.config')
  @ApiOperation({ summary: 'Reset thiết bị đã đăng ký của nhân viên (quyền attendance.config)' })
  resetDevice(@Param('userId', ParseIntPipe) employeeUserId: number) {
    return this.attendanceService.resetDevice(employeeUserId);
  }

  // ============================================================
  // TODAY SUMMARY — "của tôi" (AuthOnly + lọc userId,
  // vẫn hiện thêm số liệu toàn công ty NẾU user đang giữ attendance.view=all)
  // ============================================================

  @Get('today')
  @AuthOnly()
  @ApiOperation({ summary: 'Tóm tắt chấm công hôm nay (của tôi; toàn công ty nếu có attendance.view=all)' })
  getTodaySummary(@CurrentUser() user: AuthUser, @Query() dto: QueryTodaySummaryDto) {
    return this.attendanceService.getTodaySummary(user.userId, isAttendanceFullView(user), dto);
  }

  @Get('workdays-matrix')
  @Can('attendance.view')
  @ApiOperation({
    summary: 'Bảng chấm công tháng — lưới NV × ngày (quyền attendance.view)',
  })
  async getWorkdaysMatrix(@CurrentUser() user: AuthUser, @Query() dto: QueryAttendanceDto) {
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.view');
    return this.attendanceService.getWorkdaysMatrix(dto, owner);
  }

  @Get('workdays-matrix/export')
  @Can('attendance.export')
  @ApiOperation({ summary: 'Xuất Excel bảng chấm công tháng (quyền attendance.export)' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Trả về file Excel (.xlsx)' })
  async exportMatrix(
    @CurrentUser() user: AuthUser,
    @Query() dto: QueryAttendanceExportDto,
    @Res() res: Response,
  ) {
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.export');
    const buffer = await this.attendanceMatrixExportService.exportMatrixToExcel(dto, owner);
    const fileName = `bang-cong-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // ============================================================
  // SỔ CHẤM CÔNG
  // ============================================================

  @Get()
  @Can('attendance.view')
  @ApiOperation({ summary: 'Danh sách bản ghi chấm công (sổ chấm công)' })
  async listRecords(@CurrentUser() user: AuthUser, @Query() dto: QueryAttendanceDto) {
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.view');
    return this.attendanceService.listRecords(user.userId, owner, dto);
  }

  @Get('export')
  @Can('attendance.export')
  @ApiOperation({ summary: 'Xuất Excel chấm công theo khoảng ngày (quyền attendance.export)' })
  @ApiProduces(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @ApiResponse({ status: 200, description: 'Trả về file Excel (.xlsx)' })
  async exportExcel(
    @CurrentUser() user: AuthUser,
    @Query() dto: QueryAttendanceExportDto,
    @Res() res: Response,
  ) {
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.export');
    const buffer = await this.attendanceExportService.exportToExcel(dto, owner);
    const fileName = `cham-cong-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Get(':id(\\d+)')
  @Can('attendance.view')
  @ApiOperation({ summary: 'Chi tiết 1 bản ghi chấm công' })
  async getRecord(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.view');
    return this.attendanceService.getRecordById(id, user.userId, owner);
  }

  @Patch(':id(\\d+)')
  @Can('attendance.manage')
  @ApiOperation({ summary: 'Sửa bản ghi chấm công thủ công (quyền attendance.manage)' })
  async patchRecord(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PatchAttendanceDto,
    @CurrentUser() user: AuthUser,
  ) {
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.manage');
    return this.attendanceService.patchRecord(id, dto, owner);
  }

  @Delete(':id(\\d+)')
  @Can('attendance.manage')
  @ApiOperation({
    summary: 'Xóa bản ghi chấm công để nhân viên chấm lại (quyền attendance.manage)',
  })
  @ApiResponse({ status: 200, description: 'Đã xóa bản ghi chấm công' })
  async deleteRecord(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const owner = await this.attendanceService.resolveOwnerIds(user, 'attendance.manage');
    return this.attendanceService.deleteRecord(id, user.userId, owner);
  }

  // ============================================================
  // THỐNG KÊ
  // ============================================================

  @Get('stats')
  @Can('attendance.view')
  @ApiOperation({
    summary: 'Thống kê chấm công tổng hợp cho popup biểu đồ (theo phạm vi attendance.view)',
  })
  async getStats(
    @Query() dto: QueryAttendanceStatsDto,
    @CurrentUser() user: AuthUser,
  ) {
    const scope = await this.attendanceService.resolveStatsScope(user);
    return this.attendanceService.getAttendanceStats(dto, scope);
  }

  @Get('stats/filters')
  @Can('attendance.view')
  @ApiOperation({
    summary: 'Tuỳ chọn bộ lọc thống kê (Phòng ban / Team / Văn phòng)',
  })
  async getStatsFilters(@CurrentUser() user: AuthUser) {
    const scope = await this.attendanceService.resolveStatsScope(user);
    return this.attendanceService.getStatsFilterOptions(scope);
  }

  @Get('stats/export-by-team')
  @Can('attendance.export')
  @ApiOperation({ summary: 'Xuất Excel thống kê chấm công theo Team' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Trả về file Excel (.xlsx)' })
  async exportByTeam(
    @Query() dto: QueryAttendanceStatsDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const scope = await this.attendanceService.resolveStatsScope(user);
    const buffer = await this.attendanceStatsExportService.exportByTeam(dto, scope);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="thong-ke-cham-cong-theo-team.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Get('stats/export-by-department')
  @Can('attendance.export')
  @ApiOperation({ summary: 'Xuất Excel thống kê chấm công theo Phòng ban' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Trả về file Excel (.xlsx)' })
  async exportByDepartment(
    @Query() dto: QueryAttendanceStatsDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const scope = await this.attendanceService.resolveStatsScope(user);
    const buffer = await this.attendanceStatsExportService.exportByDepartment(
      dto,
      scope,
    );
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="thong-ke-cham-cong-theo-phong-ban.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Get('stats/discipline')
  @Can('attendance.view')
  @ApiOperation({ summary: 'Thống kê kỷ luật: top nghỉ / đi muộn-về sớm / theo giới tính' })
  async getDisciplineStats(
    @Query() dto: QueryAttendanceStatsDto,
    @CurrentUser() user: AuthUser,
  ) {
    const scope = await this.attendanceService.resolveStatsScope(user);
    return this.attendanceService.getDisciplineStats(dto, scope);
  }

  @Get('stats/leave-analytics')
  @Can('attendance.view')
  @ApiOperation({
    summary:
      'Phân tích nghỉ phép: theo loại đơn / theo tuần × phòng ban / theo giới tính',
  })
  async getLeaveAnalytics(
    @Query() dto: QueryAttendanceStatsDto,
    @CurrentUser() user: AuthUser,
  ) {
    const scope = await this.attendanceService.resolveStatsScope(user);
    return this.attendanceService.getLeaveAnalytics(dto, scope);
  }

  @Get('stats/export-top-absent')
  @Can('attendance.export')
  @ApiOperation({ summary: 'Xuất Excel Top NV nghỉ nhiều nhất' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Trả về file Excel (.xlsx)' })
  async exportTopAbsent(
    @Query() dto: QueryAttendanceStatsDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const scope = await this.attendanceService.resolveStatsScope(user);
    const buffer = await this.attendanceStatsExportService.exportTopAbsent(dto, scope);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="top-nv-nghi-nhieu.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Get('stats/export-top-late-early')
  @Can('attendance.export')
  @ApiOperation({ summary: 'Xuất Excel Top NV đi muộn / về sớm nhiều nhất' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Trả về file Excel (.xlsx)' })
  async exportTopLateEarly(
    @Query() dto: QueryAttendanceStatsDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const scope = await this.attendanceService.resolveStatsScope(user);
    const buffer = await this.attendanceStatsExportService.exportTopLateEarly(dto, scope);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="top-nv-di-muon-ve-som.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Get('stats/export-by-gender')
  @Can('attendance.export')
  @ApiOperation({ summary: 'Xuất Excel so sánh chấm công theo giới tính' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Trả về file Excel (.xlsx)' })
  async exportByGender(
    @Query() dto: QueryAttendanceStatsDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const scope = await this.attendanceService.resolveStatsScope(user);
    const buffer = await this.attendanceStatsExportService.exportByGender(dto, scope);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="thong-ke-cham-cong-theo-gioi-tinh.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Get('absent')
  @Can('attendance.view')
  @ApiOperation({
    summary:
      'Danh sách NV chưa chấm công (vắng) trong 1 ngày — date + sort tùy chọn (theo phạm vi attendance.view)',
  })
  async getAbsent(
    @CurrentUser() user: AuthUser,
    @Query('date') date?: string,
    @Query('sort_by') sortBy?: string,
    @Query('sort_dir') sortDir?: string,
  ) {
    const dateStr = resolveVnDateParam(date);
    const scope = await this.attendanceService.resolveStatsScope(user);
    return {
      absent_date: dateStr,
      absent_employees: await this.attendanceService.getAbsentEmployees(
        dateStr,
        sortBy,
        sortDir,
        scope,
      ),
    };
  }

  @Get('absent-export')
  @Can('attendance.export')
  @ApiOperation({
    summary:
      'Xuất Excel danh sách NV chưa chấm công (vắng) trong 1 ngày (theo phạm vi attendance.view)',
  })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Trả về file Excel (.xlsx)' })
  async exportAbsent(
    @CurrentUser() user: AuthUser,
    @Query('date') date: string | undefined,
    @Res() res: Response,
    @Query('sort_by') sortBy?: string,
    @Query('sort_dir') sortDir?: string,
  ) {
    const dateStr = resolveVnDateParam(date);
    const scope = await this.attendanceService.resolveStatsScope(user);
    const buffer = await this.attendanceAbsentExportService.exportAbsentToExcel(
      dateStr,
      sortBy,
      sortDir,
      scope,
    );
    const fileName = `nv-chua-cham-cong_${dateStr}.xlsx`;
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Get('stats/weekly')
  @AuthOnly()
  @ApiOperation({ summary: 'Giờ làm 7 ngày qua (của tôi; toàn công ty nếu có attendance.view=all)' })
  getWeeklyStats(@CurrentUser() user: AuthUser, @Query('user_id') userIdStr?: string) {
    const targetUserId = userIdStr ? parseInt(userIdStr, 10) : undefined;
    return this.attendanceService.getWeeklyStats(user.userId, isAttendanceFullView(user), targetUserId);
  }

  @Get('stats/monthly')
  @AuthOnly()
  @ApiOperation({ summary: 'Tổng giờ tháng (của tôi; toàn công ty nếu có attendance.view=all)' })
  getMonthlyStats(
    @CurrentUser() user: AuthUser,
    @Query('user_id') userIdStr?: string,
    @Query('month') month?: string,
  ) {
    const targetUserId = userIdStr ? parseInt(userIdStr, 10) : undefined;
    return this.attendanceService.getMonthlyStats(user.userId, isAttendanceFullView(user), targetUserId, month);
  }

  @Get('stats/weekly-hours')
  @AuthOnly()
  @ApiOperation({
    summary:
      'Biểu đồ đường tổng giờ làm theo khoảng tuỳ chọn (mặc định 7 ngày; toàn công ty nếu có attendance.view=all, ngược lại cá nhân)',
  })
  getWeeklyHoursChart(
    @CurrentUser() user: AuthUser,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
  ) {
    return this.attendanceService.getWeeklyHoursChart(
      user.userId,
      isAttendanceFullView(user),
      dateFrom,
      dateTo,
    );
  }
}
