import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, Can, CurrentUser } from '@trinity/rbac-nest';
import { can } from '@trinity/rbac';
import { ParseInt4Pipe } from '../common/validation/int4';
import {
  CreateAreaDto, CreateModifierDto, CreateTableDto, ListModifiersQueryDto, UpdateAreaDto, UpdateModifierDto, UpdateTableDto,
} from './dto/shift-catalog.dto';
import { PosLayoutService } from './pos-layout.service';

/** POS — khu vực, bàn, tuỳ chọn món. Đọc: nhóm bán hàng. Ghi: quản lý. */
@ApiTags('POS')
@ApiBearerAuth()
@Can('pos.sell')
@Controller('pos')
export class PosLayoutController {
  constructor(private readonly layout: PosLayoutService) {}

  @Get('areas') areas() { return this.layout.listAreas(); }
  @Post('areas') @Can('pos.manage') createArea(@Body() dto: CreateAreaDto) { return this.layout.createArea(dto); }
  @Patch('areas/:id') @Can('pos.manage')
  updateArea(@Param('id', ParseInt4Pipe) id: number, @Body() dto: UpdateAreaDto) { return this.layout.updateArea(id, dto); }

  @Get('tables') tables() { return this.layout.listTables(); }
  @Post('tables') @Can('pos.manage') createTable(@Body() dto: CreateTableDto) { return this.layout.createTable(dto); }
  @Patch('tables/:id') @Can('pos.manage')
  updateTable(@Param('id', ParseInt4Pipe) id: number, @Body() dto: UpdateTableDto) { return this.layout.updateTable(id, dto); }

  @Get('modifiers')
  modifiers(@Query() q: ListModifiersQueryDto, @CurrentUser() user: AuthUser) {
    return this.layout.listModifiers(q, can(user.grants, 'pos.manage'));
  }
  @Post('modifiers') @Can('pos.manage')
  createModifier(@Body() dto: CreateModifierDto) { return this.layout.createModifier(dto); }
  @Patch('modifiers/:id') @Can('pos.manage')
  updateModifier(@Param('id', ParseInt4Pipe) id: number, @Body() dto: UpdateModifierDto) { return this.layout.updateModifier(id, dto); }
}
