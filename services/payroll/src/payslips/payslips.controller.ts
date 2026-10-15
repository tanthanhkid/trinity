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
  BadRequestException,
  ParseIntPipe,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiProduces,
} from '@nestjs/swagger'
import { Response } from 'express'
import { Can, CanAny, AuthOnly, CurrentUser, AuthUser } from '@trinity/rbac-nest'
import { PayslipsService, ImportPreviewRow } from './payslips.service'
import { ApprovePayslipDto } from './dto/approve-payslip.dto'
import { GeneratePayslipsDto } from './dto/generate-payslips.dto'
import { QueryPayslipsDto } from './dto/query-payslips.dto'
import { UpdatePayslipDto } from './dto/update-payslip.dto'
import { BulkExcelPayslipsDto } from './dto/bulk-excel-payslips.dto'
import { ListExcelPayslipsDto } from './dto/list-excel-payslips.dto'
import { AddToPeriodDto } from './dto/add-to-period.dto'

// Tệp upload (memory storage) — định nghĩa cục bộ để KHÔNG phụ thuộc @types/multer
// (namespace Express.Multer chưa resolve trong service payroll). Chỉ khai báo trường dùng.
interface UploadedXlsxFile {
  buffer: Buffer
  originalname: string
  mimetype: string
  size: number
}

@ApiTags('payslips')
@ApiBearerAuth()
@Controller('payslips')
export class PayslipsController {
  constructor(private readonly payslipsService: PayslipsService) {}

  // Phiếu lương của CHÍNH MÌNH — mọi người đăng nhập gọi được, KHÔNG cần
  // `payroll.view` (@AuthOnly + lọc theo user.id). PHẢI khai báo
  // TRƯỚC @Get(':id') (Express match theo thứ tự).
  @Get('me')
  @AuthOnly()
  @ApiOperation({ summary: 'Phiếu lương của chính mình' })
  @ApiResponse({ status: 200, description: 'Danh sách phiếu lương của tôi' })
  async findMine(@Query('month') month: string | undefined, @CurrentUser() user: AuthUser) {
    return this.payslipsService.findMine(user.userId, month)
  }

  @Get()
  @Can('payroll.view')
  @ApiOperation({ summary: 'Danh sach phieu luong' })
  @ApiResponse({ status: 200, description: 'Danh sach payslips' })
  async findAll(
    @Query() query: QueryPayslipsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payslipsService.findAll(
      query.month,
      user,
      query.team_id,
      query.status,
    )
  }

  // PHẢI khai báo TRƯỚC @Get(':id') — Express match theo thứ tự, tránh `:id` nuốt `excel-bulk`.
  @Get('excel-bulk')
  @Can('payroll.export')
  @ApiOperation({ summary: 'Xuat Excel hang loat theo ky luong — 1 file, moi NV 1 sheet' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Excel file download' })
  @ApiResponse({ status: 404, description: 'Khong co phieu luong trong ky' })
  async exportBulkExcel(
    @Query() query: BulkExcelPayslipsDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const buffer = await this.payslipsService.generateBulkExcel(query.month, user)

    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="phieu-luong-ky-${query.month}.xlsx"`,
      'Content-Length': buffer.length,
    })

    res.end(buffer)
  }

  // PHẢI khai báo TRƯỚC @Get(':id') — Express match theo thứ tự, tránh `:id` nuốt `excel-list`.
  @Get('excel-list')
  @Can('payroll.export')
  @ApiOperation({
    summary:
      'Xuat Excel danh sach nhan vien theo ky — 1 file, 1 sheet, nhom Phong ban/Team',
  })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Excel file download' })
  @ApiResponse({ status: 404, description: 'Khong co phieu luong trong ky' })
  async exportEmployeeListExcel(
    @Query() query: BulkExcelPayslipsDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const buffer = await this.payslipsService.generateEmployeeListExcel(
      query.month,
      user,
    )

    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="danh-sach-luong-ky-${query.month}.xlsx"`,
      'Content-Length': buffer.length,
    })

    res.end(buffer)
  }

  // Cùng chức năng GET /excel-list nhưng nhận thêm `ordered_ids` (body) = thứ tự nhân viên
  // ĐANG hiển thị trên màn hình (đã lọc/sắp xếp client-side) → file Excel khớp 100% giao diện.
  @Post('excel-list')
  @Can('payroll.export')
  @ApiOperation({
    summary:
      'Xuat Excel danh sach nhan vien theo ky — theo dung thu tu dang hien thi (ordered_ids)',
  })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Excel file download' })
  @ApiResponse({ status: 404, description: 'Khong co phieu luong trong ky' })
  async exportEmployeeListExcelOrdered(
    @Body() body: ListExcelPayslipsDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const buffer = await this.payslipsService.generateEmployeeListExcel(
      body.month,
      user,
      body.ordered_ids,
    )

    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="danh-sach-luong-ky-${body.month}.xlsx"`,
      'Content-Length': buffer.length,
    })

    res.end(buffer)
  }

  // PHẢI khai báo TRƯỚC @Get(':id') — Express match theo thứ tự, tránh `:id` nuốt `addable`.
  @Get('addable')
  @Can('payroll.manage')
  @ApiOperation({
    summary: 'Danh sach nhan vien co the them vao ky luong (active + chua co phieu)',
  })
  @ApiResponse({ status: 200, description: 'Danh sach NV them duoc' })
  async listAddable(
    @Query() query: BulkExcelPayslipsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payslipsService.listAddableEmployees(query.month, user)
  }

  // --- Import Excel --- PHẢI khai báo trước @Get(':id')
  @Get('import-template')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Tải file Excel mẫu nhập phiếu lương' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async downloadImportTemplate(
    @Query() query: BulkExcelPayslipsDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const month = query.month
    const buf = await this.payslipsService.generateImportTemplate(month, user)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="mau-nhap-phieu-luong-${month}.xlsx"`)
    res.send(buf)
  }

  @Post('import/preview')
  @Can('payroll.manage')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Xem trước thay đổi khi import Excel phiếu lương (không ghi DB)' })
  @ApiResponse({ status: 200, description: 'Danh sách hàng với diff trước/sau' })
  async importPreview(
    @UploadedFile() file: UploadedXlsxFile,
    @Query() query: BulkExcelPayslipsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ImportPreviewRow[]> {
    if (!file) throw new BadRequestException('Thiếu file upload')
    return this.payslipsService.previewImport(file.buffer, query.month, user)
  }

  @Post('import/apply')
  @Can('payroll.manage')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Áp dụng import Excel phiếu lương (ghi DB, bỏ qua approved/paid)' })
  @ApiResponse({ status: 201, description: 'Kết quả import với danh sách đã cập nhật' })
  async importApply(
    @UploadedFile() file: UploadedXlsxFile,
    @Query() query: BulkExcelPayslipsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ImportPreviewRow[]> {
    if (!file) throw new BadRequestException('Thiếu file upload')
    return this.payslipsService.applyImport(file.buffer, query.month, user)
  }

  @Get(':id')
  @Can('payroll.view')
  @ApiOperation({ summary: 'Chi tiet phieu luong' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Payslip detail' })
  @ApiResponse({ status: 404, description: 'Khong tim thay' })
  async findById(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payslipsService.findById(id, user)
  }

  @Post('generate')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Tao phieu luong tu KPI + salary rules' })
  @ApiResponse({ status: 201, description: 'Payslips generated' })
  @ApiResponse({ status: 400, description: 'Du lieu khong hop le' })
  async generate(@Body() dto: GeneratePayslipsDto) {
    return this.payslipsService.generate(dto.month, dto.employee_ids)
  }

  @Post('add-to-period')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Them 1 nhan vien vao ky luong (tao moi hoac khoi phuc phieu da loai)' })
  @ApiResponse({ status: 201, description: 'Phieu luong da them' })
  @ApiResponse({ status: 400, description: 'NV khong hop le / da co trong ky' })
  async addToPeriod(
    @Body() dto: AddToPeriodDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payslipsService.addToPeriod(dto.month, dto.employee_id, user)
  }

  // Bước 1 cần `payroll.approve_team` (scope theo nhân viên), bước 2 cần
  // `payroll.approve_final` — service tự dispatch theo trạng thái hiện tại
  // của phiếu ( ghi chú "duyệt 2 bước" là quyền + trạng thái, không
  // phải tầng quyền ẩn).
  @Patch(':id/approve')
  @CanAny('payroll.approve_team', 'payroll.approve_final')
  @ApiOperation({ summary: 'Duyet/tu choi phieu luong (2 buoc)' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Approval updated' })
  @ApiResponse({ status: 403, description: 'Khong co quyen' })
  @ApiResponse({ status: 404, description: 'Khong tim thay / ngoai pham vi' })
  @ApiResponse({ status: 409, description: 'Phieu luong khong o buoc cho duyet' })
  async approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApprovePayslipDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payslipsService.approve(id, dto, user)
  }

  @Patch(':id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Sua phieu luong theo mau ke toan — nhap tay/dien sua' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Payslip updated' })
  @ApiResponse({ status: 400, description: 'Phieu da duyet khong the sua / du lieu khong hop le' })
  @ApiResponse({ status: 404, description: 'Khong tim thay' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePayslipDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payslipsService.update(id, dto, user)
  }

  @Delete(':id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Loai 1 nhan vien khoi ky luong (soft-delete theo thang)' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Da loai khoi ky' })
  @ApiResponse({ status: 403, description: 'Phieu da duyet — chi nguoi co quyen duyet buoc 2' })
  @ApiResponse({ status: 404, description: 'Khong tim thay / da loai' })
  async removeFromPeriod(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payslipsService.removeFromPeriod(id, user)
  }

  @Get(':id/pdf')
  @Can('payroll.export')
  @ApiOperation({ summary: 'Xuat PDF phieu luong' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiProduces('application/pdf')
  @ApiResponse({ status: 200, description: 'PDF file download' })
  @ApiResponse({ status: 404, description: 'Khong tim thay' })
  async exportPdf(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const pdfBuffer = await this.payslipsService.generatePdf(id, user)

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="payslip-${id}.pdf"`,
      'Content-Length': pdfBuffer.length,
    })

    res.end(pdfBuffer)
  }

  @Get(':id/excel')
  @Can('payroll.export')
  @ApiOperation({ summary: 'Xuat Excel phieu luong theo mau ke toan' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'Excel file download' })
  @ApiResponse({ status: 404, description: 'Khong tim thay' })
  async exportExcel(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const buffer = await this.payslipsService.generateExcel(id, user)

    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="phieu-luong-${id}.xlsx"`,
      'Content-Length': buffer.length,
    })

    res.end(buffer)
  }
}
