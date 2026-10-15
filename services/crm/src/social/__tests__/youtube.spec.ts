import { SocialPublishError, type AccountForPublish, type SocialMedia } from '../providers/provider.types';
import { YoutubeSocialProvider, classifyGoogleError, youtubePrivacy, youtubeTitle } from '../providers/youtube.provider';
import { SocialPostsService } from '../social-posts.service';
import type { SocialProviderRegistry } from '../providers/provider.registry';

const ENV = { ...process.env };
beforeEach(() => {
  process.env.GOOGLE_SOCIAL_CLIENT_ID = 'cid.apps.googleusercontent.com';
  process.env.GOOGLE_SOCIAL_CLIENT_SECRET = 'g-secret';
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: status < 400, status, json: async () => body, headers: new Headers(headers) }) as Response;
const video: SocialMedia = { key: 'social/u1_v.mp4', type: 'video', content_type: 'video/mp4', size: 5 };
const img: SocialMedia = { key: 'social/u1_i.png', type: 'image', content_type: 'image/png', size: 3 };
const acc: AccountForPublish = { id: 2, external_id: 'UC123', name: 'Kênh', access_token: 'yt-token', refresh_token: 'r-token', token_expires_at: null };
const load = async (m: SocialMedia) => ({ ...m, body: Buffer.from('12345') });

describe('YouTube: tiêu đề, quyền xem', () => {
  it('tiêu đề lấy từ tuỳ chọn, không có thì dòng đầu; bỏ < >, cắt 100 ký tự', () => {
    expect(youtubeTitle('\n  Dòng đầu <b>\nDòng hai', {})).toBe('Dòng đầu b');
    expect(youtubeTitle('Nội dung', { title: '  Tiêu đề riêng ' })).toBe('Tiêu đề riêng');
    const long = youtubeTitle('x'.repeat(150), {});
    expect(long).toHaveLength(100);
    expect(long.endsWith('…')).toBe(true);
  });

  it('quyền xem mặc định private; giá trị lạ cũng về private', () => {
    expect(youtubePrivacy({})).toBe('private');
    expect(youtubePrivacy({ privacy: 'public' })).toBe('public');
    expect(youtubePrivacy({ privacy: 'everyone' })).toBe('private');
  });
});

describe('phân loại lỗi Google', () => {
  it.each([
    [400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 'token'],
    [401, { error: { code: 401, message: 'Invalid Credentials' } }, 'token'],
    [403, { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }, 'rate'],
    [400, { error: { code: 400, errors: [{ reason: 'uploadLimitExceeded' }] } }, 'rate'],
    [403, { error: { code: 403, errors: [{ reason: 'forbidden' }] } }, 'permission'],
    [503, { error: { code: 503, message: 'backend' } }, 'temporary'],
    [400, { error: { code: 400, errors: [{ reason: 'invalidTitle' }] } }, 'invalid'],
  ])('%s %j ⇒ %s', (status, body, kind) => {
    expect(classifyGoogleError(status as number, body as never).kind).toBe(kind);
  });
});

describe('YoutubeSocialProvider', () => {
  const yt = new YoutubeSocialProvider();

  it('chỉ cấu hình khi đủ client id + secret', () => {
    expect(yt.configured()).toBe(true);
    delete process.env.GOOGLE_SOCIAL_CLIENT_SECRET;
    expect(yt.configured()).toBe(false);
  });

  it('mỗi bài đúng một video, không kèm ảnh', () => {
    expect(yt.validateMedia([video])).toBeNull();
    expect(yt.validateMedia([])).toMatch(/đúng một video/);
    expect(yt.validateMedia([video, img])).toMatch(/đúng một video/);
    expect(yt.validateMedia([video, video])).toMatch(/đúng một video/);
  });

  it('tuỳ chọn: quyền xem lạ, tiêu đề rỗng ⇒ lỗi', () => {
    expect(yt.validateOptions('Tiêu đề', { privacy: 'unlisted' })).toBeNull();
    expect(yt.validateOptions('Tiêu đề', { privacy: 'everyone' })).toMatch(/private, unlisted/);
    expect(yt.validateOptions('   ', {})).toMatch(/cần tiêu đề/);
  });

  it('URL đăng nhập: offline + consent để có refresh token, đúng hai scope', () => {
    const u = new URL(yt.authorizeUrl('st', 'https://crm.example.com/api/v1/social/oauth/callback/youtube'));
    expect(u.host).toBe('accounts.google.com');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl');
    expect(u.searchParams.get('state')).toBe('st');
  });

  it('đổi code ⇒ token + kênh; client secret đi trong body, không trong URL', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl' }))
      .mockResolvedValueOnce(res(200, { items: [{ id: 'UC1', snippet: { title: 'Kênh Trinity', thumbnails: { default: { url: 'https://i/1.jpg' } } } }] }));
    const out = await yt.exchange('code', 'https://crm.example.com/cb');
    expect(String(f.mock.calls[0][0])).toBe('https://oauth2.googleapis.com/token');
    expect(String(f.mock.calls[0][1]?.body)).toContain('client_secret=g-secret');
    expect(String(f.mock.calls[1][0])).toContain('/youtube/v3/channels?part=snippet&mine=true');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ external_id: 'UC1', name: 'Kênh Trinity', access_token: 'a', refresh_token: 'r' });
    expect(out[0].token_expires_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it('đổi code mà thiếu quyền upload hoặc chưa có kênh ⇒ lỗi rõ', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { access_token: 'a', refresh_token: 'r', scope: 'https://www.googleapis.com/auth/youtube.readonly' }));
    await expect(yt.exchange('c', 'u')).rejects.toMatchObject({ kind: 'permission' });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(200, { access_token: 'a', refresh_token: 'r', scope: 'https://www.googleapis.com/auth/youtube.upload' }))
      .mockResolvedValueOnce(res(200, { items: [] }));
    await expect(yt.exchange('c', 'u')).rejects.toThrow(/chưa có kênh YouTube/);
  });

  it('làm mới token: giữ refresh cũ khi Google không trả mới; invalid_grant ⇒ token', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { access_token: 'new', expires_in: 3599 }));
    const t = await yt.refresh(acc);
    expect(t).toMatchObject({ access_token: 'new', refresh_token: null });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(400, { error: 'invalid_grant' }));
    await expect(yt.refresh(acc)).rejects.toMatchObject({ kind: 'token' });
  });

  it('đăng: tạo phiên resumable (metadata private) rồi PUT tệp vào Location', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(200, {}, { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1' }))
      .mockResolvedValueOnce(res(200, { id: 'vid123' }));
    const out = await yt.publish(acc, { text: 'Video thử\nMô tả', media: [video], options: {}, load, publicUrl: () => "" });
    expect(out).toEqual({ external_post_id: 'vid123', url: 'https://www.youtube.com/watch?v=vid123' });
    const [initUrl, init] = f.mock.calls[0];
    expect(String(initUrl)).toContain('uploadType=resumable');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer yt-token');
    expect((init?.headers as Record<string, string>)['X-Upload-Content-Length']).toBe('5');
    const meta = JSON.parse(String(init?.body));
    expect(meta.snippet.title).toBe('Video thử');
    expect(meta.status.privacyStatus).toBe('private');
    expect(String(f.mock.calls[1][0])).toContain('upload_id=U1');
    expect(f.mock.calls[1][1]?.method).toBe('PUT');
  });

  it('hết hạn mức ⇒ rate (thử lại); lỗi mạng ⇒ temporary', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(403, { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }));
    const e = await yt.publish(acc, { text: 'x', media: [video], options: {}, load, publicUrl: () => "" }).catch((x) => x);
    expect(e).toBeInstanceOf(SocialPublishError);
    expect((e as SocialPublishError).retryable).toBe(true);
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(yt.publish(acc, { text: 'x', media: [video], options: {}, load, publicUrl: () => "" })).rejects.toMatchObject({ kind: 'temporary' });
  });

  it('thiếu scope ⇒ báo liên kết lại, không nói "không có quyền đăng"', () => {
    const e = classifyGoogleError(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } });
    expect(e.kind).toBe('permission');
    expect(e.message).toMatch(/liên kết lại kênh/);
  });

  it('gỡ video ⇒ DELETE videos?id=', async () => {
    const f = jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(204, {}));
    await yt.deletePost(acc, 'vid123');
    expect(String(f.mock.calls[0][0])).toBe('https://www.googleapis.com/youtube/v3/videos?id=vid123');
    expect(f.mock.calls[0][1]?.method).toBe('DELETE');
  });
});

describe('SocialPostsService: token sắp hết hạn được làm mới trước khi đăng', () => {
  it('làm mới, lưu token mới, đăng bằng token mới', async () => {
    const target = { id: 21, post_id: 4, account_id: 6, network: 'youtube', caption: null, options: {}, status: 'publishing', attempts: 1 };
    const prisma = {
      socialPostTarget: { findUnique: jest.fn().mockResolvedValue(target), update: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([{ status: 'published' }]) },
      socialPost: { findUnique: jest.fn().mockResolvedValue({ id: 4, content: 'Video', media: [video], scheduled_at: null }), update: jest.fn() },
      socialAccount: { findUnique: jest.fn().mockResolvedValue({ id: 6, network: 'youtube', status: 'active' }) },
    };
    const accounts = {
      forPublish: jest.fn().mockReturnValue({ ...acc, token_expires_at: new Date(Date.now() + 60_000) }),
      saveRefreshed: jest.fn(),
      markReauth: jest.fn(),
    };
    const publish = jest.fn().mockResolvedValue({ external_post_id: 'v9', url: 'https://www.youtube.com/watch?v=v9' });
    const provider = { network: 'youtube', supported: true, refresh: jest.fn().mockResolvedValue({ access_token: 'fresh', token_expires_at: new Date(Date.now() + 3_600_000) }), publish };
    const svc = new SocialPostsService(prisma as never, accounts as never, { load } as never, { get: () => provider } as unknown as SocialProviderRegistry);
    expect(await svc.processOne(21)).toBe('published');
    expect(accounts.saveRefreshed).toHaveBeenCalledWith(6, expect.objectContaining({ access_token: 'fresh' }));
    expect(publish.mock.calls[0][0].access_token).toBe('fresh');
    expect(publish.mock.calls[0][0].refresh_token).toBe('r-token');
  });
});

describe('YouTube: mô tả, thẻ, danh mục, trẻ em, thumbnail, playlist', () => {
  const yt = new YoutubeSocialProvider();

  it('kiểm tuỳ chọn: danh mục lạ, tags quá dài, cờ trẻ em sai kiểu, playlist lạ ⇒ lỗi', () => {
    expect(yt.validateOptions('Tiêu đề', { category_id: '27', tags: ['a', 'b'], made_for_kids: false, description: 'mô tả' })).toBeNull();
    expect(yt.validateOptions('T', { category_id: '999' })).toMatch(/danh mục/);
    expect(yt.validateOptions('T', { tags: Array.from({ length: 60 }, (_, i) => `the-dai-${i}`) })).toMatch(/500/);
    expect(yt.validateOptions('T', { made_for_kids: 'yes' })).toMatch(/trẻ em/);
    expect(yt.validateOptions('T', { playlist_id: '../x' })).toMatch(/playlist/);
  });

  it('đăng: metadata có mô tả riêng, thẻ (bỏ trùng), danh mục, cờ trẻ em; sau đó đặt thumbnail và thêm vào playlist', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(200, {}, { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1' }))
      .mockResolvedValueOnce(res(200, { id: 'vid9' }))
      .mockResolvedValueOnce(res(200, {}))
      .mockResolvedValueOnce(res(200, {}));
    const options = { title: 'Bánh mới', description: 'Mô tả riêng', tags: ['bánh', 'Bánh', 'công thức'], category_id: '26', made_for_kids: true, playlist_id: 'PLabcdefghij12', thumbnail: img };
    const out = await yt.publish(acc, { text: 'Nội dung bài', media: [video], options, load, publicUrl: () => '' });
    expect(out.external_post_id).toBe('vid9');
    const meta = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(meta.snippet).toMatchObject({ title: 'Bánh mới', description: 'Mô tả riêng', categoryId: '26', tags: ['bánh', 'công thức'] });
    expect(meta.status.selfDeclaredMadeForKids).toBe(true);
    expect(String(f.mock.calls[2][0])).toBe('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=vid9');
    expect((f.mock.calls[2][1]?.headers as Record<string, string>)['Content-Type']).toBe('image/png');
    expect(JSON.parse(String(f.mock.calls[3][1]?.body))).toEqual({ snippet: { playlistId: 'PLabcdefghij12', resourceId: { kind: 'youtube#video', videoId: 'vid9' } } });
  });

  it('thumbnail / playlist lỗi không làm hỏng lượt đăng (video đã lên)', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(200, {}, { location: 'https://u' }))
      .mockResolvedValueOnce(res(200, { id: 'vid10' }))
      .mockResolvedValueOnce(res(403, { error: { code: 403, message: 'The authenticated user doesnt have permissions to upload and set custom video thumbnails.' } }))
      .mockResolvedValueOnce(res(404, { error: { code: 404, message: 'playlist not found' } }));
    const out = await yt.publish(acc, { text: 'x', media: [video], options: { thumbnail: img, playlist_id: 'PLabcdefghij12' }, load, publicUrl: () => '' });
    expect(out.external_post_id).toBe('vid10');
  });

  it('không chọn gì thêm ⇒ mặc định: mô tả = nội dung, danh mục 22, không dành cho trẻ em, không gọi thumbnail/playlist', async () => {
    const f = jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, {}, { location: 'https://u' })).mockResolvedValueOnce(res(200, { id: 'v' }));
    await yt.publish(acc, { text: 'Nội dung', media: [video], options: {}, load, publicUrl: () => '' });
    const meta = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(meta.snippet).toMatchObject({ description: 'Nội dung', categoryId: '22' });
    expect(meta.snippet.tags).toBeUndefined();
    expect(meta.status.selfDeclaredMadeForKids).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('playlist của kênh: mine=true, trả id + tên', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(200, { items: [{ id: 'PL1', snippet: { title: 'Công thức' } }], nextPageToken: 'P2' }))
      .mockResolvedValueOnce(res(200, { items: [{ id: 'PL2', snippet: { title: 'Mẹo vặt' } }] }));
    expect(await yt.listPlaylists(acc)).toEqual([{ id: 'PL1', title: 'Công thức' }, { id: 'PL2', title: 'Mẹo vặt' }]);
    expect(String(f.mock.calls[1][0])).toContain('pageToken=P2');
    expect(String(f.mock.calls[0][0])).toContain('youtube/v3/playlists?part=snippet&mine=true');
  });
});
