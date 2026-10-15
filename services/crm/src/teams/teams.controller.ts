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
import { AuthOnly, Can } from '@trinity/rbac-nest';
import { TeamsService } from './teams.service';
import { CreateTeamDto, UpdateTeamDto, TeamMembersDto } from './dto/team.dto';

// Cấu hình Team (1 phòng ban → nhiều team) — quyền `org.manage` (sơ đồ tổ chức,
// phòng ban, team, chức danh). 2 dropdown dưới đây đọc mở cho mọi
// người đã đăng nhập (`for-filter`/`lead-filter` = mọi vai trò).
@ApiTags('Teams')
@ApiBearerAuth()
@Controller('management/teams')
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  /**
   * Dropdown bộ lọc Team — chỉ trả {id, name, team_lead_id}, mặc định chỉ team Active
   * (có trưởng nhóm). Mọi người đã đăng nhập dùng được (nguồn chung cho filter ở
   * Lương/Nhân viên/HĐ). PHẢI đặt TRƯỚC @Get(':id') để không bị route shadow.
   *
   * `?include_unled=true` — mở rộng thêm team KHÔNG có trưởng nhóm nhưng có
   * nhân viên gán trực tiếp (vd "Team Gamma"). CHỈ dùng ở 2 màn Quản lý nhân
   * viên/hợp đồng — mặc định (KHÔNG truyền) giữ NGUYÊN hành vi cũ cho các dropdown
   * khác (payroll/contract-stats-dialog) đang lọc theo `team_lead_id`.
   */
  @Get('for-filter')
  @AuthOnly()
  @ApiOperation({ summary: 'Danh sách team Active cho dropdown bộ lọc (mọi người đã đăng nhập)' })
  listForFilter(@Query('include_unled') includeUnled?: string) {
    return this.teamsService.listForFilter(includeUnled === 'true');
  }

  /**
   * Dropdown "Team" cho bộ lọc theo cây quản lý.
   * Trả HỢP của (teams có trưởng nhóm) ∪ (user quản lý ≥1 người qua manager_id
   * chưa xoá), khoá theo `team_lead_id`. Xem JSDoc `TeamsService.listTeamLeadFilter` để biết vì sao
   * KHÔNG dùng chung `for-filter` (2 nguồn sự thật khác nhau). Đặt TRƯỚC mọi
   * route có tham số động để không bị shadow (controller này hiện chưa có
   * `@Get(':id')`, nhưng thêm vào sau này là hỏng ngay nếu `lead-filter` nằm dưới).
   * RBAC: y hệt `for-filter` — mọi người đã đăng nhập; lý do KHÔNG scope theo
   * caller ghi ở JSDoc service.
   */
  @Get('lead-filter')
  @AuthOnly()
  @ApiOperation({
    summary: 'Danh sách trưởng nhóm cho dropdown Team (mọi người đã đăng nhập)',
  })
  listTeamLeadFilter() {
    return this.teamsService.listTeamLeadFilter();
  }

  @Get()
  @Can('org.manage')
  @ApiOperation({ summary: 'Danh sách team (kèm phòng ban + trưởng nhóm)' })
  findAll() {
    return this.teamsService.findAll();
  }

  @Post()
  @Can('org.manage')
  @ApiOperation({ summary: 'Tạo team' })
  create(@Body() dto: CreateTeamDto) {
    return this.teamsService.create(dto);
  }

  @Patch(':id')
  @Can('org.manage')
  @ApiOperation({ summary: 'Sửa team' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTeamDto) {
    return this.teamsService.update(id, dto);
  }

  @Delete(':id')
  @Can('org.manage')
  @ApiOperation({ summary: 'Xoá team (gỡ team_id khỏi nhân viên, giữ hierarchy)' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.teamsService.remove(id);
  }

  @Get(':id/members')
  @Can('org.manage')
  @ApiOperation({ summary: 'Danh sách nhân viên đã gán vào team' })
  listMembers(@Param('id', ParseIntPipe) id: number) {
    return this.teamsService.listMembers(id);
  }

  @Post(':id/members')
  @Can('org.manage')
  @ApiOperation({ summary: 'Gán nhân viên vào team' })
  addMembers(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TeamMembersDto,
  ) {
    return this.teamsService.addMembers(id, dto.user_ids);
  }

  @Delete(':id/members/:userId')
  @Can('org.manage')
  @ApiOperation({ summary: 'Gỡ 1 nhân viên khỏi team' })
  removeMember(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.teamsService.removeMember(id, userId);
  }
}
