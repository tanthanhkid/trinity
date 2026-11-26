import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Request } from 'express'
import { Can, CurrentUser, Public, createInvitation, listInvitations, revokeInvitation, type AuthUser } from '@trinity/rbac-nest'
import { PrismaService } from '@trinity/prisma'
import { AuthService } from './auth.service'
import { AcceptInvitationDto, CreateInvitationDto, InvitationTokenDto } from './dto/invitation.dto'
import { extractLoginClientIp } from './login-wifi-check.helper'

/**
 * Lời mời nhân viên bằng link. Đường `/auth/invitations` (không phải `/users/...`) để khỏi đụng `GET /users/:id` và
 * dùng lại prefix `/auth` đã được proxy tới máy chủ.
 */
@ApiTags('Auth')
@Controller('auth/invitations')
export class InvitationsController {
  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Can('users.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Tạo lời mời nhân viên — trả về đường dẫn (path) để chủ công ty copy gửi qua Zalo/Messenger' })
  @ApiBody({ type: CreateInvitationDto })
  @ApiResponse({ status: 201, description: 'Đã tạo lời mời (token chỉ hiện lần này)' })
  @ApiResponse({ status: 409, description: 'Vượt số người của gói, hoặc email đã dùng ở công ty khác / đã có trong công ty' })
  async create(@Body() dto: CreateInvitationDto, @CurrentUser() actor: AuthUser) {
    const inv = await createInvitation(this.prisma, actor, { email: dto.email, roleId: dto.role_id })
    return inv
  }

  @Get()
  @Can('users.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Danh sách lời mời (mặc định chỉ những lời mời còn hiệu lực)' })
  async list(@Query('all') all?: string) {
    return { data: await listInvitations(this.prisma, { pendingOnly: all !== '1' && all !== 'true' }) }
  }

  @Post(':id/revoke')
  @Can('users.manage')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Huỷ lời mời còn hiệu lực — link chết ngay' })
  async revoke(@Param('id', ParseIntPipe) id: number) {
    await revokeInvitation(this.prisma, id)
    return { message: 'Đã huỷ lời mời' }
  }

  @Post('preview')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xem lời mời (công khai): tên công ty, email, vai trò' })
  @ApiBody({ type: InvitationTokenDto })
  @ApiResponse({ status: 410, description: 'Lời mời đã dùng, đã huỷ, hết hạn hoặc không có' })
  async preview(@Body() dto: InvitationTokenDto) {
    return this.authService.previewInvitation(dto.token)
  }

  @Post('accept')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Nhận lời mời (công khai): đặt tên + mật khẩu, tạo tài khoản trong công ty và đăng nhập luôn' })
  @ApiBody({ type: AcceptInvitationDto })
  @ApiResponse({ status: 201, description: 'Đã tạo tài khoản; trả token như đăng nhập' })
  @ApiResponse({ status: 409, description: 'Email đã dùng / hết chỗ theo gói' })
  @ApiResponse({ status: 410, description: 'Lời mời không còn hiệu lực' })
  async accept(@Body() dto: AcceptInvitationDto, @Req() req: Request) {
    return this.authService.acceptInvitation(dto, extractLoginClientIp(req))
  }
}
