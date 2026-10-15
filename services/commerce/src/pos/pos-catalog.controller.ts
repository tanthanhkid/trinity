import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Can } from '@trinity/rbac-nest';
import { MenuQueryDto, UpdateSettingsDto } from './dto/shift-catalog.dto';
import { PosCatalogService } from './pos-catalog.service';

/**
 * POS — cấu hình quán + menu. RBAC quyền + phạm vi: `PermissionGuard` toàn cục
 * (monolith). `@Can('pos.sell')` cấp class = nhóm bán hàng; route ghi override bằng `@Can('pos.manage')`
 * cấp handler (guard dùng `getAllAndOverride([handler, class])`).
 */
@ApiTags('POS')
@ApiBearerAuth()
@Can('pos.sell')
@Controller('pos')
export class PosCatalogController {
  constructor(private readonly catalog: PosCatalogService) {}

  @Get('settings')
  @ApiOperation({ summary: 'Cấu hình quán (tên, địa chỉ, ngân hàng nhận QR)' })
  settings() {
    return this.catalog.getSettings();
  }

  @Patch('settings')
  @Can('pos.manage')
  @ApiOperation({ summary: 'Sửa cấu hình quán — quản lý' })
  updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.catalog.updateSettings(dto);
  }

  @Get('menu')
  @ApiOperation({ summary: 'Menu bán hàng: danh mục + sản phẩm đang bán có giá' })
  menu(@Query() q: MenuQueryDto) {
    return this.catalog.menu(q);
  }
}
