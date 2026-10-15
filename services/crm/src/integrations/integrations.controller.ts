import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CanAny } from '@trinity/rbac-nest';
import { IntegrationAuditService, integrationFlags } from '@trinity/prisma';
import { isSecretKeyConfigured } from './webhooks/secret-crypto';
import { mcpResourceUrl, oauthEnabled, publicBaseUrl } from './oauth/oauth-config';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';

/**
 * Kết nối & AI. Bước này chỉ có: trạng thái cờ + nhật ký tích hợp. Webhook,
 * OAuth/MCP thêm controller riêng ở các bước sau, cùng dùng cờ + quyền khai ở đây.
 */
@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly audit: IntegrationAuditService) {}

  @Get('status')
  @CanAny('integrations.webhooks', 'integrations.ai_connect', 'integrations.ai_admin')
  @ApiOperation({
    summary: 'Cờ máy chủ của các kênh tích hợp (FE dùng để biết hiện nội dung hay thông báo "chưa bật")',
    description: 'Luôn trả 200 (không 404) để giao diện phân biệt "kênh tắt" với "không có quyền".',
  })
  @ApiResponse({ status: 200, description: '{ webhooks_enabled, mcp_enabled, secret_key_configured, mcp_base_url_configured, mcp_url }' })
  @ApiResponse({ status: 403, description: 'Không có quyền nhóm Kết nối & AI' })
  status() {
    return {
      webhooks_enabled: integrationFlags.webhooksEnabled(),
      mcp_enabled: integrationFlags.mcpEnabled(),
      // Thiếu/sai INTEGRATIONS_SECRET_KEY ⇒ webhook bật cờ vẫn KHÔNG gửi được — UI cần báo rõ.
      secret_key_configured: isSecretKeyConfigured(),
      // cờ MCP bật nhưng thiếu INTEGRATIONS_PUBLIC_BASE_URL ⇒ OAuth/MCP vẫn 404 — UI cần báo đúng nguyên nhân.
      mcp_base_url_configured: publicBaseUrl() !== null,
      // URL dán vào ChatGPT/Claude (chỉ có khi MCP chạy được).
      mcp_url: oauthEnabled() ? mcpResourceUrl(publicBaseUrl() as string) : null,
    };
  }

  @Get('audit-logs')
  @Can('integrations.ai_admin')
  @ApiOperation({
    summary: 'Nhật ký tích hợp toàn công ty (MCP, webhook ra/vào) — mới → cũ, phân trang cursor',
    description: 'Dữ liệu đã lọc khi ghi: KHÔNG có SĐT đầy đủ/secret. Cả 2 cờ INTEGRATIONS_* đều tắt → 404.',
  })
  @ApiResponse({ status: 200, description: '{ data, meta: { next_cursor } }' })
  @ApiResponse({ status: 403, description: 'Thiếu quyền integrations.ai_admin' })
  @ApiResponse({ status: 404, description: 'Tích hợp chưa được bật trên máy chủ' })
  async auditLogs(@Query() q: QueryAuditLogsDto) {
    if (!integrationFlags.anyEnabled()) throw new NotFoundException();
    const { data, next_cursor } = await this.audit.list({
      channel: q.channel,
      status: q.status,
      userId: q.user_id,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      cursor: q.cursor,
      limit: q.limit,
    });
    return { data, meta: { next_cursor } };
  }
}
