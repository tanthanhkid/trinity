import { Controller, Get, Post, Patch, Delete, Param, Body, ParseIntPipe } from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { Can, CurrentUser, AuthUser } from '@trinity/rbac-nest'
import { TaxConfigService } from './tax-config.service'
import {
  CreateTaxBracketDto, UpdateTaxBracketDto,
  CreateTaxSettingDto, UpdateTaxSettingDto,
} from './dto/tax-config.dto'

@ApiTags('tax-config')
@ApiBearerAuth()
@Controller('tax-config')
export class TaxConfigController {
  constructor(private readonly service: TaxConfigService) {}

  @Get()
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Biểu thuế TNCN + giảm trừ gia cảnh' })
  getConfig() {
    return this.service.getConfig()
  }

  @Post('brackets')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Tạo bậc thuế' })
  createBracket(@Body() dto: CreateTaxBracketDto, @CurrentUser() user: AuthUser) {
    return this.service.createBracket(dto, user?.userId)
  }

  @Patch('brackets/:id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Cập nhật bậc thuế' })
  updateBracket(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTaxBracketDto) {
    return this.service.updateBracket(id, dto)
  }

  @Delete('brackets/:id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Xoá bậc thuế' })
  removeBracket(@Param('id', ParseIntPipe) id: number) {
    return this.service.removeBracket(id)
  }

  @Post('settings')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Tạo cấu hình giảm trừ gia cảnh' })
  createSetting(@Body() dto: CreateTaxSettingDto, @CurrentUser() user: AuthUser) {
    return this.service.createSetting(dto, user?.userId)
  }

  @Patch('settings/:id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Cập nhật giảm trừ gia cảnh' })
  updateSetting(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTaxSettingDto) {
    return this.service.updateSetting(id, dto)
  }
}
