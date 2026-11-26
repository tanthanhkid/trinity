import { BriefingsScheduler } from '../briefings.scheduler';

const ENV = ['BRIEFING_CRON_ENABLED'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
afterEach(() => { ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))); jest.restoreAllMocks(); });

describe('BriefingsScheduler', () => {
  it('không bật env thì KHÔNG có timer', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const s = new BriefingsScheduler({ runDue: jest.fn() } as never);
    s.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    s.onModuleDestroy();
  });

  it('bật BRIEFING_CRON_ENABLED=true → có timer', () => {
    const spy = jest.spyOn(global, 'setInterval');
    process.env.BRIEFING_CRON_ENABLED = 'true';
    const a = new BriefingsScheduler({ runDue: jest.fn() } as never);
    a.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
    a.onModuleDestroy();
  });
});
