import type { AccountForPublish, SocialMedia } from '../providers/provider.types';
import { TiktokSocialProvider, classifyTiktokError, tiktokChunks, tiktokOptions, tiktokPrivacy } from '../providers/tiktok.provider';

const ENV = { ...process.env };
beforeEach(() => {
  process.env.TIKTOK_CLIENT_KEY = 'ck';
  process.env.TIKTOK_CLIENT_SECRET = 'tt-secret';
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
});
afterEach(() => {
  process.env = { ...ENV };
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const MB = 1024 * 1024;
const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const okData = (data: unknown) => res(200, { data, error: { code: 'ok', message: '' } });
const video: SocialMedia = { key: 'social/u1_v.mp4', type: 'video', content_type: 'video/mp4', size: 5 };
const acc: AccountForPublish = { id: 3, external_id: 'open1', name: 'tt', access_token: 'tt-token', refresh_token: 'tt-r', token_expires_at: null };
const loadOf = (n: number) => async (m: SocialMedia) => ({ ...m, body: Buffer.alloc(n, 1) });

/** Chạy publish trong khi đẩy đồng hồ giả qua các nhịp chờ trạng thái. */
async function run<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const out = p.finally(() => (done = true));
  out.catch(() => undefined);
  for (let i = 0; i < 20 && !done; i++) await jest.advanceTimersByTimeAsync(3_000);
  return out;
}

describe('TikTok: quyền xem, chia khúc', () => {
  it('quyền xem không có mặc định (TikTok cấm chọn sẵn)', () => {
    expect(tiktokPrivacy({})).toBeNull();
    expect(tiktokPrivacy({ privacy_level: 'PUBLIC_TO_EVERYONE' })).toBe('PUBLIC_TO_EVERYONE');
    expect(tiktokPrivacy({ privacy_level: 'public' })).toBeNull();
  });

  it('bình luận/Duet/Stitch và công bố thương mại mặc định tắt; chỉ true thật mới bật', () => {
    expect(tiktokOptions({ privacy_level: 'SELF_ONLY' })).toEqual({
      privacy_level: 'SELF_ONLY', allow_comment: false, allow_duet: false, allow_stitch: false, brand_organic: false, brand_content: false, video_duration_sec: null,
    });
    expect(tiktokOptions({ allow_comment: 'true', allow_duet: 1, brand_content: true, video_duration_sec: '12.5' })).toMatchObject({
      allow_comment: false, allow_duet: false, brand_content: true, video_duration_sec: 12.5,
    });
  });

  it('≤ 64 MB tải một khúc; lớn hơn chia khúc 10 MB, khúc cuối gánh phần dư', () => {
    expect(tiktokChunks(3 * MB)).toEqual({ chunk_size: 3 * MB, total_chunk_count: 1 });
    expect(tiktokChunks(64 * MB)).toEqual({ chunk_size: 64 * MB, total_chunk_count: 1 });
    expect(tiktokChunks(105 * MB)).toEqual({ chunk_size: 10 * MB, total_chunk_count: 10 });
  });
});

describe('phân loại lỗi TikTok', () => {
  it.each([
    [400, { error: 'invalid_grant', error_description: 'expired' }, 'token'],
    [401, { error: { code: 'access_token_invalid' } }, 'token'],
    [429, { error: { code: 'rate_limit_exceeded' } }, 'rate'],
    [403, { error: { code: 'unaudited_client_can_only_post_to_private_accounts' } }, 'permission'],
    [403, { error: { code: 'spam_risk_too_many_posts' } }, 'permission'],
    [400, { error: { code: 'scope_not_authorized' } }, 'permission'],
    [500, { error: { code: 'internal_error' } }, 'temporary'],
    [400, { error: { code: 'invalid_params' } }, 'invalid'],
  ])('%s %j ⇒ %s', (status, body, kind) => {
    expect(classifyTiktokError(status as number, body as never).kind).toBe(kind);
  });
});

describe('TiktokSocialProvider', () => {
  const tt = new TiktokSocialProvider();

  it('một video, không ảnh; quyền xem lạ bị chặn', () => {
    expect(tt.validateMedia([video])).toBeNull();
    expect(tt.validateMedia([])).toMatch(/đúng một video/);
    expect(tt.validateOptions('x', { privacy_level: 'SELF_ONLY' })).toBeNull();
    expect(tt.validateOptions('x', { privacy_level: 'everyone' })).toMatch(/quyền xem/);
    expect(tt.validateOptions('x', {})).toMatch(/chọn ai được xem/);
    expect(tt.validateOptions('x', { privacy_level: 'SELF_ONLY', brand_content: true })).toMatch(/Chỉ mình tôi/);
    expect(tt.validateOptions('x', { privacy_level: 'PUBLIC_TO_EVERYONE', brand_content: true, brand_organic: true })).toBeNull();
  });

  it('URL đăng nhập dùng client_key và đúng hai scope', () => {
    const u = new URL(tt.authorizeUrl('st', 'https://crm.example.com/api/v1/social/oauth/callback/tiktok'));
    expect(u.origin + u.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(u.searchParams.get('client_key')).toBe('ck');
    expect(u.searchParams.get('scope')).toBe('user.info.basic,video.publish');
  });

  it('đổi code ⇒ tài khoản theo open_id; thiếu video.publish ⇒ lỗi', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(200, { access_token: 'a', refresh_token: 'r', expires_in: 86400, open_id: 'open1', scope: 'user.info.basic,video.publish' }))
      .mockResolvedValueOnce(okData({ user: { open_id: 'open1', display_name: 'Tài khoản thử', avatar_url: 'https://p/1.jpg' } }));
    const out = await tt.exchange('code', 'https://crm.example.com/cb');
    expect(String(f.mock.calls[0][1]?.body)).toContain('client_secret=tt-secret');
    expect(out[0]).toMatchObject({ external_id: 'open1', name: 'Tài khoản thử', refresh_token: 'r' });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { access_token: 'a', scope: 'user.info.basic' }));
    await expect(tt.exchange('c', 'u')).rejects.toMatchObject({ kind: 'permission' });
  });

  it('đăng: creator_info → init (SELF_ONLY, FILE_UPLOAD) → PUT có Content-Range → trạng thái', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(okData({ privacy_level_options: ['SELF_ONLY'], comment_disabled: false }))
      .mockResolvedValueOnce(okData({ publish_id: 'pub1', upload_url: 'https://open-upload.tiktokapis.com/upload/?x=1' }))
      .mockResolvedValueOnce(res(201, {}))
      .mockResolvedValueOnce(okData({ status: 'PROCESSING_UPLOAD' }))
      .mockResolvedValueOnce(okData({ status: 'PUBLISH_COMPLETE' }));
    const out = await run(tt.publish(acc, { text: 'Video thử', media: [video], options: { privacy_level: 'SELF_ONLY' }, load: loadOf(5), publicUrl: () => "" }));
    expect(out).toEqual({ external_post_id: 'pub1', url: null });
    const init = JSON.parse(String(f.mock.calls[1][1]?.body));
    expect(init.post_info).toEqual({
      title: 'Video thử', privacy_level: 'SELF_ONLY', disable_comment: true, disable_duet: true, disable_stitch: true, brand_content_toggle: false, brand_organic_toggle: false,
    });
    expect(init.source_info).toEqual({ source: 'FILE_UPLOAD', video_size: 5, chunk_size: 5, total_chunk_count: 1 });
    const put = f.mock.calls[2][1]!;
    expect(put.method).toBe('PUT');
    expect((put.headers as Record<string, string>)['Content-Range']).toBe('bytes 0-4/5');
    expect((f.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer tt-token');
  });

  it('có mã bài công khai ⇒ trả link video', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(okData({ privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'] }))
      .mockResolvedValueOnce(okData({ publish_id: 'pub2', upload_url: 'https://u' }))
      .mockResolvedValueOnce(res(201, {}))
      .mockResolvedValueOnce(okData({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7300000000000000001] }));
    const out = await run(tt.publish(acc, { text: 'x', media: [video], options: { privacy_level: 'PUBLIC_TO_EVERYONE' }, load: loadOf(5), publicUrl: () => "" }));
    expect(out.url).toBe(`https://www.tiktok.com/video/${String(7300000000000000001)}`);
  });

  it('quyền xem không nằm trong creator_info ⇒ lỗi trước khi tải video', async () => {
    const f = jest.spyOn(global, 'fetch').mockResolvedValueOnce(okData({ privacy_level_options: ['SELF_ONLY'] }));
    await expect(tt.publish(acc, { text: 'x', media: [video], options: { privacy_level: 'PUBLIC_TO_EVERYONE' }, load: loadOf(5), publicUrl: () => "" })).rejects.toMatchObject({ kind: 'invalid' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('TikTok báo FAILED ⇒ lỗi kèm lý do', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(okData({ privacy_level_options: ['SELF_ONLY'] }))
      .mockResolvedValueOnce(okData({ publish_id: 'pub3', upload_url: 'https://u' }))
      .mockResolvedValueOnce(res(201, {}))
      .mockResolvedValueOnce(okData({ status: 'FAILED', fail_reason: 'file_format_check_failed' }));
    await expect(run(tt.publish(acc, { text: 'x', media: [video], options: { privacy_level: 'SELF_ONLY' }, load: loadOf(5), publicUrl: () => "" }))).rejects.toThrow(/file_format_check_failed/);
  });

  it('video lớn chia nhiều khúc đúng Content-Range', async () => {
    const size = 70 * MB;
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(okData({ privacy_level_options: ['SELF_ONLY'] }))
      .mockResolvedValueOnce(okData({ publish_id: 'pub4', upload_url: 'https://u' }))
      .mockResolvedValue(res(206, {}));
    // Sau 7 khúc, các lần hỏi trạng thái nhận 206 rỗng ⇒ chưa xong, hết giờ chờ ⇒ trả publish_id.
    const out = await run(tt.publish(acc, { text: 'x', media: [{ ...video, size }], options: { privacy_level: 'SELF_ONLY' }, load: loadOf(size), publicUrl: () => "" }));
    expect(out.external_post_id).toBe('pub4');
    const ranges = f.mock.calls.slice(2, 9).map((c) => (c[1]?.headers as Record<string, string>)['Content-Range']);
    expect(ranges[0]).toBe(`bytes 0-${10 * MB - 1}/${size}`);
    expect(ranges[6]).toBe(`bytes ${60 * MB}-${size - 1}/${size}`);
  });

  it('bật tương tác theo người đăng nhưng tài khoản tắt thì vẫn tắt; công bố thương mại gửi đúng cờ', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(okData({ privacy_level_options: ['PUBLIC_TO_EVERYONE'], comment_disabled: false, duet_disabled: true, stitch_disabled: false }))
      .mockResolvedValueOnce(okData({ publish_id: 'pub5', upload_url: 'https://u' }))
      .mockResolvedValueOnce(res(201, {}))
      .mockResolvedValueOnce(okData({ status: 'PUBLISH_COMPLETE' }));
    const options = { privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: true, allow_duet: true, allow_stitch: true, brand_organic: true, brand_content: true };
    await run(tt.publish(acc, { text: 'x', media: [video], options, load: loadOf(5), publicUrl: () => '' }));
    expect(JSON.parse(String(f.mock.calls[1][1]?.body)).post_info).toMatchObject({
      disable_comment: false, disable_duet: true, disable_stitch: false, brand_content_toggle: true, brand_organic_toggle: true,
    });
  });

  it('bài hẹn giờ cũ không có quyền xem vẫn đăng Chỉ mình tôi như lúc được nhận', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(okData({ privacy_level_options: ['SELF_ONLY'] }))
      .mockResolvedValueOnce(okData({ publish_id: 'pub6', upload_url: 'https://u' }))
      .mockResolvedValueOnce(res(201, {}))
      .mockResolvedValueOnce(okData({ status: 'PUBLISH_COMPLETE' }));
    await run(tt.publish(acc, { text: 'x', media: [video], options: {}, load: loadOf(5), publicUrl: () => '' }));
    expect(JSON.parse(String(f.mock.calls[1][1]?.body)).post_info.privacy_level).toBe('SELF_ONLY');
  });

  it('video dài hơn giới hạn tài khoản ⇒ lỗi trước khi tải', async () => {
    const load = jest.fn(loadOf(5));
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(okData({ privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 60 }));
    await expect(tt.publish(acc, { text: 'x', media: [video], options: { privacy_level: 'SELF_ONLY', video_duration_sec: 61 }, load, publicUrl: () => '' })).rejects.toThrow(/tối đa 60 giây/);
    expect(load).not.toHaveBeenCalled();
  });

  it('creator_info cho màn soạn', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      okData({ creator_nickname: 'Tiệm bánh', creator_username: 'tiembanh', creator_avatar_url: 'https://p/a.jpg', privacy_level_options: ['SELF_ONLY'], stitch_disabled: true, max_video_post_duration_sec: 600 }),
    );
    expect(await tt.creatorInfo(acc)).toEqual({
      nickname: 'Tiệm bánh', username: 'tiembanh', avatar_url: 'https://p/a.jpg', privacy_level_options: ['SELF_ONLY'],
      comment_disabled: false, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 600,
    });
  });

  it('không có API gỡ bài', () => {
    expect((tt as { deletePost?: unknown }).deletePost).toBeUndefined();
  });
});
