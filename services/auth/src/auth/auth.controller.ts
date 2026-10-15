import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Req,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger'
import { Request } from 'express'
import { AuthService } from './auth.service'
import { LoginDto } from './dto/login.dto'
import { RefreshDto } from './dto/refresh.dto'
import { LogoutDto } from './dto/logout.dto'
import { ChangePasswordDto } from './dto/change-password.dto'
import { ResetMyPasswordDto } from './dto/reset-my-password.dto'
import { UpdateProfileDto } from './dto/update-profile.dto'
import { UpdateLoginWifiCheckDto } from './dto/update-login-wifi-check.dto'
import { UpdateSingleSessionDto } from './dto/update-single-session.dto'
import { AuthOnly, Can, Public, CurrentUser, type AuthUser } from '@trinity/rbac-nest'
import { extractLoginClientIp } from './login-wifi-check.helper'

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Đăng nhập bằng email + mật khẩu' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'Đăng nhập thành công, trả về access + refresh token' })
  @ApiResponse({ status: 401, description: 'Email hoặc mật khẩu không đúng' })
  @ApiResponse({ status: 429, description: 'Quá nhiều lần thử sai (10 lần/15 phút theo IP + email)' })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    // dùng extractLoginClientIp (đọc x-real-ip do reverse proxy đặt) thay vì
    // req.ip trần — Auth service KHÔNG set `trust proxy` nên req.ip luôn là IP
    // loopback của proxy, không phải IP thật của client (xem chú thích helper).
    const ip = extractLoginClientIp(req)
    return this.authService.login(dto, ip)
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Làm mới token bằng refresh token' })
  @ApiBody({ type: RefreshDto })
  @ApiResponse({ status: 200, description: 'Token mới (access + refresh)' })
  @ApiResponse({ status: 401, description: 'Refresh token không hợp lệ hoặc hết hạn' })
  async refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refresh_token)
  }

  @Post('logout')
  @AuthOnly()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Đăng xuất — thu hồi refresh token của phiên hiện tại (gửi kèm refresh_token)' })
  @ApiResponse({ status: 200, description: 'Đăng xuất thành công' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  async logout(@CurrentUser() user: AuthUser, @Body() dto?: LogoutDto) {
    return this.authService.logout(user.userId, dto?.refresh_token)
  }

  @Get('settings/login-wifi-check')
  @AuthOnly()
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Lấy cấu hình kiểm tra IP văn phòng khi đăng nhập (mọi người đăng nhập đọc được)',
  })
  @ApiResponse({ status: 200 })
  async getLoginWifiCheckSettings() {
    return this.authService.getLoginWifiCheckConfig()
  }

  @Patch('settings/login-wifi-check')
  @Can('settings.integrations')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Bật/tắt kiểm tra IP văn phòng khi đăng nhập (settings.integrations)',
  })
  @ApiBody({ type: UpdateLoginWifiCheckDto })
  @ApiResponse({ status: 200 })
  async updateLoginWifiCheckSettings(
    @Body() dto: UpdateLoginWifiCheckDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.authService.updateLoginWifiCheckConfig(dto.enabled, user.userId)
  }

  @Get('settings/single-session')
  @AuthOnly()
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Lấy cấu hình "1 tài khoản chỉ 1 phiên đăng nhập" (mọi người đăng nhập đọc được)',
  })
  @ApiResponse({ status: 200 })
  async getSingleSessionSettings() {
    return this.authService.getSingleSessionConfig()
  }

  @Patch('settings/single-session')
  @Can('settings.integrations')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Bật/tắt giới hạn 1 phiên đăng nhập/tài khoản (settings.integrations)',
  })
  @ApiBody({ type: UpdateSingleSessionDto })
  @ApiResponse({ status: 200 })
  async updateSingleSessionSettings(
    @Body() dto: UpdateSingleSessionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.authService.updateSingleSessionConfig(dto.enabled, user.userId)
  }

  @Get('me')
  @AuthOnly()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lấy thông tin người dùng hiện tại (quyền + phạm vi)' })
  @ApiResponse({ status: 200, description: 'user + roles[] + permissions (Grants) + isAdmin' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập hoặc token hết hạn' })
  async getMe(@CurrentUser() user: AuthUser) {
    return this.authService.getMe(user.userId)
  }

  @Patch('password')
  @AuthOnly()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Đổi mật khẩu (yêu cầu mật khẩu hiện tại)' })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({ status: 200, description: 'Đổi mật khẩu thành công, token cũ bị vô hiệu' })
  @ApiResponse({ status: 401, description: 'Mật khẩu hiện tại không đúng' })
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    const ip = extractLoginClientIp(req)
    return this.authService.changePassword(
      user.userId,
      dto.currentPassword,
      dto.newPassword,
      ip,
    )
  }

  @Post('reset-password')
  @AuthOnly()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset mật khẩu - tự động tạo mật khẩu mới (cần mật khẩu hiện tại)' })
  @ApiBody({ type: ResetMyPasswordDto })
  @ApiResponse({ status: 200, description: 'Mật khẩu mới được tạo, token cũ bị vô hiệu' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập hoặc mật khẩu hiện tại không đúng' })
  async resetMyPassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ResetMyPasswordDto,
    @Req() req: Request,
  ) {
    const ip = extractLoginClientIp(req)
    return this.authService.resetMyPassword(user.userId, dto.currentPassword, ip)
  }

  @Patch('profile')
  @AuthOnly()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cập nhật hồ sơ cá nhân (tên, SĐT)' })
  @ApiBody({ type: UpdateProfileDto })
  @ApiResponse({ status: 200, description: 'Cập nhật hồ sơ thành công' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  async updateProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(user.userId, dto)
  }

  @Post('profile/avatar')
  @AuthOnly()
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload ảnh đại diện' })
  @ApiResponse({ status: 201, description: 'Upload ảnh đại diện thành công' })
  @ApiResponse({ status: 400, description: 'Ảnh không hợp lệ (sai định dạng hoặc quá lớn)' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async uploadAvatar(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.authService.uploadAvatar(user.userId, file)
  }
}
