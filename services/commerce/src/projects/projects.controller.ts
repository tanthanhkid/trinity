import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import { ParseInt4Pipe } from '../common/validation/int4';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthUser, Can, CurrentUser } from '@trinity/rbac-nest';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

/**
 * RBAC quyền + phạm vi: GET đòi `products.view`
 * (mirror ProductsController); tạo/sửa/xoá dự án đòi
 * `products.manage`.
 */
@ApiTags('Projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
  ) {}

  @Get()
  @Can('products.view')
  @ApiOperation({ summary: 'Danh sách dự án' })
  @ApiResponse({ status: 200 })
  findAll(@Query('include_inactive') includeInactive?: string) {
    return this.projectsService.findAll(includeInactive === 'true');
  }

  @Get(':id')
  @Can('products.view')
  @ApiOperation({ summary: 'Chi tiết dự án' })
  @ApiResponse({ status: 200 })
  findOne(@Param('id', ParseInt4Pipe) id: number) {
    return this.projectsService.findOne(id);
  }

  @Post()
  @Can('products.manage')
  @ApiOperation({ summary: 'Tạo dự án mới' })
  @ApiResponse({ status: 201 })
  create(@Body() dto: CreateProjectDto, @CurrentUser() user: AuthUser) {
    return this.projectsService.create(dto, user.userId);
  }

  @Patch(':id')
  @Can('products.manage')
  @ApiOperation({ summary: 'Cập nhật dự án' })
  @ApiResponse({ status: 200 })
  update(@Param('id', ParseInt4Pipe) id: number, @Body() dto: UpdateProjectDto) {
    return this.projectsService.update(id, dto);
  }

  @Delete(':id')
  @Can('products.manage')
  @ApiOperation({ summary: 'Xoá dự án (xoá mềm: set is_active=false)' })
  @ApiResponse({ status: 200, description: 'Xoá thành công, trả về project đã set is_active=false' })
  @ApiResponse({ status: 403, description: 'Không có quyền — cần products.manage' })
  @ApiResponse({ status: 404, description: 'Dự án không tồn tại' })
  remove(@Param('id', ParseInt4Pipe) id: number) {
    return this.projectsService.remove(id);
  }
}
