import { actionToolByName } from '../actions/action-registry';
import { enableSocialAccountTool, listSocialAccountsTool } from '../tools/social-tools';

const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
const deps = (accounts: Record<string, unknown>) =>
  ({ social: { accounts, posts: {}, drafts: {}, queue: {}, snippets: {} }, orgFeatures: { isEnabled: jest.fn(async () => true) } }) as any;
const ctx = (d: any) => ({ deps: d, baseUrl: 'https://crm.example.com', principal: { user } }) as never;

describe('enable_social_account', () => {
  it('ghi trực tiếp, crm.write, cần social.manage, không có tool gỡ', () => {
    expect(enableSocialAccountTool.scope).toBe('crm.write');
    expect(enableSocialAccountTool.permissions).toEqual(['social.manage']);
    expect(actionToolByName('enable_social_account')).toBeUndefined();
  });
  it('bật được thì trả kênh; lỗi 4xx của service (không còn token) thành lỗi người dùng', async () => {
    const accounts = { enable: jest.fn(async (id: number) => ({ id, network: 'facebook', name: 'T', status: 'active' })) };
    const r = await enableSocialAccountTool.run({ account_id: 4 }, ctx(deps(accounts)));
    expect((r.structured.data as any).status).toBe('active');
    accounts.enable.mockRejectedValueOnce(Object.assign(new Error('Liên kết lại để bật kênh này'), { status: 400 }));
    await expect(enableSocialAccountTool.run({ account_id: 4 }, ctx(deps(accounts)))).rejects.toThrow('Liên kết lại để bật kênh này');
  });
});

describe('list_social_accounts', () => {
  it('trả removed và inbox (chỉ Facebook)', async () => {
    const accounts = {
      list: jest.fn(async () => [
        { id: 1, network: 'facebook', name: 'A', status: 'disabled', last_error: null, removed: true, inbox: 'off' },
        { id: 2, network: 'youtube', name: 'Y', status: 'active', last_error: null, removed: false },
      ]),
      networks: () => [],
    };
    const r = await listSocialAccountsTool.run({}, ctx(deps(accounts)));
    const rows = (r.structured.data as any).accounts;
    expect(rows[0]).toMatchObject({ account_id: 1, removed: true, inbox: 'off' });
    expect(rows[1]).toMatchObject({ account_id: 2, removed: false });
    expect(rows[1]).not.toHaveProperty('inbox');
  });
});
