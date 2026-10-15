import { Body, Controller, Headers, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '@trinity/rbac-nest';
import { WebhookInboundService } from './webhook-inbound.service';

/**
 * Nhận khách từ nguồn ngoài. `@Public()` chỉ tắt PermissionGuard — xác thực = token trong đường dẫn (+ chữ ký
 * `X-Trinity-Signature` nếu nguồn có signing secret) + rate limit theo nguồn. Cờ tắt / token sai / nguồn tắt ⇒ 404.
 * Body nhận dạng `unknown` có chủ ý: kiểm payload chạy SAU xác thực (người chưa xác thực không thấy thông điệp validate).
 */
@ApiTags('Integrations — Webhook vào')
@Controller('hooks/in')
export class WebhookInboundController {
  constructor(private readonly svc: WebhookInboundService) {}

  @Post(':token')
  @Public()
  @ApiOperation({
    summary: 'Nhận khách hàng từ nguồn ngoài (webhook vào)',
    description: 'Body JSON { name, phone, email?, note?, source?, external_id?, extra? }. Luôn trả 200 { status: "accepted", contact_id: null } — số mới hay số đã có, gửi lại cùng external_id đều giống hệt nhau.',
  })
  @ApiResponse({ status: 200, description: '{ status: "accepted", contact_id: null } — cùng một phản hồi cho mọi trường hợp hợp lệ' })
  @ApiResponse({ status: 400, description: 'Payload sai' })
  @ApiResponse({ status: 401, description: 'Thiếu/sai chữ ký (nguồn có signing secret)' })
  @ApiResponse({ status: 404, description: 'Token sai / nguồn tắt / webhook chưa bật' })
  @ApiResponse({ status: 422, description: 'Người nhận mặc định không còn hoạt động' })
  @ApiResponse({ status: 429, description: 'Quá giới hạn 100 request/phút/nguồn' })
  async receive(
    @Param('token') token: string,
    @Body() body: unknown,
    @Headers('x-trinity-signature') signature: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.svc.receive(token, { rawBody: (req as Request & { rawBody?: Buffer }).rawBody, body, signature });
    res.status(out.httpStatus);
    return out.body;
  }
}
