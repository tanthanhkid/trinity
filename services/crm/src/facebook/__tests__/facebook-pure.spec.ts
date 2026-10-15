import { signMetaBody, verifyMetaSignature } from '../facebook-signature';
import { signFacebookState, verifyFacebookState } from '../facebook-oauth-state';
import { parseLeadFields } from '../facebook-lead-fields';
import { isWithinMessagingWindow, MESSAGING_WINDOW_MS } from '../channel';
import { tokenStateFromDebug } from '../facebook-pages.service';
import { DEFAULT_GRAPH_VERSION, isFacebookConfigured, loadFacebookConfig } from '../facebook.config';

describe('verifyMetaSignature (X-Hub-Signature-256)', () => {
  const body = Buffer.from('{"object":"page","entry":[]}');
  const good = signMetaBody(body, 'appsecret');
  it('chữ ký đúng', () => expect(verifyMetaSignature(body, good, 'appsecret')).toBe(true));
  it('sai secret / body bị sửa', () => {
    expect(verifyMetaSignature(body, good, 'other')).toBe(false);
    expect(verifyMetaSignature(Buffer.from('{"object":"page","entry":[1]}'), good, 'appsecret')).toBe(false);
  });
  it.each([undefined, '', 'sha256=zz', 'sha1=' + 'a'.repeat(40), good.replace('sha256=', '')])('từ chối header %j', (h) => {
    expect(verifyMetaSignature(body, h, 'appsecret')).toBe(false);
  });
  it('thiếu rawBody hoặc secret ⇒ false (không bỏ qua kiểm)', () => {
    expect(verifyMetaSignature(undefined, good, 'appsecret')).toBe(false);
    expect(verifyMetaSignature(body, good, '')).toBe(false);
  });
});

describe('state OAuth', () => {
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });
  it('ký rồi kiểm ra đúng user', () => expect(verifyFacebookState(signFacebookState(7))).toEqual({ userId: 7 }));
  it('hết hạn ⇒ null', () => expect(verifyFacebookState(signFacebookState(7, Date.now() - 11 * 60_000))).toBeNull());
  it('bị sửa / rác ⇒ null', () => {
    const [b, m] = signFacebookState(7).split('.');
    const forged = Buffer.from(JSON.stringify({ u: 1, e: 9999999999 })).toString('base64url');
    expect(verifyFacebookState(`${forged}.${m}`)).toBeNull();
    expect(verifyFacebookState(`${b}.x`)).toBeNull();
    expect(verifyFacebookState('abc')).toBeNull();
  });
});

describe('parseLeadFields', () => {
  it('trường chuẩn của Meta', () => {
    const r = parseLeadFields([
      { name: 'full_name', values: ['Nguyễn Văn A'] },
      { name: 'phone_number', values: ['+84912345678'] },
      { name: 'email', values: ['a@x.vn'] },
      { name: 'ban_can_gi', values: ['Tư vấn gói A'] },
    ]);
    expect(r).toEqual({ full_name: 'Nguyễn Văn A', phone: '0912345678', email: 'a@x.vn', others: [{ name: 'ban_can_gi', value: 'Tư vấn gói A' }] });
  });
  it('ghép first_name + last_name kiểu Việt (họ trước)', () => {
    expect(parseLeadFields([{ name: 'first_name', values: ['An'] }, { name: 'last_name', values: ['Nguyễn'] }]).full_name).toBe('Nguyễn An');
  });
  it('SĐT/email rác ⇒ null; đầu vào rác không ném', () => {
    expect(parseLeadFields([{ name: 'phone_number', values: ['12345'] }, { name: 'email', values: ['khong-phai-mail'] }])).toMatchObject({ phone: null, email: null });
    expect(parseLeadFields(null).phone).toBeNull();
    expect(parseLeadFields([null, { name: 1 }] as unknown as never[]).others).toEqual([]);
  });
});

describe('cửa sổ 24h', () => {
  const now = Date.now();
  it('trong cửa sổ', () => expect(isWithinMessagingWindow(new Date(now - MESSAGING_WINDOW_MS + 60_000), now)).toBe(true));
  it('đúng 24h hoặc quá ⇒ đóng', () => {
    expect(isWithinMessagingWindow(new Date(now - MESSAGING_WINDOW_MS), now)).toBe(false);
    expect(isWithinMessagingWindow(new Date(now - 30 * 3600_000), now)).toBe(false);
  });
  it('chưa có tin khách ⇒ đóng', () => expect(isWithinMessagingWindow(null, now)).toBe(false));
});

describe('tokenStateFromDebug', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  it('page token dài hạn (expires_at=0) còn hiệu lực', () => expect(tokenStateFromDebug({ is_valid: true, expires_at: 0 }, now).status).toBe('active'));
  it('is_valid=false ⇒ invalid', () => expect(tokenStateFromDebug({ is_valid: false }, now).status).toBe('invalid'));
  it('quá hạn hoặc hết hạn truy cập dữ liệu ⇒ expired', () => {
    expect(tokenStateFromDebug({ is_valid: true, expires_at: now / 1000 - 10 }, now).status).toBe('expired');
    expect(tokenStateFromDebug({ is_valid: true, data_access_expires_at: now / 1000 - 10 }, now).status).toBe('expired');
  });
});

describe('cấu hình', () => {
  it('mặc định Graph v25.0 và chưa đủ thì configured=false', () => {
    const c = loadFacebookConfig({});
    expect(c.graphVersion).toBe(DEFAULT_GRAPH_VERSION);
    expect(isFacebookConfigured(c)).toBe(false);
  });
  it('đủ app id/secret + base url', () => {
    const c = loadFacebookConfig({ FACEBOOK_APP_ID: '1', FACEBOOK_APP_SECRET: 's', INTEGRATIONS_PUBLIC_BASE_URL: 'https://crm.example.vn', FACEBOOK_GRAPH_VERSION: 'v26.0' } as NodeJS.ProcessEnv);
    expect(isFacebookConfigured(c)).toBe(true);
    expect(c.graphVersion).toBe('v26.0');
  });
});

describe('GraphClient.ensureGetStarted', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

  it('chưa có nút ⇒ đặt payload GET_STARTED; đã có ⇒ không đè', async () => {
    const { GraphClient } = await import('../graph-client');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return init?.method === 'POST' ? reply({ result: 'success' }) : reply({ data: [] });
    }) as never;
    expect(await new GraphClient().ensureGetStarted('T')).toBe(true);
    expect(calls[1].url).toContain('me/messenger_profile');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ get_started: { payload: 'GET_STARTED' } });

    global.fetch = jest.fn(async () => reply({ data: [{ get_started: { payload: 'X' } }] })) as never;
    expect(await new GraphClient().ensureGetStarted('T')).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
