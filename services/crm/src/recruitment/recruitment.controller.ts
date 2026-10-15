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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { RecruitmentService } from './recruitment.service';
import { CreateCandidateDto } from './dto/create-candidate.dto';
import { UpdateCandidateDto } from './dto/update-candidate.dto';
import {
  QueryCandidatesDto,
  QueryRecruitmentStatsDto,
} from './dto/query-candidates.dto';
import { CreatePositionDto } from './dto/create-position.dto';
import { UpdatePositionDto } from './dto/update-position.dto';
import { QueryPositionsDto } from './dto/query-positions.dto';

// Tuyển dụng: xem = quyền `recruitment.view`; sửa = quyền `recruitment.manage`.
@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('management/recruitment')
export class RecruitmentController {
  constructor(private readonly service: RecruitmentService) {}

  @Get('stats')
  @Can('recruitment.view')
  @ApiOperation({ summary: 'Thống kê tuyển dụng (nguồn / giai đoạn / quyết định / theo tháng)' })
  stats(@Query() dto: QueryRecruitmentStatsDto) {
    return this.service.stats(dto);
  }

  @Get('candidates')
  @Can('recruitment.view')
  @ApiOperation({ summary: 'Danh sách ứng viên (phân trang + lọc + tìm)' })
  list(@Query() dto: QueryCandidatesDto) {
    return this.service.list(dto);
  }

  @Post('candidates')
  @Can('recruitment.manage')
  @ApiOperation({ summary: 'Thêm ứng viên (quyền recruitment.manage)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCandidateDto) {
    return this.service.create(dto, user.userId);
  }

  @Patch('candidates/:id')
  @Can('recruitment.manage')
  @ApiOperation({ summary: 'Cập nhật ứng viên (quyền recruitment.manage)' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCandidateDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete('candidates/:id')
  @Can('recruitment.manage')
  @ApiOperation({ summary: 'Xoá ứng viên (quyền recruitment.manage)' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  // ── Người tuyển dụng phụ trách ─────────────────────────────────────────────

  @Get('recruiters')
  @Can('recruitment.view')
  @ApiOperation({ summary: 'Danh sách người tuyển dụng phụ trách' })
  recruiters() {
    return this.service.listRecruiters();
  }

  // ── Vị trí tuyển dụng ─────────────────────────────────────────────────────

  @Get('positions')
  @Can('recruitment.view')
  @ApiOperation({ summary: 'Danh sách vị trí tuyển dụng (phân trang + lọc + tìm)' })
  listPositions(@Query() dto: QueryPositionsDto) {
    return this.service.listPositions(dto);
  }

  @Post('positions')
  @Can('recruitment.manage')
  @ApiOperation({ summary: 'Thêm vị trí tuyển dụng (quyền recruitment.manage)' })
  createPosition(@CurrentUser() user: AuthUser, @Body() dto: CreatePositionDto) {
    return this.service.createPosition(dto, user.userId);
  }

  @Patch('positions/:id')
  @Can('recruitment.manage')
  @ApiOperation({ summary: 'Cập nhật vị trí tuyển dụng (quyền recruitment.manage)' })
  updatePosition(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePositionDto,
  ) {
    return this.service.updatePosition(id, dto);
  }

  @Delete('positions/:id')
  @Can('recruitment.manage')
  @ApiOperation({ summary: 'Xoá vị trí tuyển dụng (quyền recruitment.manage)' })
  removePosition(@Param('id', ParseIntPipe) id: number) {
    return this.service.removePosition(id);
  }
}
