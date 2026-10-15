import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { DealsService } from './deals.service';
import { CreateDealDto } from './dto/create-deal.dto';
import { UpdateDealDto } from './dto/update-deal.dto';
import { QueryDealDto } from './dto/query-deal.dto';

/**
 * RBAC quyền + phạm vi: mask SĐT làm PER-DÒNG trong `DealsService` (Mẫu C, `maskDealPhone`),
 * áp cho MỌI người xem bất kể `contacts.phone_full` có phủ owner của deal hay không.
 */
@ApiTags('Deals')
@ApiBearerAuth()
@Controller('deals')
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

  @Post()
  @Can('deals.manage')
  @ApiOperation({ summary: 'Tạo thương vụ mới' })
  @ApiResponse({ status: 201, description: 'Thương vụ được tạo thành công' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ hoặc sale không tồn tại' })
  @ApiResponse({ status: 403, description: 'Không có quyền tạo thương vụ' })
  create(@Body() dto: CreateDealDto, @CurrentUser() user: AuthUser) {
    return this.dealsService.create(dto, user);
  }

  @Get()
  @Can('deals.view')
  @ApiOperation({ summary: 'Danh sách thương vụ (theo phạm vi deals.view)' })
  @ApiResponse({ status: 200, description: 'Danh sách thương vụ có phân trang cursor' })
  findAll(@Query() query: QueryDealDto, @CurrentUser() user: AuthUser) {
    return this.dealsService.findAll(query, user);
  }

  @Get('search-sales')
  @Can('deals.manage')
  @ApiOperation({ summary: 'Tìm kiếm người trong phạm vi deals.manage để gán thương vụ' })
  @ApiResponse({ status: 200, description: 'Danh sách nhân sự khớp từ khoá' })
  searchSales(@Query('q') q: string, @CurrentUser() user: AuthUser) {
    return this.dealsService.searchSales(q, user);
  }

  @Get(':id')
  @Can('deals.view')
  @ApiOperation({ summary: 'Chi tiết thương vụ' })
  @ApiResponse({ status: 200, description: 'Chi tiết thương vụ' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy thương vụ' })
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.dealsService.findOne(id, user);
  }

  @Patch(':id')
  @Can('deals.manage')
  @ApiOperation({ summary: 'Cập nhật thương vụ' })
  @ApiResponse({ status: 200, description: 'Cập nhật thành công' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDealDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.dealsService.update(id, dto, user);
  }

  @Delete(':id')
  @Can('deals.delete')
  @ApiOperation({ summary: 'Xóa thương vụ' })
  @ApiResponse({ status: 200, description: 'Xóa thành công' })
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.dealsService.remove(id, user);
  }
}
