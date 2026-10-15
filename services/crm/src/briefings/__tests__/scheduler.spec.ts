import { cronRegistry } from '@trinity/rbac-nest';
import { BriefingsScheduler } from '../briefings.scheduler';

const ENV = ['TRINITY_RUNTIME', 'BRIEFING_CRON_ENABLED'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
afterEach(() => { ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))); jest.restoreAllMocks(); });

describe('BriefingsScheduler', () => {
  it('luôn đăng ký job vào cronRegistry; tiến trình dài không bật env thì KHÔNG có timer', () => {
    cronRegistry.clear();
    const spy = jest.spyOn(global, 'setInterval');
    const s = new BriefingsScheduler({ runDue: jest.fn() } as never);
    s.onModuleInit();
    expect(cronRegistry.list().map((j) => j.name)).toContain('briefings.run-due');
    expect(spy).not.toHaveBeenCalled();
    s.onModuleDestroy();
  });

  it('tiến trình dài bật BRIEFING_CRON_ENABLED=true → có timer; serverless thì không', () => {
    const spy = jest.spyOn(global, 'setInterval');
    process.env.BRIEFING_CRON_ENABLED = 'true';
    const a = new BriefingsScheduler({ runDue: jest.fn() } as never);
    a.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
    a.onModuleDestroy();
    process.env.TRINITY_RUNTIME = 'serverless';
    const b = new BriefingsScheduler({ runDue: jest.fn() } as never);
    b.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
