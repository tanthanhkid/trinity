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
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { ContractsService } from './contracts.service';
import { QueryContractsDto } from './dto/query-contracts.dto';
import { QueryContractStatsDto } from './dto/query-contract-stats.dto';
import { CreateContractDto } from './dto/create-contract.dto';
import { UpdateContractDto } from './dto/update-contract.dto';

// RBAC: xem = quyền `contracts.view`; thêm/sửa/xoá/tệp = quyền `contracts.manage`
// (danh mục quyền không tách delete-only — quản lý giao đủ contracts.manage cho ai
// được phép ghi hợp đồng).

// File hợp đồng: PDF + ảnh, tối đa 20MB. fileFilter dùng cb(BadRequestException) để báo lỗi rõ.
const CONTRACT_FILE_MAX_BYTES = 20 * 1024 * 1024;
const CONTRACT_FILE_ALLOWED_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
];
const contractFileInterceptor = FileInterceptor('file', {
  limits: { fileSize: CONTRACT_FILE_MAX_BYTES },
  fileFilter: (
    _req: unknown,
    file: Express.Multer.File,
    cb: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (CONTRACT_FILE_ALLOWED_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new BadRequestException('Chỉ chấp nhận file PDF, JPG, PNG hoặc WEBP.'),
        false,
      );
    }
  },
});

// Hồ sơ mẫu hợp đồng: PDF + Word + Excel, tối đa 20MB.
const CONTRACT_TEMPLATE_MAX_BYTES = 20 * 1024 * 1024;
const CONTRACT_TEMPLATE_ALLOWED_MIME = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
const contractTemplateInterceptor = FileInterceptor('file', {
  limits: { fileSize: CONTRACT_TEMPLATE_MAX_BYTES },
  fileFilter: (
    _req: unknown,
    file: Express.Multer.File,
    cb: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (CONTRACT_TEMPLATE_ALLOWED_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new BadRequestException(
          'Chỉ chấp nhận file PDF, Word (.doc/.docx) hoặc Excel (.xls/.xlsx).',
        ),
        false,
      );
    }
  },
});

@ApiTags('Employee Contracts')
@ApiBearerAuth()
@Controller('management/contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  @Get()
  @Can('contracts.view')
  @ApiOperation({ summary: 'Danh sách hợp đồng (phân trang, tìm kiếm, lọc)' })
  @ApiResponse({ status: 200, description: 'Danh sách hợp đồng' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  findAll(@CurrentUser() user: AuthUser, @Query() dto: QueryContractsDto) {
    return this.contractsService.findAll(dto, user);
  }

  // KHAI BÁO TRƯỚC route ':id' để 'stats' không bị :id bắt.
  @Get('stats')
  @Can('contracts.view')
  @ApiOperation({ summary: 'Thống kê hợp đồng toàn công ty (hỗ trợ bộ lọc)' })
  @ApiResponse({ status: 200, description: 'Số liệu thống kê hợp đồng' })
  getStats(@CurrentUser() user: AuthUser, @Query() dto: QueryContractStatsDto) {
    return this.contractsService.getStats(user, dto);
  }

  // ===== Hồ sơ mẫu hợp đồng — KHAI BÁO TRƯỚC route ':id' để 'templates' không bị :id bắt =====

  @Get('templates')
  @Can('contracts.view')
  @ApiOperation({ summary: 'Danh sách hồ sơ mẫu hợp đồng' })
  @ApiResponse({ status: 200, description: 'Danh sách hồ sơ mẫu' })
  listTemplates() {
    return this.contractsService.listTemplates();
  }

  @Post('templates')
  @Can('contracts.manage')
  @UseInterceptors(contractTemplateInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Tải lên hồ sơ mẫu hợp đồng (contracts.manage)' })
  @ApiResponse({ status: 201, description: 'Đã tải lên hồ sơ mẫu' })
  @ApiResponse({ status: 400, description: 'File không hợp lệ' })
  uploadTemplate(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
    @Body('name') name?: string,
  ) {
    if (!file) {
      throw new BadRequestException('Vui lòng chọn file để tải lên');
    }
    return this.contractsService.uploadTemplate(file, user.userId, name);
  }

  @Get('templates/:tid/file')
  @Can('contracts.view')
  @ApiOperation({ summary: 'Tải/xem hồ sơ mẫu hợp đồng (stream qua backend)' })
  @ApiResponse({ status: 200, description: 'Nội dung file mẫu' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy hồ sơ mẫu' })
  async getTemplateFile(
    @Param('tid', ParseIntPipe) tid: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { body, contentType, contentLength, fileName } =
      await this.contractsService.streamTemplate(tid);
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      ...(contentLength != null ? { 'Content-Length': String(contentLength) } : {}),
    });
    return new StreamableFile(body);
  }

  @Delete('templates/:tid')
  @Can('contracts.manage')
  @ApiOperation({ summary: 'Xoá hồ sơ mẫu hợp đồng (contracts.manage)' })
  @ApiResponse({ status: 200, description: 'Đã xoá hồ sơ mẫu' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy hồ sơ mẫu' })
  deleteTemplate(@Param('tid', ParseIntPipe) tid: number) {
    return this.contractsService.deleteTemplate(tid);
  }

  @Get(':id')
  @Can('contracts.view')
  @ApiOperation({ summary: 'Chi tiết hợp đồng' })
  @ApiResponse({ status: 200, description: 'Thông tin chi tiết hợp đồng' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy hợp đồng' })
  findById(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.contractsService.findById(id, user);
  }

  @Post()
  @Can('contracts.manage')
  @ApiOperation({ summary: 'Thêm hợp đồng mới' })
  @ApiResponse({ status: 201, description: 'Hợp đồng đã được tạo' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy nhân viên' })
  create(@Body() dto: CreateContractDto) {
    return this.contractsService.create(dto);
  }

  @Patch(':id')
  @Can('contracts.manage')
  @ApiOperation({ summary: 'Cập nhật hợp đồng (gia hạn, đổi ngày, chấm dứt...)' })
  @ApiResponse({ status: 200, description: 'Cập nhật thành công' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy hợp đồng' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateContractDto) {
    return this.contractsService.update(id, dto);
  }

  @Delete(':id')
  @Can('contracts.manage')
  @ApiOperation({ summary: 'Xoá hợp đồng' })
  @ApiResponse({ status: 200, description: 'Đã xoá hợp đồng' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy hợp đồng' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.contractsService.remove(id);
  }

  @Post(':id/file')
  @Can('contracts.manage')
  @UseInterceptors(contractFileInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Tải lên file hợp đồng (PDF/ảnh, tối đa 20MB)' })
  @ApiResponse({ status: 200, description: 'Đã tải lên file hợp đồng' })
  @ApiResponse({ status: 400, description: 'File không hợp lệ' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy hợp đồng' })
  uploadFile(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Vui lòng chọn file để tải lên');
    }
    return this.contractsService.uploadFile(id, file);
  }

  @Get(':id/file')
  @Can('contracts.view')
  @ApiOperation({ summary: 'Xem/tải file hợp đồng (stream qua backend)' })
  @ApiResponse({ status: 200, description: 'Nội dung file' })
  @ApiResponse({ status: 404, description: 'Hợp đồng chưa có file' })
  async getFile(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { body, contentType, contentLength, fileName } =
      await this.contractsService.streamFile(id, user);
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      ...(contentLength != null ? { 'Content-Length': String(contentLength) } : {}),
    });
    return new StreamableFile(body);
  }

  @Delete(':id/file')
  @Can('contracts.manage')
  @ApiOperation({ summary: 'Xoá file hợp đồng' })
  @ApiResponse({ status: 200, description: 'Đã xoá file hợp đồng' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy hợp đồng' })
  removeFile(@Param('id', ParseIntPipe) id: number) {
    return this.contractsService.removeFile(id);
  }
}
