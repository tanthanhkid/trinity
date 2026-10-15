import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { cronRegistry, isServerless } from '@trinity/rbac-nest';
import { oauthEnabled } from './oauth-config';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 7 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Dọn bảng OAuth (mã hết hạn >1 ngày, token hết hạn refresh >7 ngày / thu hồi >30 ngày, client DCR chưa từng dùng >7 ngày,
 * client CIMD không dùng >60 ngày). MẶC ĐỊNH TẮT — chỉ chạy khi cờ MCP + base URL bật; tắt = không timer nào.
 */
@Injectable()
export class OauthPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OauthPurgeService.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    cronRegistry.register({
      name: 'integrations.oauth-purge',
      budgetMs: 20_000,
      run: async () => (oauthEnabled() ? this.runOnce() : { skipped: 'flag-off' }),
    });
    if (isServerless()) return;
    if (!oauthEnabled()) return;
    this.first = setTimeout(() => void this.runOnce(), FIRST_RUN_DELAY_MS);
    this.interval = setInterval(() => void this.runOnce(), SIX_HOURS_MS);
    this.first.unref();
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.interval) clearInterval(this.interval);
    this.first = null;
    this.interval = null;
  }

  async runOnce(now = Date.now()): Promise<{ codes: number; tokens: number; clients: number }> {
    try {
      const ago = (ms: number): Date => new Date(now - ms);
      const codes = await this.prisma.oauthAuthorizationCode.deleteMany({ where: { expires_at: { lt: ago(DAY_MS) } } });
      const tokens = await this.prisma.oauthToken.deleteMany({
        where: { OR: [{ refresh_expires_at: { lt: ago(7 * DAY_MS) } }, { revoked_at: { lt: ago(30 * DAY_MS) } }] },
      });
      const clients = await this.prisma.oauthClient.deleteMany({
        where: { OR: [{ kind: 'dcr', last_used_at: null, created_at: { lt: ago(7 * DAY_MS) } }, { kind: 'cimd', OR: [{ last_used_at: { lt: ago(60 * DAY_MS) } }, { last_used_at: null, created_at: { lt: ago(60 * DAY_MS) } }] }] },
      });
      const out = { codes: codes.count, tokens: tokens.count, clients: clients.count };
      if (out.codes + out.tokens + out.clients > 0) this.logger.log(`OAuth purge: ${out.codes} mã, ${out.tokens} token, ${out.clients} client`);
      return out;
    } catch (err) {
      this.logger.error(`OAuth purge failed: ${(err as Error)?.message}`);
      return { codes: 0, tokens: 0, clients: 0 };
    }
  }
}
