import { IntegrationOutboxPurgeService } from '../integration-outbox-purge.service';
import { OauthPurgeService } from '../oauth/oauth-purge.service';
import { AiActionExpiryService } from '../mcp/actions/ai-action-expiry.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

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

describe('timer nền của tích hợp (tiến trình máy chủ)', () => {
  let restore: () => void;
  let setIntervalSpy: jest.SpyInstance;
  beforeEach(() => {
    setIntervalSpy = jest.spyOn(global, 'setInterval');
  });
  afterEach(() => {
    restore?.();
    setIntervalSpy.mockRestore();
  });

  const flagsOn = {
    INTEGRATIONS_WEBHOOKS_ENABLED: 'true',
    INTEGRATIONS_MCP_ENABLED: 'true',
    INTEGRATIONS_PUBLIC_BASE_URL: 'https://crm.example.com',
    INTEGRATIONS_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  it('cờ tích hợp bật: cả 4 service tạo timer', () => {
    restore = setEnv(flagsOn);
    const services = [
      new IntegrationOutboxPurgeService({} as never),
      new OauthPurgeService({} as never),
      new AiActionExpiryService({} as never),
      new WebhookDispatcherService({} as never, {} as never, {} as never, {} as never),
    ];
    for (const s of services) s.onModuleInit();
    expect(setIntervalSpy).toHaveBeenCalledTimes(4);
    for (const s of services) s.onModuleDestroy();
  });

  it('cờ tích hợp tắt: không tạo timer nào', () => {
    restore = setEnv({ INTEGRATIONS_WEBHOOKS_ENABLED: undefined, INTEGRATIONS_MCP_ENABLED: undefined });
    for (const s of [
      new IntegrationOutboxPurgeService({} as never),
      new OauthPurgeService({} as never),
      new AiActionExpiryService({} as never),
      new WebhookDispatcherService({} as never, {} as never, {} as never, {} as never),
    ]) s.onModuleInit();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
