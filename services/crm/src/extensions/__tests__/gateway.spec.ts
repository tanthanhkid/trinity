import { InternalGateway, MAX_ROWS_PER_CALL, MAX_ROWS_PER_GRANT, type DataPort } from '../runner/gateway';

function setup() {
  const port = {
    create: jest.fn(async (_a: unknown, _t: string, rows: unknown[]) => ({ created: rows.length })),
    list: jest.fn(async (_a: unknown, _t: string, _q: unknown) => ({ items: [{ id: 1 }] as unknown[], next_cursor: null as string | null })),
  };
  const gw = new InternalGateway(port as unknown as DataPort);
  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${gw.url}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { gw, port, call };
}

describe('InternalGateway — cổng dữ liệu có phạm vi', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    await s.gw.start();
  });
  afterEach(() => s.gw.stop());

  it('không token / token sai ⇒ 401; đường lạ ⇒ 404', async () => {
    expect((await s.call(null, 'POST', '/records/a', { rows: [] })).status).toBe(401);
    expect((await s.call('sai', 'GET', '/records/a')).status).toBe(401);
    expect((await s.call('sai', 'GET', '/khac')).status).toBe(404);
    expect(s.port.create).not.toHaveBeenCalled();
  });

  it('bảng ngoài phạm vi ⇒ 403 và KHÔNG chạm DataPort; ghi cần quyền write, đọc cần read/write', async () => {
    const t = s.gw.issueToken({ extId: 1, read: ['doc'], write: ['ghi'], dryRun: false });
    expect((await s.call(t, 'POST', '/records/contacts', { rows: [{}] })).status).toBe(403);
    expect((await s.call(t, 'GET', '/records/contacts')).status).toBe(403);
    expect((await s.call(t, 'POST', '/records/doc', { rows: [{ x: 1 }] })).status).toBe(403); // chỉ read ⇒ không ghi được
    expect((await s.call(t, 'GET', '/records/ghi')).status).toBe(200); // write ngầm cho phép đọc lại
    expect((await s.call(t, 'POST', '/records/ghi', { rows: [{ x: 1 }] })).body).toEqual({ created: 1 });
    expect(s.gw.stats(t)).toMatchObject({ denied: 3, written: 1 });
    expect(s.port.create).toHaveBeenCalledTimes(1);
    expect(s.port.create).toHaveBeenCalledWith({ extId: 1, asUserId: undefined }, 'ghi', [{ x: 1 }]);
  });

  it('token đã thu hồi ⇒ 401; token của chương trình con khác không dùng chéo được', async () => {
    const a = s.gw.issueToken({ extId: 1, read: [], write: ['a'], dryRun: false });
    const b = s.gw.issueToken({ extId: 2, read: [], write: ['b'], dryRun: false });
    expect((await s.call(a, 'POST', '/records/b', { rows: [{}] })).status).toBe(403);
    expect((await s.call(b, 'POST', '/records/a', { rows: [{}] })).status).toBe(403);
    s.gw.revoke(a);
    expect((await s.call(a, 'POST', '/records/a', { rows: [{}] })).status).toBe(401);
  });

  it('CHẠY THỬ: ghi chỉ đếm (would_write), DataPort.create không bao giờ được gọi; đọc vẫn qua và mang người thử', async () => {
    const t = s.gw.issueToken({ extId: 1, asUserId: 42, read: ['doc'], write: ['ghi'], dryRun: true });
    expect((await s.call(t, 'POST', '/records/ghi', { rows: [{}, {}, {}] })).body).toEqual({ created: 3, dry_run: true });
    expect((await s.call(t, 'GET', '/records/doc?limit=5')).status).toBe(200);
    expect(s.port.create).not.toHaveBeenCalled();
    expect(s.port.list).toHaveBeenCalledWith({ extId: 1, asUserId: 42 }, 'doc', { limit: 5, cursor: undefined });
    expect(s.gw.revoke(t)).toMatchObject({ wouldWrite: 3, written: 0, calls: 2 });
  });

  it('giới hạn: dòng/lần, dòng/token, thân sai, giới hạn đọc', async () => {
    const t = s.gw.issueToken({ extId: 1, read: ['d'], write: ['ghi'], dryRun: true });
    expect((await s.call(t, 'POST', '/records/ghi', { rows: Array(MAX_ROWS_PER_CALL + 1).fill({}) })).status).toBe(400);
    expect((await s.call(t, 'POST', '/records/ghi', { rows: 'x' })).status).toBe(400);
    expect((await s.call(t, 'POST', '/records/ghi', { rows: [1] })).status).toBe(400);
    for (let i = 0; i < MAX_ROWS_PER_GRANT / MAX_ROWS_PER_CALL; i++) await s.call(t, 'POST', '/records/ghi', { rows: Array(MAX_ROWS_PER_CALL).fill({}) });
    expect((await s.call(t, 'POST', '/records/ghi', { rows: [{}] })).status).toBe(429);
    await s.call(t, 'GET', '/records/d?limit=9999');
    expect(s.port.list).toHaveBeenCalledWith(expect.anything(), 'd', { limit: 50, cursor: undefined });
  });

  it('lỗi từ DataPort ⇒ 502 gọn, không lộ stack', async () => {
    s.port.create.mockRejectedValueOnce(new Error('Trường "ho_ten" bắt buộc'));
    const t = s.gw.issueToken({ extId: 1, read: [], write: ['ghi'], dryRun: false });
    const r = await s.call(t, 'POST', '/records/ghi', { rows: [{}] });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).toContain('ho_ten');
    expect(JSON.stringify(r.body)).not.toContain('at ');
  });
});
