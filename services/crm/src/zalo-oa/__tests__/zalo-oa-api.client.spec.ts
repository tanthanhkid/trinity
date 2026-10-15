import { ZaloOaApiClient } from '../zalo-oa-api.client';
import { ZaloApiError } from '../zalo-oa.errors';

const ok = (b: object) => Promise.resolve(new Response(JSON.stringify(b), { status: 200 }));
let fetchMock: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest.spyOn(global, 'fetch');
});
afterEach(() => fetchMock.mockRestore());

describe('ZaloOaApiClient (mock HTTP theo tài liệu Zalo)', () => {
  const api = new ZaloOaApiClient();

  it('đổi code: POST form tới oauth v4, secret_key ở header, có code_verifier', async () => {
    fetchMock.mockReturnValue(ok({ access_token: 'AT', refresh_token: 'RT', expires_in: '90000' }));
    const t = await api.exchangeCode('APP', 'SEC', 'CODE', 'VER');
    expect(t).toEqual({ access_token: 'AT', refresh_token: 'RT', expires_in: 90000 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth.zaloapp.com/v4/oa/access_token');
    expect((init.headers as Record<string, string>).secret_key).toBe('SEC');
    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toEqual({ app_id: 'APP', code: 'CODE', grant_type: 'authorization_code', code_verifier: 'VER' });
  });

  it('làm mới: grant_type=refresh_token', async () => {
    fetchMock.mockReturnValue(ok({ access_token: 'A2', refresh_token: 'R2', expires_in: 90000 }));
    await api.refresh('APP', 'SEC', 'RT');
    expect(new URLSearchParams(fetchMock.mock.calls[0][1].body as string).get('grant_type')).toBe('refresh_token');
  });

  it('gửi tin tư vấn: v3.0/oa/message/cs, header access_token, body recipient/message', async () => {
    fetchMock.mockReturnValue(ok({ error: 0, message: 'Success', data: { message_id: 'm1', user_id: 'u1' } }));
    const r = await api.sendText('AT', 'u1', 'xin chào');
    expect(r.msg_id).toBe('m1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openapi.zalo.me/v3.0/oa/message/cs');
    expect((init.headers as Record<string, string>).access_token).toBe('AT');
    expect(JSON.parse(init.body as string)).toEqual({ recipient: { user_id: 'u1' }, message: { text: 'xin chào' } });
  });

  it('ZNS: business.openapi.zalo.me/message/template, có mode development khi bật', async () => {
    fetchMock.mockReturnValue(ok({ error: 0, data: { msg_id: 'z1', quota: { dailyQuota: '500', remainingQuota: '499' } } }));
    const r = await api.sendZns('AT', { phone: '84912345678', templateId: '123', templateData: { a: 'b' }, trackingId: 't1', mode: 'development' });
    expect(r.msg_id).toBe('z1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://business.openapi.zalo.me/message/template');
    expect(JSON.parse(init.body as string)).toEqual({ phone: '84912345678', template_id: '123', template_data: { a: 'b' }, tracking_id: 't1', mode: 'development' });
  });

  it('hồ sơ người dùng: lấy tên/ảnh/SĐT chia sẻ', async () => {
    fetchMock.mockReturnValue(ok({ error: 0, data: { display_name: 'Lan', avatar: 'http://a', shared_info: { phone: '84912345678' } } }));
    expect(await api.getProfile('AT', 'u1')).toEqual({ display_name: 'Lan', avatar: 'http://a', phone: '84912345678' });
    expect(decodeURIComponent(fetchMock.mock.calls[0][0] as string)).toContain('{"user_id":"u1"}');
  });

  it('error ≠ 0 → ZaloApiError; -216 là lỗi token', async () => {
    fetchMock.mockReturnValue(ok({ error: -216, message: 'Access token is invalid' }));
    const err = await api.sendText('AT', 'u', 't').catch((e) => e);
    expect(err).toBeInstanceOf(ZaloApiError);
    expect(err.isAuthError).toBe(true);
  });

  it('lỗi mạng / không phải JSON → ZaloApiError', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await expect(api.sendText('AT', 'u', 't')).rejects.toBeInstanceOf(ZaloApiError);
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response('<html>', { status: 502 })));
    await expect(api.sendText('AT', 'u', 't')).rejects.toBeInstanceOf(ZaloApiError);
  });
});
