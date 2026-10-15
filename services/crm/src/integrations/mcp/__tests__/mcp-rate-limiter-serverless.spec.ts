import { McpRateLimiter } from '../mcp-rate-limiter';

describe('McpRateLimiter — serverless không Redis', () => {
  const old = { r: process.env.TRINITY_RUNTIME, u: process.env.REDIS_URL };
  afterEach(() => {
    for (const [k, v] of [['TRINITY_RUNTIME', old.r], ['REDIS_URL', old.u]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('serverless + không REDIS_URL → đếm RAM, không gọi Redis, vẫn giới hạn đúng', async () => {
    process.env.TRINITY_RUNTIME = 'serverless';
    delete process.env.REDIS_URL;
    const redis = { incr: jest.fn(), expire: jest.fn() };
    const l = new McpRateLimiter(redis as never);
    expect((await l.hit('u', 1, 2)).allowed).toBe(true);
    expect((await l.hit('u', 1, 2)).allowed).toBe(true);
    expect((await l.hit('u', 1, 2)).allowed).toBe(false);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('không cờ → vẫn dùng Redis như cũ', async () => {
    delete process.env.TRINITY_RUNTIME;
    const redis = { incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) };
    await new McpRateLimiter(redis as never).hit('u', 1, 2);
    expect(redis.incr).toHaveBeenCalled();
  });
});
