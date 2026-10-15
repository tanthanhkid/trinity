import { Controller, Get } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger'
import { AuthOnly } from '@trinity/rbac-nest'
import { PERMISSIONS, PERMISSION_GROUPS, type Scope } from '@trinity/rbac'

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'own', label: 'Của mình' },
  { value: 'team', label: 'Cấp dưới trực tiếp' },
  { value: 'subtree', label: 'Toàn bộ cấp dưới' },
  { value: 'all', label: 'Toàn công ty' },
]

/**
 * Danh mục quyền cho màn Cài đặt > Vai trò — mọi user đăng nhập đọc
 * được (chỉ liệt kê khoá + nhãn, không phải dữ liệu nhạy cảm).
 */
@ApiTags('RBAC')
@Controller('rbac')
export class RbacCatalogController {
  @Get('catalog')
  @AuthOnly()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Danh mục quyền (nhóm, nhãn, scoped, sensitive) + 4 mức phạm vi',
  })
  getCatalog() {
    return {
      groups: PERMISSION_GROUPS,
      permissions: Object.entries(PERMISSIONS).map(([key, def]) => ({ key, ...def })),
      scopes: SCOPES,
    }
  }
}
