import { SocialPostGoneError, type AccountForPublish, type SocialMedia } from '../providers/provider.types';
import { GoogleBusinessSocialProvider, gbpLocationPath, googleBusinessEnabled, mapReview } from '../providers/google-business.provider';

const ENV = { ...process.env };
beforeEach(() => {
  process.env.GOOGLE_SOCIAL_CLIENT_ID = 'gid';
  process.env.GOOGLE_SOCIAL_CLIENT_SECRET = 'g-secret';
  process.env.GOOGLE_BUSINESS_ENABLED = 'true';
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const acc: AccountForPublish = { id: 4, external_id: '111/222', name: 'Tiệm Bánh Thu', access_token: 'g-token', refresh_token: 'g-r', token_expires_at: null };
const img: SocialMedia = { key: 'social/a.jpg', type: 'image', content_type: 'image/jpeg', size: 10 };

describe('Google Business Profile', () => {
  const gb = new GoogleBusinessSocialProvider();

  it('chỉ bật khi GOOGLE_BUSINESS_ENABLED=true (Google chưa duyệt ⇒ quota 0)', () => {
    expect(gb.configured()).toBe(true);
    process.env.GOOGLE_BUSINESS_ENABLED = '';
    expect(googleBusinessEnabled()).toBe(false);
    expect(gb.configured()).toBe(false);
  });

  it('mã địa điểm "<account>/<location>" ⇒ đường dẫn v4; mã lạ bị chặn', () => {
    expect(gbpLocationPath('111/222')).toBe('accounts/111/locations/222');
    expect(() => gbpLocationPath('../x')).toThrow();
  });

  it('bài cập nhật: chữ + tối đa 1 ảnh JPG/PNG, không video', () => {
    expect(gb.validateMedia([])).toBeNull();
    expect(gb.validateMedia([img])).toBeNull();
    expect(gb.validateMedia([img, img])).toMatch(/1 ảnh/);
    expect(gb.validateMedia([{ ...img, type: 'video', content_type: 'video/mp4' }])).toMatch(/video/);
    expect(gb.validateMedia([{ ...img, content_type: 'image/webp' }])).toMatch(/JPG/);
    expect(gb.validateOptions('  ')).toMatch(/nội dung/);
  });

  it('URL đăng nhập: app Google chung, scope business.manage, xin refresh token', () => {
    const u = new URL(gb.authorizeUrl('st', 'https://crm.example.com/api/v1/social/oauth/callback/google_business'));
    expect(u.searchParams.get('client_id')).toBe('gid');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/business.manage');
    expect(u.searchParams.get('access_type')).toBe('offline');
  });

  it('đổi code ⇒ mỗi địa điểm của mọi tài khoản là một kênh', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage' }))
      .mockResolvedValueOnce(res(200, { accounts: [{ name: 'accounts/111' }] }))
      .mockResolvedValueOnce(res(200, { locations: [{ name: 'locations/222', title: 'Tiệm Bánh Thu' }], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(res(200, { locations: [{ name: 'locations/333', title: 'Tiệm Bánh Thu 2' }] }));
    const out = await gb.exchange('code', 'https://crm.example.com/cb');
    expect(out.map((a) => [a.external_id, a.name])).toEqual([['111/222', 'Tiệm Bánh Thu'], ['111/333', 'Tiệm Bánh Thu 2']]);
    expect(String(f.mock.calls[2][0])).toContain('/accounts/111/locations?readMask=name,title');
    expect(String(f.mock.calls[3][0])).toContain('pageToken=p2');
  });

  it('thiếu scope business.manage ⇒ lỗi quyền', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { access_token: 'a', refresh_token: 'r', scope: 'openid' }));
    await expect(gb.exchange('c', 'u')).rejects.toMatchObject({ kind: 'permission' });
  });

  it('đăng bài cập nhật: STANDARD, ảnh qua link công khai, trả mã bài + link tìm kiếm', async () => {
    const f = jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { name: 'accounts/111/locations/222/localPosts/999', searchUrl: 'https://local.google.com/p/999', state: 'LIVE' }));
    const out = await gb.publish(acc, { text: 'Khai trương món mới', media: [img], options: {}, load: jest.fn(), publicUrl: () => 'https://crm.example.com/m/a.jpg?sig=x' });
    expect(out).toEqual({ external_post_id: '999', url: 'https://local.google.com/p/999' });
    expect(String(f.mock.calls[0][0])).toBe('https://mybusiness.googleapis.com/v4/accounts/111/locations/222/localPosts');
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({
      languageCode: 'vi', summary: 'Khai trương món mới', topicType: 'STANDARD', media: [{ mediaFormat: 'PHOTO', sourceUrl: 'https://crm.example.com/m/a.jpg?sig=x' }],
    });
    expect((f.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer g-token');
  });

  it('Google từ chối bài / chưa có hạn mức API ⇒ lỗi rõ', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { name: 'accounts/111/locations/222/localPosts/1', state: 'REJECTED' }));
    await expect(gb.publish(acc, { text: 'x', media: [], options: {}, load: jest.fn(), publicUrl: () => '' })).rejects.toMatchObject({ kind: 'invalid' });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(429, { error: { code: 429, message: "Quota exceeded for quota metric 'Requests' ... per minute", status: 'RESOURCE_EXHAUSTED' } }));
    await expect(gb.publish(acc, { text: 'x', media: [], options: {}, load: jest.fn(), publicUrl: () => '' })).rejects.toThrow(/hạn mức/);
  });

  it('đánh giá: đọc trang, đổi sao chữ ⇒ số, ẩn danh ⇒ "Người dùng Google"; trả lời qua PUT …/reply', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        res(200, {
          reviews: [
            { name: 'accounts/111/locations/222/reviews/r1', reviewId: 'r1', reviewer: { displayName: 'Lan' }, starRating: 'FIVE', comment: 'Cà phê ngon', createTime: '2026-10-01T00:00:00Z' },
            { name: 'accounts/111/locations/222/reviews/r2', reviewer: { isAnonymous: true }, starRating: 'TWO', reviewReply: { comment: 'Xin lỗi anh', updateTime: '2026-10-02T00:00:00Z' } },
          ],
          averageRating: 4.6,
          totalReviewCount: 120,
          nextPageToken: 'n2',
        }),
      )
      .mockResolvedValueOnce(res(200, { comment: 'Cảm ơn chị Lan!', updateTime: '2026-10-15T00:00:00Z' }));
    const page = await gb.listReviews(acc);
    expect(String(f.mock.calls[0][0])).toContain('/v4/accounts/111/locations/222/reviews?pageSize=50&orderBy=updateTime+desc');
    expect(page).toMatchObject({ average: 4.6, total: 120, next_page_token: 'n2' });
    expect(page.reviews.map((r) => [r.id, r.reviewer, r.stars, r.reply?.comment ?? null])).toEqual([
      ['r1', 'Lan', 5, null],
      ['r2', 'Người dùng Google', 2, 'Xin lỗi anh'],
    ]);
    const r = await gb.replyReview(acc, 'r1', ' Cảm ơn chị Lan! ');
    expect(r).toEqual({ comment: 'Cảm ơn chị Lan!', updated_at: '2026-10-15T00:00:00Z' });
    expect(f.mock.calls[1][1]?.method).toBe('PUT');
    expect(String(f.mock.calls[1][0])).toBe('https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews/r1/reply');
  });

  it('trả lời: mã đánh giá lạ / rỗng / quá 4.096 byte ⇒ chặn trước khi gọi Google', async () => {
    const f = jest.spyOn(global, 'fetch');
    await expect(gb.replyReview(acc, '../x', 'hi')).rejects.toThrow(/không hợp lệ/);
    await expect(gb.replyReview(acc, 'r1', '  ')).rejects.toThrow(/trống/);
    await expect(gb.replyReview(acc, 'r1', 'ă'.repeat(2100))).rejects.toThrow(/4.096/);
    expect(f).not.toHaveBeenCalled();
  });

  it('mapReview chịu được dữ liệu thiếu', () => {
    expect(mapReview({})).toMatchObject({ id: '', reviewer: 'Người dùng Google', stars: null, reply: null });
  });

  it('bài PROCESSING: hỏi lại chính bài đó tới khi LIVE (không tạo lại); vẫn chưa xong ⇒ không có link, đối chiếu sau', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const f = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(res(200, { name: 'accounts/111/locations/222/localPosts/7', state: 'PROCESSING' }))
        .mockResolvedValueOnce(res(200, { state: 'PROCESSING' }))
        .mockResolvedValueOnce(res(200, { state: 'LIVE', searchUrl: 'https://local.google.com/p/7' }));
      const p = gb.publish(acc, { text: 'x', media: [], options: {}, load: jest.fn(), publicUrl: () => '' });
      await jest.advanceTimersByTimeAsync(7_000);
      expect(await p).toEqual({ external_post_id: '7', url: 'https://local.google.com/p/7' });
      expect(f.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1);
      expect(String(f.mock.calls[1][0])).toBe('https://mybusiness.googleapis.com/v4/accounts/111/locations/222/localPosts/7');

      jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { name: 'accounts/111/locations/222/localPosts/8', state: 'PROCESSING' })).mockResolvedValue(res(200, { state: 'PROCESSING' }));
      const q = gb.publish(acc, { text: 'x', media: [], options: {}, load: jest.fn(), publicUrl: () => '' });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(await q).toEqual({ external_post_id: '8', url: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it('lượt lấy số đối chiếu trạng thái: REJECTED / 404 ⇒ đánh dấu không còn trên kênh; LIVE ⇒ số để trống', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { state: 'LIVE' }));
    await expect(gb.fetchMetrics(acc, '7')).resolves.toEqual({ views: null, reactions: null, comments: null, shares: null });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { state: 'REJECTED' }));
    await expect(gb.fetchMetrics(acc, '7')).rejects.toBeInstanceOf(SocialPostGoneError);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }));
    await expect(gb.fetchMetrics(acc, '7')).rejects.toBeInstanceOf(SocialPostGoneError);
  });

  it('gỡ bài: DELETE đúng đường dẫn', async () => {
    const f = jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, {}));
    await gb.deletePost(acc, '999');
    expect(f.mock.calls[0][1]?.method).toBe('DELETE');
    expect(String(f.mock.calls[0][0])).toBe('https://mybusiness.googleapis.com/v4/accounts/111/locations/222/localPosts/999');
  });
});
