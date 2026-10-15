import type { OauthClient } from '@prisma/client';
import { OauthTokenService } from '../oauth-token.service';
import { OAuthError } from '../oauth-error';

describe('OauthTokenService.refresh — scope offline_access', () => {
  const row = {
    id: BigInt(1), client_id: 'c1', user_id: 7, family_id: 'f1', scopes: ['crm.read', 'crm.write'], resource: 'r',
    revoked_at: null, refresh_expires_at: new Date(Date.now() + 60_000), refresh_used_at: null,
  };
  function make() {
    const prisma = {
      oauthToken: { findUnique: jest.fn().mockResolvedValue(row), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = new OauthTokenService(prisma as never, {} as never, {} as never, audit as never);
    jest.spyOn(svc as never, 'userStillAllowed').mockResolvedValue(true as never);
    const issue = jest.spyOn(svc as never, 'issue').mockResolvedValue({ access_token: 'a' } as never);
    const refresh = (scope?: string) =>
      (svc as unknown as { refresh: (c: OauthClient, b: Record<string, unknown>) => Promise<unknown> }).refresh(
        { client_id: 'c1' } as OauthClient,
        { refresh_token: 'tok', ...(scope ? { scope } : {}) },
      );
    return { refresh, issue };
  }

  it('scope đã xin kèm offline_access vẫn làm mới được (không invalid_scope)', async () => {
    const { refresh, issue } = make();
    await refresh('crm.read offline_access');
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['crm.read'] }));
  });

  it('chỉ offline_access ⇒ giữ nguyên scope đã cấp', async () => {
    const { refresh, issue } = make();
    await refresh('offline_access');
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['crm.read', 'crm.write'] }));
  });

  it('scope lạ vẫn bị từ chối', async () => {
    const { refresh } = make();
    await expect(refresh('crm.read admin')).rejects.toBeInstanceOf(OAuthError);
  });
});
