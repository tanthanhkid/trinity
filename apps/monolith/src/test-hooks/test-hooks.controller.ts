import { BadRequestException, Body, Controller, HttpCode, Param, Post } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { ApiExcludeController } from '@nestjs/swagger'
import { companyRef, isMultiTenant, runWithCompany } from '@trinity/prisma'
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
import { resetOauthLimiters } from '../../../../services/crm/src/integrations/oauth/oauth-rate-limits'
import { IntegrationOutboxPurgeService } from '../../../../services/crm/src/integrations/integration-outbox-purge.service'
import { AiActionExpiryService } from '../../../../services/crm/src/integrations/mcp/actions/ai-action-expiry.service'
import { McpRateLimiter } from '../../../../services/crm/src/integrations/mcp/mcp-rate-limiter'
import { WebhookDispatcherService } from '../../../../services/crm/src/integrations/webhooks/webhook-dispatcher.service'
import { SocialPostsService } from '../../../../services/crm/src/social/social-posts.service'
import { SocialRecurrenceService } from '../../../../services/crm/src/social/social-recurrence.service'
import { FacebookFlowsService } from '../../../../services/crm/src/facebook/facebook-flows.service'
import { FacebookBroadcastsService } from '../../../../services/crm/src/facebook/facebook-broadcasts.service'
import { NotificationsService } from '../../../../services/notification/src/notifications/notifications.service'

interface RunBody {
  /** Công ty chạy job (bắt buộc khi MULTI_TENANT=true). */
  company_id?: number
  /** ISO-8601. CHỈ nhận cho `notification.reap-stuck` và `briefings.collect`; job khác gửi `now` ⇒ 400. */
  now?: string
  /** Tham số của `briefings.collect`: `owner` = 'all' | mảng id người dùng. */
  owner?: 'all' | number[]
  slot?: BriefingSlot
}

type Ctx = { get: <T>(t: Type<T>) => T; body: RunBody; now?: Date }
const JOBS: Record<string, (c: Ctx) => Promise<unknown>> = {
  'stale-work': (c) => c.get(StaleWorkService).runOnce(),
  'lead-scoring': (c) => c.get(LeadScoringService).runOnce(),
  'briefings.run-due': (c) => c.get(BriefingsService).runDue(),
  'briefings.collect': (c) => {
    const { owner, slot } = c.body
    if (!c.now) throw new BadRequestException('briefings.collect cần `now`')
    if (slot !== 'morning' && slot !== 'evening') throw new BadRequestException('slot phải là morning|evening')
    if (owner !== 'all' && !(Array.isArray(owner) && owner.every((n) => Number.isInteger(n)))) {
      throw new BadRequestException("owner phải là 'all' hoặc mảng id")
    }
    return c.get(BriefingAggregatorService).collect(owner, slot, c.now)
  },
  'oauth-purge': (c) => c.get(OauthPurgeService).runOnce(),
  'outbox-purge': (c) => c.get(IntegrationOutboxPurgeService).runOnce(),
  'ai-action-expiry': (c) => c.get(AiActionExpiryService).runOnce(),
  'webhook-dispatch': async (c) => {
    await c.get(WebhookDispatcherService).tick()
    return {}
  },
  'social-publish': async (c) => {
    await c.get(SocialRecurrenceService).materialize()
    return c.get(SocialPostsService).runDue(50_000)
  },
  'social-metrics': (c) => c.get(SocialPostsService).refreshMetricsDue(60_000),
  'facebook-flows': (c) => c.get(FacebookFlowsService).runDue(45_000),
  'facebook-broadcasts': (c) => c.get(FacebookBroadcastsService).runDue(50_000),
  'notification.process-scheduled': async (c) => ({ processed: await c.get(NotificationsService).processScheduled() }),
  'notification.reap-stuck': (c) => c.get(NotificationsService).reapStuckProcessing(c.now),
}
const NOW_JOBS = new Set(['notification.reap-stuck', 'briefings.collect'])

/**
 * API điều khiển test (C18). Chỉ được đăng ký khi `TRINITY_TEST_HOOKS=1` và NODE_ENV khác production (xem `TestHooksModule`);
 * cần `x-service-secret`. Không có giờ giả toàn cục, không có đường đổi cấu hình lúc chạy.
 */
@ApiExcludeController()
@Controller('internal/test')
@Internal()
export class TestHooksController {
  constructor(private readonly moduleRef: ModuleRef) {
    // Chốt chặn thứ hai: dù ai đó nạp nhầm module, production vẫn từ chối khởi động.
    if (!testHooksEnabled()) throw new Error('TestHooksController chỉ chạy khi TRINITY_TEST_HOOKS=1 và NODE_ENV != production')
  }

  @Post('jobs/:name/run')
  @HttpCode(200)
  async run(@Param('name') name: string, @Body() body: RunBody = {}): Promise<{ job: string; result: unknown }> {
    const job = Object.hasOwn(JOBS, name) ? JOBS[name] : undefined
    if (!job) throw new BadRequestException(`Job không tồn tại: ${name}. Có: ${Object.keys(JOBS).join(', ')}`)
    let now: Date | undefined
    if (body.now !== undefined) {
      if (!NOW_JOBS.has(name)) throw new BadRequestException(`\`now\` chỉ nhận cho: ${[...NOW_JOBS].join(', ')}`)
      now = new Date(body.now)
      if (Number.isNaN(now.getTime())) throw new BadRequestException('`now` không phải ISO-8601')
    }
    const ctx: Ctx = { get: (t) => this.moduleRef.get(t, { strict: false }), body, now }
    const exec = (): Promise<unknown> => job(ctx)
    if (!isMultiTenant()) return { job: name, result: (await exec()) ?? null }
    if (!Number.isInteger(body.company_id)) throw new BadRequestException('company_id bắt buộc khi MULTI_TENANT=true')
    return { job: name, result: (await runWithCompany(companyRef(body.company_id as number), exec)) ?? null }
  }

  @Post('cache/flush')
  @HttpCode(200)
  flush(): { flushed: string[] } {
    const get = <T>(t: Type<T>): T => this.moduleRef.get(t, { strict: false })
    get(RbacCache).clear() // quyền
    get(ReadCache).deletePrefix('') // đếm khách + dashboard
    get(TokenBlacklistService).clear() // blacklist
    get(RateLimiterService).clear() // giới hạn tốc độ đăng nhập
    get(McpRateLimiter).reset()
    resetOauthLimiters()
    return { flushed: ['permissions', 'read-cache', 'token-blacklist', 'rate-limits'] }
  }
}
