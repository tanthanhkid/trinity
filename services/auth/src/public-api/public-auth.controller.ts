import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { LoginDto } from '../auth/dto/login.dto'
import { extractLoginClientIp } from '../auth/login-wifi-check.helper'
import {
  ApiKeyGuard,
  ApiKeyScopeRequired,
} from '../api-keys/guards/api-key.guard'
import type { ValidatedApiKey } from '../api-keys/api-keys.service'
import { Public } from '@trinity/rbac-nest'

type PublicAuthRequest = Request & { apiKey?: ValidatedApiKey }

/**
 * Endpoint cho bên thứ 3 — đăng nhập user bằng email+password, xác thực
 * thêm bằng X-API-Key. Chỉ cho phép đăng nhập dưới user owner của API key
 * (tránh 1 key login được dưới user khác). Trả JWT access TTL 15m — KHÔNG
 * trả refresh_token: bên thứ 3 phải call lại /public/auth/login khi hết hạn.
 *
 * RBAC: `@Public()` ở tầng PermissionGuard toàn cục — xác thực THẬT là
 * `ApiKeyGuard` (method-level, vẫn chạy nguyên vẹn) yêu cầu X-API-Key có
 * scope `auth:login`, KHÔNG phải JWT người dùng. Mẫu "public-api giữ guard
 * riêng + đánh @Public()" — spec.
 */
@ApiTags('Public API')
@Controller('public/auth')
export class PublicAuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Public()
  @UseGuards(ApiKeyGuard)
  @ApiKeyScopeRequired('auth:login')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: 'X-API-Key',
    required: true,
    description: 'Khoá API (scope auth:login)',
  })
  @ApiOperation({
    summary: 'Đăng nhập user qua X-API-Key (third-party)',
    description:
      'Authentication hai lớp: X-API-Key (scope auth:login) + email+password. ' +
      'Email phải khớp owner của API key, user phải có quyền contacts.create. ' +
      'Trả access_token (15m). KHÔNG có refresh_token — hết 15m phải đăng nhập lại.',
  })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'Đăng nhập thành công' })
  @ApiResponse({
    status: 401,
    description:
      'X-API-Key không hợp lệ, email/mật khẩu sai, hoặc email không khớp owner',
  })
  @ApiResponse({ status: 429, description: 'Quá nhiều lần thử' })
  async login(@Body() dto: LoginDto, @Req() req: PublicAuthRequest) {
    const apiKey = req.apiKey
    if (!apiKey) {
      // Guard phải attach apiKey — nếu thiếu là config bug, không leak stack.
      throw new InternalServerErrorException('Cấu hình public auth lỗi')
    }
    // Cùng cách lấy IP với /auth/login: sau reverse proxy `req.ip` là IP proxy ⇒ mọi client chung một khoá rate-limit.
    const ip = extractLoginClientIp(req)
    return this.authService.loginForThirdParty(dto, ip, apiKey.owner_user_id)
  }
}
