import { encryptSecret, loadSecretKey } from '../../integrations/webhooks/secret-crypto';
import { firstCommentOf, postFirstComment } from '../facebook-first-comment';
import { FacebookSocialProvider } from '../providers/facebook.provider';

const ENV = { ...process.env };
beforeEach(() => {
  process.env.INTEGRATIONS_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

describe('Facebook: bình luận đầu tiên', () => {
  it('lấy chữ bình luận (bỏ khoảng trắng thừa); kiểm độ dài', () => {
    expect(firstCommentOf({ first_comment: '  Link mua: https://shop.vn  ' })).toBe('Link mua: https://shop.vn');
    expect(firstCommentOf({ first_comment: '   ' })).toBeNull();
    expect(firstCommentOf({})).toBeNull();
    const fb = new FacebookSocialProvider();
    expect(fb.validateOptions!('x', { first_comment: 'ok' })).toBeNull();
    expect(fb.validateOptions!('x', { first_comment: 'a'.repeat(8001) })).toMatch(/8.000/);
  });

  it('đăng bằng token của kết nối Fanpage Facebook, đúng bài vừa lên', async () => {
    const token_enc = encryptSecret('page-token-xyz', loadSecretKey());
    const prisma = { facebookPage: { findFirst: jest.fn(async () => ({ token_enc })) } };
    const f = jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { id: 'c1' }));
    expect(await postFirstComment(prisma as never, 'P1', 'P1_99', 'Link mua hàng')).toBe('posted');
    expect(prisma.facebookPage.findFirst).toHaveBeenCalledWith({ where: { page_id: 'P1', is_active: true }, select: { token_enc: true } });
    expect(String(f.mock.calls[0][0])).toMatch(/graph\.facebook\.com\/v[\d.]+\/P1_99\/comments$/);
    const body = new URLSearchParams(String(f.mock.calls[0][1]?.body));
    expect(body.get('message')).toBe('Link mua hàng');
    expect(body.get('access_token')).toBe('page-token-xyz');
  });

  it('Fanpage chưa kết nối ở mục Fanpage Facebook ⇒ bỏ qua, không gọi Facebook; Facebook từ chối ⇒ lỗi rõ', async () => {
    const f = jest.spyOn(global, 'fetch');
    expect(await postFirstComment({ facebookPage: { findFirst: jest.fn(async () => null) } } as never, 'P1', 'P1_99', 'x')).toBe('no_page');
    expect(f).not.toHaveBeenCalled();
    const token_enc = encryptSecret('t', loadSecretKey());
    f.mockResolvedValueOnce(res(403, { error: { message: '(#200) Requires pages_manage_engagement permission' } }));
    await expect(postFirstComment({ facebookPage: { findFirst: jest.fn(async () => ({ token_enc })) } } as never, 'P1', 'P1_99', 'x')).rejects.toThrow(/pages_manage_engagement/);
  });
});

describe('Tạo bài có bình luận đầu tiên — kiểm điều kiện ngay', () => {
  const { SocialPostsService } = jest.requireActual('../social-posts.service');
  const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} };
  function svc(page: unknown) {
    const prisma = {
      socialAccount: { findMany: jest.fn(async () => [{ id: 3, network: 'facebook', name: 'Tiệm Bánh', status: 'active', external_id: 'P1' }]) },
      facebookPage: { findFirst: jest.fn(async () => page) },
    };
    const provider = { supported: true, validateMedia: () => null, validateOptions: () => null };
    return new SocialPostsService(prisma, {}, { resolve: async () => [] }, { get: () => provider });
  }
  const input = { content: 'Bài mới', media_keys: [], targets: [{ account_id: 3, options: { first_comment: 'Link mua' } }] };

  it('chưa bật quyền bình luận trên máy chủ ⇒ 400', async () => {
    delete process.env.FACEBOOK_COMMENT_AUTOMATION;
    await expect(svc({ id: 1 }).validate(user, input)).rejects.toThrow(/FACEBOOK_COMMENT_AUTOMATION/);
  });

  it('đã bật nhưng Fanpage chưa nối ở mục Fanpage Facebook ⇒ 400; đã nối ⇒ qua', async () => {
    process.env.FACEBOOK_COMMENT_AUTOMATION = '1';
    await expect(svc(null).validate(user, input)).rejects.toThrow(/chưa kết nối/);
    await expect(svc({ id: 1 }).validate(user, input)).resolves.toMatchObject({ content: 'Bài mới' });
  });
});
