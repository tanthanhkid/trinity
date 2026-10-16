import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { can } from '@trinity/rbac';
import { AuthOnly, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { PrismaService } from '@trinity/prisma';
import { InteractionsService, type InteractionQuery } from './interactions.service';
import { privateReplied } from '../facebook/facebook-comments.service';

/** Facebook cho nhắn riêng một lần mỗi bình luận, trong 7 ngày. */
const PRIVATE_WINDOW_MS = 7 * 86_400_000;

const date = (v?: string) => {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Ngày không hợp lệ: ${v}`);
  return d;
};

/** Tương tác: dòng thời gian gộp bình luận + tin nhắn các kênh. Quyền lọc trong service (theo kênh). */
@ApiTags('Interactions')
@ApiBearerAuth()
@Controller('interactions')
export class InteractionsController {
  constructor(
    private readonly svc: InteractionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @AuthOnly()
  @ApiOperation({ summary: 'Dòng thời gian gộp: bình luận Fanpage, hội thoại Messenger, Zalo OA; lọc kênh/loại/Page/trạng thái/luật/ngày/tìm' })
  list(
    @CurrentUser() user: AuthUser,
    @Query('channel') channel?: string,
    @Query('type') type?: string,
    @Query('page_id') pageId?: string,
    @Query('status') status?: string,
    @Query('has_rule') hasRule?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const query: InteractionQuery = {
      channel: channel === 'facebook' || channel === 'zalo' ? channel : undefined,
      type: type === 'comment' || type === 'message' ? type : undefined,
      page_id: pageId || undefined,
      status: status === 'unanswered' ? 'unanswered' : undefined,
      has_rule: hasRule === '1' ? true : hasRule === '0' ? false : undefined,
      from: date(from), to: date(to), before: date(before),
      q: q?.slice(0, 100) || undefined,
      limit: limit ? Number(limit) || 50 : 50,
    };
    return this.svc.list(user.grants, query);
  }

  @Get('stats')
  @AuthOnly()
  @ApiOperation({ summary: 'Số hôm nay: tin nhắn, bình luận, luật tự xử lý, chưa trả lời (7 ngày)' })
  stats(@CurrentUser() user: AuthUser) {
    return this.svc.stats(user.grants);
  }

  @Get('comments/:id/thread')
  @AuthOnly()
  @ApiOperation({ summary: 'Chuỗi của một bình luận: các bình luận cùng người trên cùng bài + hội thoại Messenger của khách (nếu có)' })
  async thread(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    if (!can(user.grants, 'integrations.webhooks')) throw new NotFoundException();
    if (!/^\d+$/.test(id)) throw new NotFoundException();
    const c = await this.prisma.facebookComment.findUnique({ where: { id: BigInt(id) } });
    if (!c) throw new NotFoundException();
    const siblings = c.from_id
      ? await this.prisma.facebookComment.findMany({ where: { post_id: c.post_id, from_id: c.from_id }, orderBy: { commented_at: 'asc' }, take: 30 })
      : [c];
    const conv = c.contact_id
      ? await this.prisma.facebookConversation.findFirst({ where: { page_id: c.page_id, contact_id: c.contact_id }, orderBy: { last_message_at: 'desc' } })
      : null;
    const messages = conv
      ? await this.prisma.facebookMessage.findMany({ where: { conversation_id: conv.id }, orderBy: { sent_at: 'desc' }, take: 30 })
      : [];
    return {
      comments: siblings.map((s) => ({ id: s.id.toString(), message: s.message, at: s.commented_at, status: s.status, actions: s.actions, hidden: s.hidden, can_private_reply: !privateReplied(s.actions) && Date.now() - s.commented_at.getTime() <= PRIVATE_WINDOW_MS })),
      conversation: conv ? { id: conv.id, customer_name: conv.customer_name } : null,
      messages: messages.reverse().map((m) => ({ id: m.id.toString(), direction: m.direction, text: m.text, at: m.sent_at })),
    };
  }
}
