import { BadRequestException } from '@nestjs/common';
import { SocialAccountsService } from '../social-accounts.service';
import { signSocialState } from '../social-oauth-state';

const KEY = Buffer.alloc(32, 7).toString('base64');
const ENV = { ...process.env };
beforeEach(() => {
  process.env.INTEGRATIONS_SECRET_KEY = KEY;
  process.env.JWT_SECRET = 'jwt';
  process.env.INTEGRATIONS_PUBLIC_BASE_URL = 'https://crm.example.vn';
});
afterEach(() => {
  process.env = { ...ENV };
});

function mk() {
  const prisma = {
    socialAccount: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), update: jest.fn(), upsert: jest.fn().mockResolvedValue({}) },
    facebookPage: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const provider = {
    supported: true,
    configured: () => true,
    exchange: jest.fn().mockResolvedValue([{ external_id: '111', name: 'Trang', avatar_url: null, access_token: 'PT', refresh_token: null, token_expires_at: null, scopes: ['pages_manage_posts'] }]),
  };
  const svc = new SocialAccountsService(prisma as never, { get: () => provider, all: () => [] } as never);
  return { svc, prisma, provider };
}

describe('SocialAccountsService.handleCallback', () => {
  it('kênh đã gỡ (disabled) nối lại chỉ làm mới token/tên, KHÔNG bật lại', async () => {
    const { svc, prisma } = mk();
    prisma.socialAccount.findUnique.mockResolvedValue({ status: 'disabled' });
    await svc.handleCallback('facebook', 'CODE', signSocialState(5, 'facebook'));
    const arg = prisma.socialAccount.upsert.mock.calls[0][0];
    expect(arg.update).not.toHaveProperty('status');
    expect(arg.update.access_token_enc).toMatch(/^v1\./);
    expect(arg.create.status).toBe('active');
  });

  it('kênh active/reauth/mới ⇒ đặt active, xoá lỗi', async () => {
    const { svc, prisma } = mk();
    prisma.socialAccount.findUnique.mockResolvedValue({ status: 'reauth' });
    await svc.handleCallback('facebook', 'CODE', signSocialState(5, 'facebook'));
    expect(prisma.socialAccount.upsert.mock.calls[0][0].update).toMatchObject({ status: 'active', last_error: null });
  });
});

describe('SocialAccountsService.enable', () => {
  it('từ chối khi không còn token', async () => {
    const { svc, prisma } = mk();
    prisma.socialAccount.findUnique.mockResolvedValue({ id: 3, status: 'disabled', access_token_enc: '' });
    await expect(svc.enable(3)).rejects.toThrow('Liên kết lại để bật kênh này');
    expect(prisma.socialAccount.update).not.toHaveBeenCalled();
  });

  it('kênh đang bật ⇒ 400; kênh disabled còn token ⇒ active', async () => {
    const { svc, prisma } = mk();
    prisma.socialAccount.findUnique.mockResolvedValue({ id: 3, status: 'active', access_token_enc: 'x' });
    await expect(svc.enable(3)).rejects.toThrow(BadRequestException);
    prisma.socialAccount.findUnique.mockResolvedValue({ id: 3, network: 'facebook', external_id: '1', name: 'T', status: 'disabled', access_token_enc: 'x' });
    prisma.socialAccount.update.mockResolvedValue({ id: 3, network: 'facebook', external_id: '1', name: 'T', status: 'active' });
    expect((await svc.enable(3)).status).toBe('active');
    expect(prisma.socialAccount.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { status: 'active', last_error: null } });
  });
});

describe('SocialAccountsService.list', () => {
  it('gắn removed cho kênh đã gỡ còn token, và inbox cho Fanpage', async () => {
    const { svc, prisma } = mk();
    const base = { avatar_url: null, last_error: null, token_expires_at: null, connected_by: 1, created_at: new Date() };
    prisma.socialAccount.findMany.mockResolvedValue([
      { ...base, id: 1, network: 'facebook', external_id: '111', name: 'A', status: 'active' },
      { ...base, id: 2, network: 'facebook', external_id: '222', name: 'B', status: 'disabled' },
      { ...base, id: 3, network: 'facebook', external_id: '333', name: 'C', status: 'active' },
      { ...base, id: 4, network: 'youtube', external_id: 'y', name: 'Y', status: 'active' },
    ]);
    prisma.facebookPage.findMany.mockResolvedValue([
      { page_id: '111', is_active: true, token_enc: 'x' },
      { page_id: '222', is_active: false, token_enc: '' },
    ]);
    const rows = await svc.list();
    expect(rows.map((r) => [r.id, r.removed, r.inbox])).toEqual([[1, false, 'on'], [2, true, 'off'], [3, false, null], [4, false, undefined]]);
  });
});
