import { InstagramSocialProvider } from '../providers/instagram.provider';
import { SocialPostGoneError, type AccountForPublish, type SocialMedia } from '../providers/provider.types';
import { mediaLinkExt, signMediaLink, verifyMediaLink } from '../social-media-link';

const ENV = { ...process.env };
beforeEach(() => {
  process.env.FACEBOOK_APP_ID = 'app1';
  process.env.FACEBOOK_APP_SECRET = 'fb-secret';
  process.env.INSTAGRAM_PUBLISH_ENABLED = 'true';
  process.env.JWT_SECRET = 'j'.repeat(32);
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const acc: AccountForPublish = { id: 7, external_id: 'ig1', name: '@shop', access_token: 'page-token', refresh_token: null, token_expires_at: null };
const img = (k: string, ct = 'image/jpeg'): SocialMedia => ({ key: k, type: 'image', content_type: ct, size: 3 });
const vid: SocialMedia = { key: 'v', type: 'video', content_type: 'video/mp4', size: 3 };
const load = async (m: SocialMedia) => ({ ...m, body: Buffer.from('abc') });
const publicUrl = (m: SocialMedia) => `https://crm.test/api/v1/social/media-link/tok/${m.key}.jpg`;

function provider() {
  const p = new InstagramSocialProvider();
  p.sleep = async () => undefined;
  return p;
}

/** Trả lời fetch theo (method, path) — status container lấy lần lượt từ `statuses`. */
function graph(statuses: string[] = ['FINISHED']) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  let n = 0;
  let st = 0;
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v[\d.]+\//, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (method === 'POST' && path === 'ig1/media') return res(200, { id: `c${++n}` });
    if (method === 'POST' && path === 'ig1/media_publish') return res(200, { id: 'm99' });
    if (method === 'GET' && path === 'm99') return res(200, { permalink: 'https://www.instagram.com/p/AbC123/' });
    if (method === 'GET' && /^c\d+$/.test(path)) return res(200, { status_code: statuses[Math.min(st++, statuses.length - 1)] });
    return res(404, { error: { code: 100, message: 'unexpected ' + path } });
  });
  return calls;
}

describe('Instagram: kiểm tệp', () => {
  const p = new InstagramSocialProvider();
  it.each([
    [[], /phải có ảnh hoặc video/],
    [[img('a'), vid], /không ghép video/],
    [[vid, vid], /một video/],
    [Array.from({ length: 11 }, (_, i) => img(String(i))), /tối đa 10/],
    [[img('a', 'image/png')], /chỉ nhận ảnh JPG/],
    [[{ ...vid, content_type: 'video/webm' }], /MP4 hoặc MOV/],
  ])('%#', (media, msg) => expect(p.validateMedia(media as SocialMedia[])).toMatch(msg));
  it('JPG hoặc một MP4 là hợp lệ', () => {
    expect(p.validateMedia([img('a'), img('b')])).toBeNull();
    expect(p.validateMedia([vid])).toBeNull();
  });
  it('chỉ "đã cấu hình" khi có app Meta VÀ bật cờ INSTAGRAM_PUBLISH_ENABLED', () => {
    expect(p.configured()).toBe(true);
    delete process.env.INSTAGRAM_PUBLISH_ENABLED;
    expect(p.configured()).toBe(false);
  });
});

describe('Instagram: liên kết', () => {
  it('nhận tài khoản IG chuyên nghiệp gắn với Page, token là token Page; Page không có IG bị bỏ', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('oauth/access_token')) return res(200, { access_token: u.searchParams.get('code') ? 'short' : 'long' });
      return res(200, {
        data: [
          { id: 'p1', name: 'Trang 1', access_token: 'pt1', instagram_business_account: { id: 'ig1', username: 'shop', profile_picture_url: 'https://x/a.jpg' } },
          { id: 'p2', name: 'Trang 2', access_token: 'pt2' },
        ],
      });
    });
    const out = await new InstagramSocialProvider().exchange('code', 'https://crm.test/cb');
    expect(out).toEqual([expect.objectContaining({ external_id: 'ig1', name: '@shop', access_token: 'pt1', avatar_url: 'https://x/a.jpg' })]);
  });
  it('không Page nào có IG ⇒ báo cách chuyển tài khoản', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
      String(url).includes('oauth/access_token') ? res(200, { access_token: 't' }) : res(200, { data: [{ id: 'p', name: 'P', access_token: 'x' }] }),
    );
    await expect(new InstagramSocialProvider().exchange('c', 'u')).rejects.toThrow(/tài khoản Instagram chuyên nghiệp/);
  });
});

describe('Instagram: đăng', () => {
  it('một ảnh: container image_url (link công khai) → chờ FINISHED → media_publish → permalink', async () => {
    const calls = graph(['IN_PROGRESS', 'FINISHED']);
    const r = await provider().publish(acc, { text: 'Chào', media: [img('a')], options: {}, load, publicUrl });
    expect(r).toEqual({ external_post_id: 'm99', url: 'https://www.instagram.com/p/AbC123/' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: 'ig1/media', body: { image_url: publicUrl(img('a')), caption: 'Chào' } });
    expect(calls.filter((c) => c.path === 'c1')).toHaveLength(2);
    expect(calls.find((c) => c.path === 'ig1/media_publish')?.body).toEqual({ creation_id: 'c1' });
  });
  it('nhiều ảnh: container con is_carousel_item rồi CAROUSEL có children', async () => {
    const calls = graph();
    await provider().publish(acc, { text: 'Album', media: [img('a'), img('b')], options: {}, load, publicUrl });
    const posts = calls.filter((c) => c.method === 'POST' && c.path === 'ig1/media').map((c) => c.body);
    expect(posts[0]).toMatchObject({ is_carousel_item: true });
    expect(posts[2]).toMatchObject({ media_type: 'CAROUSEL', children: 'c1,c2', caption: 'Album' });
  });
  it('video: REELS video_url', async () => {
    const calls = graph();
    await provider().publish(acc, { text: 'Clip', media: [vid], options: {}, load, publicUrl });
    expect(calls[0].body).toMatchObject({ media_type: 'REELS', video_url: publicUrl(vid) });
  });
  it('container ERROR ⇒ lỗi luôn (không thử lại); xử lý quá lâu ⇒ lỗi tạm', async () => {
    graph(['ERROR']);
    await expect(provider().publish(acc, { text: '', media: [vid], options: {}, load, publicUrl })).rejects.toMatchObject({ kind: 'invalid' });
    jest.restoreAllMocks();
    graph(['IN_PROGRESS']);
    const p = provider();
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 10_000));
    await expect(p.publish(acc, { text: '', media: [vid], options: {}, load, publicUrl })).rejects.toMatchObject({ kind: 'temporary' });
  });
  it('lỗi Graph mang nhãn Instagram, token hết hạn ⇒ liên kết lại', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(res(400, { error: { code: 190, message: 'expired' } }));
    await expect(provider().publish(acc, { text: '', media: [img('a')], options: {}, load, publicUrl })).rejects.toMatchObject({
      kind: 'token',
      message: expect.stringMatching(/^Instagram/),
    });
  });
});

describe('Instagram: số liệu', () => {
  it('thích + bình luận; lượt xem/chia sẻ null', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(res(200, { like_count: 5, comments_count: 2 }));
    expect(await provider().fetchMetrics(acc, 'm99')).toEqual({ views: null, reactions: 5, comments: 2, shares: null });
  });
  it('bài đã bị xoá ⇒ SocialPostGoneError', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(res(400, { error: { code: 100, error_subcode: 33, message: 'Object with ID m99 does not exist' } }));
    await expect(provider().fetchMetrics(acc, 'm99')).rejects.toBeInstanceOf(SocialPostGoneError);
  });
});

describe('link tệp công khai có chữ ký', () => {
  it('ký rồi kiểm ra đúng khoá; sai chữ ký / hết hạn ⇒ null', () => {
    const t = signMediaLink({ key: 'social/u1_a.jpg', content_type: 'image/jpeg' }, 1_000);
    expect(verifyMediaLink(t, 1_000)).toEqual({ key: 'social/u1_a.jpg', contentType: 'image/jpeg' });
    expect(verifyMediaLink(t.slice(0, -2) + 'xx', 1_000)).toBeNull();
    expect(verifyMediaLink(t, 1_000 + 3 * 60 * 60 * 1000)).toBeNull();
    expect(verifyMediaLink('rác', 1_000)).toBeNull();
  });
  it('đuôi tệp theo loại', () => {
    expect(mediaLinkExt('image/jpeg')).toBe('jpg');
    expect(mediaLinkExt('video/mp4')).toBe('mp4');
  });
});
