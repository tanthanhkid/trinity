import { cronRegistry, runCronTick } from '@trinity/rbac-nest';
import { IntegrationOutboxPurgeService } from '../integration-outbox-purge.service';
import { OauthPurgeService } from '../oauth/oauth-purge.service';
import { AiActionExpiryService } from '../mcp/actions/ai-action-expiry.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { WebhookKickInterceptor } from '../webhooks/webhook-kick.interceptor';
import { CronTickController, isValidCronAuth } from '../cron-tick.controller';
import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

const KEY = Symbol.for('@vercel/request-context');
const g = globalThis as Record<symbol, unknown>;

function setEnv(env: Record<string, string | undefined>): () => void {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe('timer nền: serverless KHÔNG khởi động timer, vẫn đăng ký cron job', () => {
  let restore: () => void;
  let setIntervalSpy: jest.SpyInstance;
  let setTimeoutSpy: jest.SpyInstance;
  beforeEach(() => {
    cronRegistry.clear();
    setIntervalSpy = jest.spyOn(global, 'setInterval');
    setTimeoutSpy = jest.spyOn(global, 'setTimeout');
  });
  afterEach(() => {
    restore?.();
    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  const flagsOn = { INTEGRATIONS_WEBHOOKS_ENABLED: 'true', INTEGRATIONS_MCP_ENABLED: 'true', INTEGRATIONS_SECRET_KEY: Buffer.alloc(32, 1).toString('base64') };

  it('serverless + cờ bật: 4 service không tạo timer, 4 job được đăng ký', () => {
    restore = setEnv({ TRINITY_RUNTIME: 'serverless', ...flagsOn });
    const purge = new IntegrationOutboxPurgeService({} as never);
    const oauth = new OauthPurgeService({} as never);
    const ai = new AiActionExpiryService({} as never);
    const disp = new WebhookDispatcherService({} as never, {} as never, {} as never, {} as never);
    for (const s of [purge, oauth, ai, disp]) s.onModuleInit();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(cronRegistry.list().map((j) => j.name).sort()).toEqual([
      'integrations.ai-action-expiry',
      'integrations.oauth-purge',
      'integrations.outbox-purge',
      'integrations.webhook-dispatch',
    ]);
  });

  it('không đặt cờ + cờ tích hợp bật: timer chạy như cũ (setInterval được gọi)', () => {
    restore = setEnv({ TRINITY_RUNTIME: undefined, ...flagsOn });
    const purge = new IntegrationOutboxPurgeService({} as never);
    purge.onModuleInit();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    purge.onModuleDestroy();
  });

  it('job cron của outbox: cờ tích hợp tắt → bỏ qua (không hoạt động), bật → gọi purge', async () => {
    restore = setEnv({ TRINITY_RUNTIME: 'serverless', INTEGRATIONS_WEBHOOKS_ENABLED: undefined, INTEGRATIONS_MCP_ENABLED: undefined });
    const events = { purge: jest.fn().mockResolvedValue({ dispatched: 3, stale: 0 }) };
    new IntegrationOutboxPurgeService(events as never).onModuleInit();
    let s = await runCronTick();
    expect(s.jobs[0].result).toEqual({ skipped: 'flag-off' });
    expect(events.purge).not.toHaveBeenCalled();
    process.env.INTEGRATIONS_WEBHOOKS_ENABLED = 'true';
    s = await runCronTick();
    expect(events.purge).toHaveBeenCalledTimes(1);
    expect(s.jobs[0].status).toBe('ok');
  });
});

describe('WebhookDispatcherService.kick (gửi ngay sau commit)', () => {
  let restore: () => void;
  const mk = () => {
    const d = new WebhookDispatcherService({} as never, {} as never, {} as never, {} as never);
    const tick = jest.spyOn(d, 'tick').mockResolvedValue();
    return { d, tick };
  };
  const on = { TRINITY_RUNTIME: 'serverless', INTEGRATIONS_WEBHOOKS_ENABLED: 'true', INTEGRATIONS_SECRET_KEY: Buffer.alloc(32, 1).toString('base64') };
  afterEach(() => {
    restore?.();
    delete g[KEY];
  });

  it('serverless + cờ bật → gọi waitUntil và tick không housekeeping', async () => {
    restore = setEnv(on);
    const waitUntil = jest.fn();
    g[KEY] = { get: () => ({ waitUntil }) };
    const { d, tick } = mk();
    d.kick();
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(tick).toHaveBeenCalledWith({ housekeeping: false });
  });

  it('không có context Vercel → vẫn chạy (fire-and-forget), không ném', async () => {
    restore = setEnv(on);
    const { d, tick } = mk();
    d.kick();
    await new Promise((r) => setImmediate(r));
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('kích trong lúc đang gửi → chạy thêm 1 vòng (không bỏ sót commit mới, không chạy chồng)', async () => {
    restore = setEnv(on);
    const { d, tick } = mk();
    let release: () => void = () => undefined;
    tick.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    d.kick();
    await new Promise((r) => setImmediate(r));
    d.kick();
    d.kick();
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('không serverless → no-op', async () => {
    restore = setEnv({ ...on, TRINITY_RUNTIME: undefined });
    const { d, tick } = mk();
    d.kick();
    await new Promise((r) => setImmediate(r));
    expect(tick).not.toHaveBeenCalled();
  });

  it('serverless nhưng cờ webhook tắt → no-op', async () => {
    restore = setEnv({ ...on, INTEGRATIONS_WEBHOOKS_ENABLED: undefined });
    const { d, tick } = mk();
    d.kick();
    await new Promise((r) => setImmediate(r));
    expect(tick).not.toHaveBeenCalled();
  });

  it('interceptor: chỉ kích sau request GHI hoàn tất', (done) => {
    const kick = jest.fn();
    const ic = new WebhookKickInterceptor({ kick } as never);
    const ctx = (method: string) =>
      ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ method }) }) }) as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of('ok') };
    (ic.intercept(ctx('GET'), next) as ReturnType<CallHandler['handle']>).subscribe();
    expect(kick).not.toHaveBeenCalled();
    (ic.intercept(ctx('POST'), next) as ReturnType<CallHandler['handle']>).subscribe({
      complete: () => {
        expect(kick).toHaveBeenCalledTimes(1);
        done();
      },
    });
  });
});

describe('GET /internal/cron/tick', () => {
  let restore: () => void;
  afterEach(() => {
    restore?.();
    cronRegistry.clear();
  });

  it('isValidCronAuth: đúng/sai/thiếu/không phải Bearer', () => {
    expect(isValidCronAuth('Bearer s3cret', 's3cret')).toBe(true);
    expect(isValidCronAuth('Bearer s3cret!', 's3cret')).toBe(false);
    expect(isValidCronAuth('s3cret', 's3cret')).toBe(false);
    expect(isValidCronAuth(undefined, 's3cret')).toBe(false);
    expect(isValidCronAuth('Bearer x', '')).toBe(false);
  });

  it('chưa có CRON_SECRET → 503; sai secret → 401', async () => {
    restore = setEnv({ CRON_SECRET: undefined });
    const c = new CronTickController();
    await expect(c.tick('Bearer a')).rejects.toMatchObject({ status: 503 });
    process.env.CRON_SECRET = 'right';
    await expect(c.tick('Bearer wrong')).rejects.toMatchObject({ status: 401 });
    await expect(c.tick(undefined)).rejects.toMatchObject({ status: 401 });
  });

  it('đúng secret → chạy mọi job, lỗi một job không chặn job khác', async () => {
    restore = setEnv({ CRON_SECRET: 'right' });
    cronRegistry.register({ name: 'ok', budgetMs: 500, run: async () => ({ n: 1 }) });
    cronRegistry.register({ name: 'bad', budgetMs: 500, run: async () => { throw new Error('x'); } });
    const out = await new CronTickController().tick('Bearer right');
    expect(out.jobs.map((j) => [j.name, j.status])).toEqual([['ok', 'ok'], ['bad', 'error']]);
  });
});
