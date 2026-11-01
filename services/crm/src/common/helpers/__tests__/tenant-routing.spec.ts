import { ConflictException } from '@nestjs/common';

/**
 * Multi-tenant routing of public channel traffic: Facebook/Zalo webhooks run as the company owning the Page/OA,
 * connect flows remember their OAuth `state`, and public links carry `?cid=`.
 * `@trinity/prisma` keeps its real tenant context; only the platform-table lookups are faked.
 */
const routes = new Map<string, number>();
const remembered: string[] = [];
jest.mock('@trinity/prisma', () => {
  const actual = jest.requireActual('@trinity/prisma');
  return {
    ...actual,
    companyIdForRoute: jest.fn(async (kind: string, id: string) => routes.get(`${kind}:${id}`) ?? null),
    activeCompanyRef: jest.fn(async (id: number) => (id === 99 ? null : actual.companyRef(id))),
    rememberOauthState: jest.fn(async (s: string) => {
      remembered.push(s);
    }),
    assertRouteAvailableForCurrentCompany: jest.fn(async (kind: string, id: string) => {
      const owner = routes.get(`${kind}:${id}`);
      if (owner !== undefined && owner !== actual.currentCompanyId()) throw new ConflictException('taken');
    }),
  };
});
jest.mock('../../../zalo-oa/zalo-oa-signature', () => ({ verifyZaloSignature: () => true }));

import { currentCompanyId, runWithCompany, companyRef } from '@trinity/prisma';
import { signMetaBody } from '../../../facebook/facebook-signature';
import { FacebookWebhookService } from '../../../facebook/facebook-webhook.service';
import { FacebookPagesService } from '../../../facebook/facebook-pages.service';
import { signFacebookState, verifyFacebookState } from '../../../facebook/facebook-oauth-state';
import { ZaloOaWebhookService } from '../../../zalo-oa/zalo-oa-webhook.service';
import { isRouteTakenError, rethrowRouteTaken } from '../route-taken';
import { stateCompanyMatches, withCompanyHint } from '../tenant-hint';

const KEY = Buffer.alloc(32, 7).toString('base64');

beforeAll(() => {
  process.env.MULTI_TENANT = 'true';
  process.env.INTEGRATIONS_SECRET_KEY = KEY;
  process.env.JWT_SECRET = 'jwt';
  process.env.FACEBOOK_APP_ID = 'app';
  process.env.FACEBOOK_APP_SECRET = 'appsecret';
  process.env.INTEGRATIONS_PUBLIC_BASE_URL = 'https://crm.example.vn';
});
afterAll(() => {
  delete process.env.MULTI_TENANT;
});
beforeEach(() => {
  routes.clear();
  remembered.length = 0;
});

describe('Webhook Facebook — nhiều Page, nhiều công ty trong một POST', () => {
  const seen: Array<{ page: string; company: number | null }> = [];
  const messenger = {
    ingest: jest.fn(async (page: string) => {
      seen.push({ page, company: currentCompanyId() });
      return true;
    }),
    ingestReferral: jest.fn().mockResolvedValue(false),
  };
  const featureCompanies: Array<number | null> = [];
  const features = {
    isEnabled: jest.fn(async () => {
      featureCompanies.push(currentCompanyId());
      return true;
    }),
  };
  const prisma = { facebookPage: { findMany: jest.fn() } };
  const svc = new FacebookWebhookService(
    messenger as never,
    { handle: jest.fn() } as never,
    { ingest: jest.fn() } as never,
    { handleEvent: jest.fn().mockResolvedValue(false) } as never,
    features as never,
    prisma as never,
  );
  const msg = (id: string) => ({ id, messaging: [{ sender: { id: `u-${id}` }, message: { mid: `m-${id}`, text: 'hi' } }] });

  beforeEach(() => {
    seen.length = 0;
    featureCompanies.length = 0;
    jest.clearAllMocks();
  });

  it('entry của 2 Page thuộc 2 công ty chạy đúng công ty; Page không có route bị bỏ', async () => {
    routes.set('facebook_page:111', 1);
    routes.set('facebook_page:222', 2);
    const payload = { object: 'page', entry: [msg('222'), msg('111'), msg('333'), msg('222')] };
    const raw = Buffer.from(JSON.stringify(payload));
    expect(await svc.receive(raw, signMetaBody(raw, 'appsecret'), payload)).toBe(3);
    expect(seen).toEqual([
      { page: '222', company: 2 },
      { page: '222', company: 2 },
      { page: '111', company: 1 },
    ]);
    // Cờ gói kiểm theo từng công ty.
    expect(featureCompanies).toEqual([2, 1]);
    // Không chạm DB công ty nào để tra Page lạ (không rơi về công ty 1).
    expect(prisma.facebookPage.findMany).not.toHaveBeenCalled();
  });

  it('chỉ có Page lạ ⇒ không xử lý gì', async () => {
    const payload = { object: 'page', entry: [msg('333')] };
    const raw = Buffer.from(JSON.stringify(payload));
    expect(await svc.receive(raw, signMetaBody(raw, 'appsecret'), payload)).toBe(0);
    expect(messenger.ingest).not.toHaveBeenCalled();
    expect(features.isEnabled).not.toHaveBeenCalled();
  });

  it('Page của công ty đã khoá (không active) ⇒ bỏ', async () => {
    routes.set('facebook_page:444', 99);
    const payload = { object: 'page', entry: [msg('444')] };
    const raw = Buffer.from(JSON.stringify(payload));
    expect(await svc.receive(raw, signMetaBody(raw, 'appsecret'), payload)).toBe(0);
  });

  it('chữ ký sai vẫn 401 trước mọi tra cứu', async () => {
    const payload = { object: 'page', entry: [msg('111')] };
    const raw = Buffer.from(JSON.stringify(payload));
    await expect(svc.receive(raw, 'sha256=' + '0'.repeat(64), payload)).rejects.toThrow('Chữ ký');
    expect(messenger.ingest).not.toHaveBeenCalled();
  });
});

describe('Webhook Zalo OA — theo oa_id', () => {
  const companies: Array<number | null> = [];
  const threads = {
    upsertThread: jest.fn(async () => {
      companies.push(currentCompanyId());
      return { id: 1, last_message_at: new Date(), contact_id: 1, display_name: 'x' };
    }),
    record: jest.fn().mockResolvedValue({ id: 1 }),
  };
  const svc = new ZaloOaWebhookService(threads as never, {} as never, {} as never, {} as never, { isEnabled: jest.fn().mockResolvedValue(true) } as never);
  const ev = (oa: string) => Buffer.from(JSON.stringify({ event_name: 'user_send_text', sender: { id: 'u1' }, recipient: { id: oa }, message: { msg_id: 'm', text: 'hi' }, timestamp: '1700000000000' }));

  beforeEach(() => {
    companies.length = 0;
  });

  it('OA thuộc công ty 3 ⇒ chạy dưới công ty 3; OA lạ ⇒ bỏ', async () => {
    routes.set('zalo_oa:OA3', 3);
    expect(await svc.receive(ev('OA3'), 'sig')).toEqual({ ok: true, handled: true });
    expect(companies).toEqual([3]);
    expect(await svc.receive(ev('OAX'), 'sig')).toEqual({ ok: true, handled: false });
    expect(companies).toEqual([3]);
  });
});

describe('Kết nối Facebook — state ghi theo công ty + một Page một công ty', () => {
  it('connectUrl ghi lại state (rememberOauthState) đúng giá trị gửi sang Facebook', async () => {
    const svc = new FacebookPagesService({} as never, {} as never, {} as never);
    const url = await runWithCompany(companyRef(2), () => svc.connectUrl({ userId: 5 } as never));
    const state = new URL(url.url).searchParams.get('state');
    expect(state).toBeTruthy();
    expect(remembered).toEqual([state]);
  });

  it('state ký ở công ty 2 không hợp lệ khi callback chạy dưới công ty 1', () => {
    const s = runWithCompany(companyRef(2), () => signFacebookState(5));
    expect(runWithCompany(companyRef(2), () => verifyFacebookState(s))).toEqual({ userId: 5 });
    expect(runWithCompany(companyRef(1), () => verifyFacebookState(s))).toBeNull();
  });

  it('callback: Page đã thuộc công ty khác ⇒ không lưu (đếm failed), Page còn lại vẫn lưu', async () => {
    routes.set('facebook_page:111', 1);
    const prisma = {
      settingOption: { findMany: jest.fn().mockResolvedValue([{ id: 9, label: 'Facebook' }]) },
      facebookPage: { upsert: jest.fn().mockResolvedValue({}) },
      socialAccount: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    };
    const graph = {
      exchangeCode: jest.fn().mockResolvedValue('short'),
      toLongLived: jest.fn().mockResolvedValue('long'),
      listPages: jest.fn().mockResolvedValue([
        { id: '111', name: 'Của công ty 1', access_token: 'T1' },
        { id: '222', name: 'Mới', access_token: 'T2' },
      ]),
      grantedPermissions: jest.fn().mockResolvedValue([]),
      subscribeApp: jest.fn().mockResolvedValue(true),
      debugToken: jest.fn().mockRejectedValue(new Error('x')),
    };
    const svc = new FacebookPagesService(prisma as never, graph as never, {} as never);
    jest.spyOn(svc as never, 'subscribe' as never).mockResolvedValue(true as never);
    const r = await runWithCompany(companyRef(2), async () => svc.handleCallback('CODE', signFacebookState(5)));
    expect(r).toEqual({ connected: 1, failed: 1, posting: 0 });
    expect(prisma.facebookPage.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.facebookPage.upsert.mock.calls[0][0].where).toEqual({ page_id: '222' });
  });
});

describe('route-taken', () => {
  it('lỗi trigger TRINITY_ROUTE_TAKEN ⇒ 409 tiếng Việt; lỗi khác ném lại nguyên', () => {
    const e = new Error('ERROR: TRINITY_ROUTE_TAKEN: facebook_page 1 is connected to another company');
    expect(isRouteTakenError(e)).toBe(true);
    expect(() => rethrowRouteTaken('zalo_oa')(e)).toThrow(ConflictException);
    const other = new Error('boom');
    expect(() => rethrowRouteTaken('facebook_page')(other)).toThrow('boom');
  });
});

describe('withCompanyHint', () => {
  it('công ty 1 / ngoài ngữ cảnh: giữ nguyên URL', () => {
    expect(runWithCompany(companyRef(1), () => withCompanyHint('https://x.vn/api/v1/hooks/in/tok'))).toBe('https://x.vn/api/v1/hooks/in/tok');
    expect(withCompanyHint('/api/v1/pay/ABC/vnpay')).toBe('/api/v1/pay/ABC/vnpay');
  });

  it('công ty khác: gắn cid, giữ query/hash, không gắn trùng', () => {
    runWithCompany(companyRef(7), () => {
      expect(withCompanyHint('https://x.vn/api/v1/facebook/go/AB')).toBe('https://x.vn/api/v1/facebook/go/AB?cid=7');
      expect(withCompanyHint('/s/shop?ref=qr#top')).toBe('/s/shop?ref=qr&cid=7#top');
      expect(withCompanyHint('/a?cid=7')).toBe('/a?cid=7');
      expect(withCompanyHint(null)).toBeNull();
    });
  });

  it('tắt multi-tenant: không đổi gì', () => {
    process.env.MULTI_TENANT = 'false';
    try {
      expect(runWithCompany(companyRef(7), () => withCompanyHint('/x'))).toBe('/x');
      expect(stateCompanyMatches(3)).toBe(true);
    } finally {
      process.env.MULTI_TENANT = 'true';
    }
  });

  it('stateCompanyMatches: state cũ không có claim chỉ hợp lệ cho công ty 1', () => {
    expect(runWithCompany(companyRef(1), () => stateCompanyMatches(undefined))).toBe(true);
    expect(runWithCompany(companyRef(2), () => stateCompanyMatches(undefined))).toBe(false);
    expect(runWithCompany(companyRef(2), () => stateCompanyMatches(2))).toBe(true);
    expect(runWithCompany(companyRef(2), () => stateCompanyMatches(1))).toBe(false);
  });
});
