import { BadRequestException, Body, Controller, HttpCode, Logger, Param, Post } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { ApiExcludeController } from '@nestjs/swagger'
import { activeCompanyRef, isMultiTenant, runWithCompany } from '@trinity/prisma'
import { Internal, RbacCache, TokenBlacklistService, testHooksEnabled } from '@trinity/rbac-nest'
import type { Type } from '@nestjs/common'

import { RateLimiterService } from '../../../../services/auth/src/auth/services/rate-limiter.service'
import { ReadCache } from '../../../../services/crm/src/common/read-cache'
import { StaleWorkService } from '../../../../services/crm/src/stale-work/stale-work.service'
import { LeadScoringService } from '../../../../services/crm/src/lead-scoring/lead-scoring.service'
import { BriefingsService } from '../../../../services/crm/src/briefings/briefings.service'
import { BriefingAggregatorService } from '../../../../services/crm/src/briefings/briefing-aggregator.service'
import type { BriefingSlot } from '../../../../services/crm/src/briefings/briefing.types'
import { OauthPurgeService } from '../../../../services/crm/src/integrations/oauth/oauth-purge.service'
import { IntegrationOutboxPurgeService } from '../../../../services/crm/src/integrations/integration-outbox-purge.service'
import { AiActionExpiryService } from '../../../../services/crm/src/integrations/mcp/actions/ai-action-expiry.service'
import { FixedWindowLimiter } from '../../../../services/crm/src/common/helpers/fixed-window-limiter'
import { isSecretKeyConfigured } from '../../../../services/crm/src/integrations/webhooks/secret-crypto'
import { integrationFlags } from '@trinity/prisma'
import { WebhookDispatcherService } from '../../../../services/crm/src/integrations/webhooks/webhook-dispatcher.service'
import { SocialPostsService } from '../../../../services/crm/src/social/social-posts.service'
import { SocialRecurrenceService } from '../../../../services/crm/src/social/social-recurrence.service'
import { FacebookFlowsService } from '../../../../services/crm/src/facebook/facebook-flows.service'
import { FacebookBroadcastsService } from '../../../../services/crm/src/facebook/facebook-broadcasts.service'
import { NotificationsService } from '../../../../services/notification/src/notifications/notifications.service'

interface RunBody {
  /** Công ty chạy job (bắt buộc khi MULTI_TENANT=true). */
  company_id?: number
  /** ISO-8601 CÓ múi giờ (Z hoặc ±hh:mm). Chỉ nhận cho job mà mã đã nhận giờ làm đối số (xem NOW_JOBS); job khác ⇒ 400. */
  now?: string
  /** Tham số của `briefings.collect`: `owner` = 'all' | mảng id người dùng. */
  owner?: 'all' | number[]
  slot?: BriefingSlot
  /** Chỉ `stale-work`: bỏ qua giờ gửi và dấu "đã gửi hôm nay". */
  force?: boolean
}

type Ctx = { get: <T>(t: Type<T>) => T; body: RunBody; now?: Date }
const JOBS: Record<string, (c: Ctx) => Promise<unknown>> = {
  'stale-work': (c) => c.get(StaleWorkService).runOnce(c.now, c.body.force === true),
  'lead-scoring': (c) => c.get(LeadScoringService).runOnce(),
  'briefings.run-due': (c) => c.get(BriefingsService).runDue(c.now),
  'briefings.collect': (c) => {
    const { owner, slot } = c.body
    if (!c.now) throw new BadRequestException('briefings.collect cần `now`')
    if (slot !== 'morning' && slot !== 'evening') throw new BadRequestException('slot phải là morning|evening')
    if (owner !== 'all' && !(Array.isArray(owner) && owner.every((n) => Number.isInteger(n)))) {
      throw new BadRequestException("owner phải là 'all' hoặc mảng id")
    }
    return c.get(BriefingAggregatorService).collect(owner, slot, c.now)
  },
  'oauth-purge': (c) => c.get(OauthPurgeService).runOnce(c.now?.getTime()),
  'outbox-purge': (c) => c.get(IntegrationOutboxPurgeService).runOnce(),
  'ai-action-expiry': (c) => c.get(AiActionExpiryService).runOnce(c.now?.getTime()),
  'webhook-dispatch': async (c) => {
    // Như job thật: cờ tắt hoặc thiếu khoá bí mật thì không chạy — nói rõ lý do thay vì trả {} khó hiểu.
    if (!integrationFlags.webhooksEnabled()) return { skipped: 'INTEGRATIONS_WEBHOOKS_ENABLED tắt' }
    if (!isSecretKeyConfigured()) return { skipped: 'INTEGRATIONS_SECRET_KEY thiếu/sai' }
    await c.get(WebhookDispatcherService).tick()
    return { skipped: null }
  },
  // Hai job đăng bài giữ guard khoá bí mật như job thật (SocialPublishJob.tick/metrics).
  'social-publish': async (c) => {
    if (!isSecretKeyConfigured()) return { skipped: 'INTEGRATIONS_SECRET_KEY thiếu/sai' }
    await c.get(SocialRecurrenceService).materialize()
    return c.get(SocialPostsService).runDue(50_000)
  },
  'social-metrics': async (c) => {
    if (!isSecretKeyConfigured()) return { skipped: 'INTEGRATIONS_SECRET_KEY thiếu/sai' }
    return c.get(SocialPostsService).refreshMetricsDue(60_000)
  },
  'facebook-flows': (c) => c.get(FacebookFlowsService).runDue(45_000),
  'facebook-broadcasts': (c) => c.get(FacebookBroadcastsService).runDue(50_000, c.now?.getTime()),
  'notification.process-scheduled': async (c) => ({ processed: await c.get(NotificationsService).processScheduled() }),
  'notification.reap-stuck': (c) => c.get(NotificationsService).reapStuckProcessing(c.now),
}
const NOW_JOBS = new Set([
  'notification.reap-stuck', 'briefings.collect', 'briefings.run-due', 'stale-work', 'oauth-purge', 'ai-action-expiry', 'facebook-broadcasts',
])
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * API điều khiển test (C18). Chỉ được đăng ký khi `TRINITY_TEST_HOOKS=1` và NODE_ENV khác production (xem `TestHooksModule`);
 * cần `x-service-secret`. Không có giờ giả toàn cục, không có đường đổi cấu hình lúc chạy.
 */
@ApiExcludeController()
@Controller('internal/test')
@Internal()
export class TestHooksController {
  private readonly logger = new Logger(TestHooksController.name)

  constructor(private readonly moduleRef: ModuleRef) {
    // Chốt chặn thứ hai: dù ai đó nạp nhầm module, production vẫn từ chối khởi động.
    if (!testHooksEnabled()) throw new Error('TestHooksController chỉ chạy khi TRINITY_TEST_HOOKS=1 và NODE_ENV là test/development')
    this.logger.warn('API ĐIỀU KHIỂN TEST ĐANG BẬT (TRINITY_TEST_HOOKS=1): mọi lịch tự động đã tắt; KHÔNG dùng ở môi trường thật')
  }

  @Post('jobs/:name/run')
  @HttpCode(200)
  async run(@Param('name') name: string, @Body() body: RunBody = {}): Promise<{ job: string; result: unknown }> {
    const job = Object.hasOwn(JOBS, name) ? JOBS[name] : undefined
    if (!job) throw new BadRequestException(`Job không tồn tại: ${name}. Có: ${Object.keys(JOBS).join(', ')}`)
    let now: Date | undefined
    if (body.now !== undefined) {
      if (!NOW_JOBS.has(name)) throw new BadRequestException(`\`now\` chỉ nhận cho: ${[...NOW_JOBS].join(', ')}`)
      if (typeof body.now !== 'string' || !ISO_WITH_TZ.test(body.now)) {
        throw new BadRequestException('`now` phải là chuỗi ISO-8601 có múi giờ (vd 2026-01-01T00:00:00Z)')
      }
      now = new Date(body.now)
      if (Number.isNaN(now.getTime())) throw new BadRequestException('`now` không phải ngày hợp lệ')
    }
    const ctx: Ctx = { get: (t) => this.moduleRef.get(t, { strict: false }), body, now }
    const exec = (): Promise<unknown> => job(ctx)
    if (!isMultiTenant()) return { job: name, result: (await exec()) ?? null }
    const id = body.company_id
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
      throw new BadRequestException('company_id (số nguyên ≥ 1) bắt buộc khi MULTI_TENANT=true')
    }
    const company = await activeCompanyRef(id)
    if (!company) throw new BadRequestException(`company_id ${id} không tồn tại hoặc không hoạt động`)
    return { job: name, result: (await runWithCompany(company, exec)) ?? null }
  }

  @Post('cache/flush')
  @HttpCode(200)
  flush(): { flushed: string[] } {
    const get = <T>(t: Type<T>): T => this.moduleRef.get(t, { strict: false })
    get(RbacCache).clear() // quyền
    get(ReadCache).deletePrefix('') // đếm khách + dashboard
    get(TokenBlacklistService).clear() // blacklist
    get(RateLimiterService).clear() // giới hạn tốc độ đăng nhập
    FixedWindowLimiter.resetAll() // MỌI limiter trong RAM: public API, MCP, OAuth, webhook vào, cửa hàng
    return { flushed: ['permissions', 'read-cache', 'token-blacklist', 'rate-limits'] }
  }
}
