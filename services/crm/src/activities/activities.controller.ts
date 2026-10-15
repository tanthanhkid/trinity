import {
  Controller,
  Get,
  Param,
  Query,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { PrismaService } from '@trinity/prisma';
import { AuthOnly, CurrentUser, type AuthUser, ScopeService, assertInScope } from '@trinity/rbac-nest';
import { ActivitiesService } from './activities.service';

/**
 * Xác thực KHÔNG phải phân quyền: endpoint chỉ cần đăng nhập mà không scope theo người dùng
 * thì ai cũng đọc được timeline của mọi khách bằng cách đoán id.
 *
 * MỌI endpoint thêm vào controller này PHẢI gọi lại gate `contacts.view` —
 * `activities` là bảng gom dữ liệu của nhiều module (note nội bộ, lịch sử chuyển khách...),
 * không có gate riêng thì rò theo cả bảng.
 *
 * RBAC quyền + phạm vi: gate viết INLINE trong file này. Owner contact =
 * `['assigned_to', 'created_by_id']`, mirror Mẫu B của `ContactsService`.
 * Ngoài phạm vi → 404 (KHÔNG 403 — id đến thẳng từ URL).
 */
@ApiTags('Activities')
@ApiBearerAuth()
@Controller()
export class ActivitiesController {
  constructor(
    private readonly activitiesService: ActivitiesService,
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  private async assertCanAccessContact(contactId: number, user: AuthUser): Promise<void> {
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { assigned_to: true, created_by_id: true },
    });
    if (!contact) throw new NotFoundException(`Không tìm thấy khách hàng ID ${contactId}`);
    await assertInScope(this.scope, user, 'contacts.view', [
      contact.assigned_to,
      contact.created_by_id,
    ]);
  }

  /**
   * Timeline activities cua contact (cursor pagination).
   * 50M rows: always filter by contact_id (indexed).
   */
  @AuthOnly()
  @Get('contacts/:contactId/activities')
  @ApiOperation({
    summary: 'Timeline activities cua contact',
    description:
      'Tra ve activities cursor pagination, newest first. ' +
      '50M rows: luon filter by contact_id (indexed).',
  })
  @ApiResponse({ status: 200, description: 'Tra ve activities' })
  @ApiParam({
    name: 'contactId',
    type: Number,
    description: 'Contact ID',
  })
  @ApiQuery({ name: 'cursor', required: false, type: Number })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'So ban ghi (1-200, mac dinh 20)',
  })
  async findByContact(
    @Param('contactId', ParseIntPipe) contactId: number,
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    await this.assertCanAccessContact(contactId, user);
    return this.activitiesService.findByContact(
      contactId,
      cursor ? Number(cursor) : undefined,
      limit ? Number(limit) : 20,
    );
  }
}
