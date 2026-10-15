import type { Z } from '../tools/tool-types';
import { tiktokPrivacy } from '../../../social/providers/tiktok.provider';
import { YOUTUBE_CATEGORIES, youtubePrivacy, youtubeTitle, type YoutubeCategory } from '../../../social/providers/youtube.provider';
import { optInt } from '../tools/tool-types';
import { vnIso } from '../tools/ai-activity-tool';
import { ActionUserError, type ActionDeps, type ActionToolDef, type DetailLine } from './action-types';
import { line, lines, shown } from './action-helpers';
import { isUserConfirmation } from './user-confirmation';
import { rowsFromStructured } from '../../../social/social-import.service';

async function social(deps: ActionDeps) {
  if (!deps.social) throw new ActionUserError('Máy chủ này chưa có tính năng đăng đa kênh. / Social posting is not available on this server.');
  if (!(await deps.orgFeatures.isEnabled('social_posting'))) throw new ActionUserError('Tính năng "Đăng đa kênh" đang tắt (Cài đặt › Tính năng). / Social posting is turned off.');
  return deps.social;
}

const postConfirmParam = (z: Z) =>
  z
    .string({ error: () => 'Thiếu confirmed_by_user: chưa đăng gì. / Missing confirmed_by_user.' })
    .max(300)
    .describe(
      'Lời người dùng đồng ý đăng, chép nguyên văn (vd "ok đăng đi", "được, đăng vậy"), thường là câu trả lời sau khi họ xem nội dung và danh sách kênh. ' +
        'Nếu chính lời yêu cầu đã nói rõ đăng luôn không cần hỏi lại (vd "đăng luôn", "khỏi hỏi lại") thì câu đó là lời đồng ý. Lời yêu cầu thường (vd "soạn bài cho fanpage…") chưa phải: khi đó máy chủ không đăng gì và trả lại bản xem trước. / ' +
        "The user's own words approving the post after seeing the text and channels, copied verbatim; a request that already says to post right away counts. Otherwise nothing is posted and a preview is returned.",
    );

/** `use_queue`: chọn luôn khung trống gần nhất để bản xem trước và tham số đã lưu có đúng giờ đó (duyệt xong đăng đúng giờ đã xem). */
async function queueTime(s: NonNullable<ActionDeps['social']>, args: Record<string, unknown>): Promise<string | null> {
  if (args.use_queue !== true) return null;
  if (typeof args.scheduled_at === 'string' && args.scheduled_at.trim()) throw new ActionUserError('Chỉ chọn một trong use_queue hoặc scheduled_at. / Use either use_queue or scheduled_at, not both.');
  const [slot] = await s.queue.nextFree(1);
  if (!slot) throw new ActionUserError('Chưa đặt khung giờ hàng đợi (Đăng đa kênh › Lịch › Khung giờ), hoặc các khung trong 90 ngày tới đã kín. / No free queue slot; set weekly slots first.');
  return slot.toISOString();
}

/**
 * Lúc chạy đề xuất đã duyệt: khung hàng đợi chốt lúc xem trước có thể đã qua (duyệt chậm) hoặc đã có bài khác chiếm ⇒
 * dời sang khung trống kế tiếp và báo lại (moved_from), thay vì hỏng hoặc đăng trùng khung.
 */
async function recheckQueued(s: NonNullable<ActionDeps['social']>, at: string | null | undefined): Promise<{ at: string; moved_from?: string }> {
  if (at && (await s.queue.isFree(new Date(at)))) return { at };
  const [slot] = await s.queue.nextFree(1);
  if (!slot) throw new ActionUserError('Khung hàng đợi đã chọn không còn trống và hàng đợi đã kín (hoặc chưa đặt khung). / No free queue slot left.');
  return { at: slot.toISOString(), ...(at ? { moved_from: vnWhen(new Date(at)) } : {}) };
}

const useQueueParam = (z: Z) =>
  z.boolean().optional().describe('true = đặt bài vào khung trống gần nhất của hàng đợi thay cho scheduled_at (khung giờ hằng tuần đã đặt trong Trinity, xem list_queue_slots); không dùng cùng scheduled_at / true = put the post in the nearest free queue slot instead of scheduled_at');

/** Giờ hẹn từ AI: thiếu múi giờ thì hiểu là giờ Việt Nam. Bỏ trống/null = đăng ngay. */
export function parseScheduledAt(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const v = raw.trim().replace(' ', 'T');
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v) ? `${v}+07:00` : v;
  if (Number.isNaN(Date.parse(withZone))) throw new ActionUserError(`scheduled_at "${raw.slice(0, 40)}" không đúng dạng — dùng YYYY-MM-DDTHH:mm theo giờ Việt Nam, vd 2026-10-20T09:00. / Invalid scheduled_at; use YYYY-MM-DDTHH:mm in Vietnam time.`);
  return new Date(withZone).toISOString();
}

export const VN_WEEKDAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

/** "09:00 Thứ Ba 20/10/2026 (giờ Việt Nam)" — kèm thứ để AI khỏi tự đoán thứ (Haiku từng gọi Chủ nhật là thứ Bảy). */
export function vnWhen(d: Date): string {
  const vn = new Date(d.getTime() + 7 * 3_600_000);
  const v = vn.toISOString();
  return `${v.slice(11, 16)} ${VN_WEEKDAYS[vn.getUTCDay()]} ${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)} (giờ Việt Nam)`;
}

export function assertPostConfirmed(words: unknown, preview: DetailLine[]): void {
  if (isUserConfirmation(words)) return;
  const said = typeof words === 'string' && words.trim() ? `“${words.trim().slice(0, 80)}”` : '(trống)';
  const plan = preview.map((d) => `${d.label}: ${d.value}`).join(' | ');
  throw new ActionUserError(
    `Chưa đăng gì: chưa có lời người dùng đồng ý với bài này (confirmed_by_user = ${said}). Bài dự kiến — ${plan}. ` +
      'Bài lên mạng xã hội là công khai: người dùng xem nội dung, kênh và giờ đăng ở trên, sửa nếu cần, rồi đồng ý; confirmed_by_user là câu đồng ý đó. / ' +
      `Nothing posted: no user approval of this post (confirmed_by_user = ${said}). Planned post: ${plan}`,
  );
}

const YT_CATEGORIES = Object.keys(YOUTUBE_CATEGORIES) as [YoutubeCategory, ...YoutubeCategory[]];

/** Nội dung riêng + tuỳ chọn từng kênh — dùng chung cho tạo bài và sửa bài hẹn giờ. */
export const captionsParam = (z: Z) =>
  z
    .array(
      z.object({
        account_id: z.number().int().min(1).max(2_147_483_647),
        caption: z.string().max(63_206).optional(),
        youtube_title: z.string().max(100).optional(),
        youtube_privacy: z.enum(['private', 'unlisted', 'public']).optional(),
        youtube_description: z.string().max(5000).optional().describe('Mô tả video (bỏ trống = nội dung bài) / Video description'),
        youtube_tags: z.array(z.string().max(100)).max(30).optional().describe('Thẻ video / Video tags'),
        youtube_category: z.enum(YT_CATEGORIES).optional().describe(`Danh mục YouTube: ${YT_CATEGORIES.map((k) => `${k}=${YOUTUBE_CATEGORIES[k]}`).join(', ')}; mặc định 22 / YouTube category id`),
        youtube_made_for_kids: z.boolean().optional().describe('Video dành cho trẻ em (mặc định false) / Made for kids'),
        youtube_thumbnail_media_key: z.string().max(200).optional().describe('media_key ảnh JPG/PNG ≤ 2 MB trong thư viện làm thumbnail / Thumbnail image media key'),
        youtube_playlist_id: z.string().max(64).optional().describe('id playlist từ list_youtube_playlists / Playlist id'),
        facebook_first_comment: z.string().max(8000).optional().describe('Bình luận đầu tiên Fanpage tự đăng dưới bài (vd link, hashtag) / First comment on the Facebook post'),
      }),
    )
    .max(20)
    .optional()
    .describe('Nội dung riêng và tuỳ chọn từng kênh: YouTube (tiêu đề, quyền xem, mô tả, thẻ, danh mục, trẻ em, thumbnail, playlist), Facebook (bình luận đầu tiên) / Per-account caption and options');

/** Một phần tử `captions` → tuỳ chọn gửi BE (chỉ những gì AI đã đặt). */
export function optionsFromCaption(c: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  if (str(c.youtube_title)) o.title = str(c.youtube_title);
  if (typeof c.youtube_privacy === 'string') o.privacy = c.youtube_privacy;
  if (str(c.youtube_description)) o.description = str(c.youtube_description);
  if (Array.isArray(c.youtube_tags)) o.tags = (c.youtube_tags as unknown[]).filter((t): t is string => typeof t === 'string');
  if (typeof c.youtube_category === 'string') o.category_id = c.youtube_category;
  if (typeof c.youtube_made_for_kids === 'boolean') o.made_for_kids = c.youtube_made_for_kids;
  if (str(c.youtube_thumbnail_media_key)) o.thumbnail_key = str(c.youtube_thumbnail_media_key);
  if (str(c.youtube_playlist_id)) o.playlist_id = str(c.youtube_playlist_id);
  if (str(c.facebook_first_comment)) o.first_comment = str(c.facebook_first_comment);
  return o;
}

/** Trường chuỗi gửi rỗng ("") khi sửa bài = bỏ tuỳ chọn đã lưu (playlist, thumbnail, mô tả riêng, bình luận đầu tiên, tiêu đề). */
const CLEARABLE: Record<string, string> = {
  youtube_title: 'title',
  youtube_description: 'description',
  youtube_thumbnail_media_key: 'thumbnail_key',
  youtube_playlist_id: 'playlist_id',
  facebook_first_comment: 'first_comment',
};

export function mergeOptions(stored: Record<string, unknown>, c: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!c) return stored;
  const o = { ...stored, ...optionsFromCaption(c) };
  for (const [k, opt] of Object.entries(CLEARABLE)) if (typeof c[k] === 'string' && !(c[k] as string).trim()) delete o[opt];
  return o;
}

/** Tuỳ chọn đã lưu → gửi lại khi sửa (thumbnail chuyển về thumbnail_key để BE kiểm lại). */
function storedOptions(options: unknown): Record<string, unknown> {
  const { thumbnail, ...rest } = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>;
  const key = thumbnail && typeof thumbnail === 'object' ? (thumbnail as { key?: unknown }).key : undefined;
  return typeof key === 'string' ? { ...rest, thumbnail_key: key } : rest;
}

/** utm_campaign / utm_content dùng chung cho tạo bài, sửa bài hẹn giờ và lưu nháp. */
export const utmParams = (z: Z) => ({
  utm_campaign: z
    .string()
    .max(100)
    .optional()
    .describe('Gắn UTM vào các liên kết trong bài để đo lượt truy cập từ bài này: tên chiến dịch (utm_campaign); utm_source là tên mạng, utm_medium=social; liên kết đã có utm_ giữ nguyên. Khi sửa: "" = bỏ UTM. / Tag links in the post with UTM to measure traffic from it: campaign name; utm_source is the network, utm_medium=social; links that already have utm_ are left alone. When editing, "" removes UTM'),
  utm_content: z.string().max(100).optional().describe('utm_content (tuỳ chọn, cần utm_campaign) để phân biệt biến thể bài / Optional utm_content, needs utm_campaign'),
});

/** undefined = không nhắc tới (giữ như cũ); null = bỏ UTM; ngược lại cấu hình mới. */
export function utmFromArgs(args: Record<string, unknown>): { campaign: string; content?: string } | null | undefined {
  const camp = typeof args.utm_campaign === 'string' ? args.utm_campaign.trim() : undefined;
  const content = typeof args.utm_content === 'string' && args.utm_content.trim() ? args.utm_content.trim() : undefined;
  if (camp === undefined) {
    if (content) throw new ActionUserError('utm_content cần đi kèm utm_campaign.');
    return undefined;
  }
  if (!camp) return null;
  return content ? { campaign: camp, content } : { campaign: camp };
}

type Validated = Awaited<ReturnType<NonNullable<ActionDeps['social']>['posts']['validate']>>;

/** Bản xem trước bài cho người dùng duyệt (dùng chung tạo / sửa). */
export function postDetails(v: Validated): DetailLine[] {
  return lines(
    line('Kênh', v.targets.map((t) => `${t.account.name} (${t.account.network})`).join(', ')),
    line('Giờ đăng', v.scheduledAt ? `Hẹn lúc ${vnWhen(v.scheduledAt)}` : 'Đăng ngay'),
    line('Nội dung', v.content, 2000),
    ...v.targets.filter((t) => t.caption).map((t) => line(`Nội dung riêng — ${t.account.name}`, t.caption, 1000)),
    ...v.targets
      .filter((t) => t.account.network === 'youtube')
      .map((t) => {
        const o = t.options;
        const extra = [
          Array.isArray(o.tags) && o.tags.length ? `thẻ: ${(o.tags as string[]).join(', ')}` : null,
          typeof o.category_id === 'string' ? `danh mục ${YOUTUBE_CATEGORIES[o.category_id as YoutubeCategory] ?? o.category_id}` : null,
          o.made_for_kids === true ? 'dành cho trẻ em' : null,
          o.thumbnail ? 'có ảnh thumbnail' : null,
          typeof o.playlist_id === 'string' ? `thêm vào playlist ${o.playlist_id}` : null,
        ].filter(Boolean);
        return line(`YouTube — ${t.account.name}`, `tiêu đề "${youtubeTitle(t.caption ?? v.content, o)}", quyền xem ${youtubePrivacy(o)}${extra.length ? `, ${extra.join(', ')}` : ''}`);
      }),
    ...v.targets
      .filter((t) => t.account.network === 'youtube' && typeof t.options.description === 'string')
      .map((t) => line(`Mô tả YouTube — ${t.account.name}`, t.options.description as string, 2000)),
    ...v.targets.filter((t) => t.account.network === 'facebook' && typeof t.options.first_comment === 'string').map((t) => line(`Bình luận đầu tiên — ${t.account.name}`, t.options.first_comment as string, 500)),
    ...(() => {
      const u = v.targets.map((t) => t.options.utm as { campaign?: string; content?: string } | undefined).find((x) => x?.campaign);
      return u ? [line('UTM', `campaign=${u.campaign}${u.content ? `, content=${u.content}` : ''} (utm_source = tên mạng từng kênh, utm_medium=social; gắn vào các liên kết khi đăng)`)] : [];
    })(),
    ...v.targets.filter((t) => t.account.network === 'tiktok').map((t) => line(`TikTok — ${t.account.name}`, `quyền xem ${tiktokPrivacy(t.options) ?? 'chưa chọn (TikTok chỉ đăng được từ màn Soạn bài trong Trinity)'}`)),
    line('Tệp đính kèm', v.media.length ? v.media.map((m) => m.type).join(', ') : null),
  );
}

export const createSocialPostAction: ActionToolDef = {
  name: 'create_social_post',
  label: 'Đăng bài mạng xã hội',
  title: 'Đăng bài mạng xã hội / Create social post',
  description:
    'Đăng bài lên Fanpage Facebook và kênh YouTube của công ty qua Trinity (tính năng Đăng đa kênh): đăng ngay, hoặc hẹn giờ đăng (scheduled_at), một bài ra một hoặc nhiều kênh đã liên kết (account_ids từ list_social_accounts). ' +
    'Người dùng nói một giờ cụ thể ("9 giờ sáng mai", "20/10 lúc 19h") thì đặt scheduled_at theo giờ Việt Nam; không nói giờ thì đăng ngay. Bài hẹn hiện ở trạng thái scheduled, huỷ được ở màn Đăng đa kênh của Trinity trước giờ đăng. use_queue = true đặt bài vào khung trống gần nhất của hàng đợi thay cho scheduled_at (khung giờ xem ở list_queue_slots; bản xem trước nêu đúng giờ đó). ' +
    'account_ids là đúng các kênh người dùng đã nêu; Trinity không có kênh mặc định hay kênh "hay dùng" — khi người dùng chưa nêu kênh, họ là người chọn. ' +
    'captions đặt nội dung riêng cho từng kênh và tuỳ chọn: YouTube (youtube_title, youtube_privacy mặc định private, youtube_description, youtube_tags, youtube_category, youtube_made_for_kids, youtube_thumbnail_media_key, youtube_playlist_id từ list_youtube_playlists), Facebook (facebook_first_comment); utm_campaign (+ utm_content) gắn UTM vào các liên kết trong bài, mô tả YouTube và bình luận đầu để đo lượt truy cập từ bài này (utm_source là tên mạng, utm_medium=social; liên kết đã có utm_ giữ nguyên); YouTube cần đúng một video; media_keys là media_key của ảnh/video trong thư viện (list_social_media; ảnh/video bạn tạo thì đưa vào bằng upload_social_media trước). ' +
    'Bài đăng công khai trên kênh của công ty nên cần confirmed_by_user — lời người dùng đồng ý sau khi xem nội dung và kênh. Bài đăng chạy nền; trạng thái từng kênh xem bằng get_social_post. / ' +
    'Posts to the company\'s Facebook Pages and YouTube channels through Trinity (multi-channel posting): publishes a post now to one or more linked social accounts. account_ids are exactly the channels the user named; there is no default channel. Per-channel captions and YouTube title/privacy (default private); utm_campaign/utm_content tag the links in the post (and YouTube description / Facebook first comment) with UTM to measure traffic from this post (utm_source = the network, utm_medium=social); YouTube needs exactly one video; media_keys are media_key values from the library (list_social_media; upload your own with upload_social_media first). Requires confirmed_by_user. Publishing runs in the background — check with get_social_post. Set scheduled_at (Vietnam time, up to 90 days ahead) to schedule instead of posting now, or use_queue to take the nearest free weekly queue slot instead.',
  permissions: ['social.post'],
  destructive: false,
  idempotent: false,
  input: (z) => ({
    content: z.string().max(63_206).optional().describe('Nội dung chung của bài (video YouTube có thể bỏ trống) / Post text, optional for a video-only post'),
    account_ids: z.array(z.number().int().min(1).max(2_147_483_647)).min(1).max(20).describe('id các kênh người dùng đã nêu, từ list_social_accounts; không có kênh mặc định / Account ids the user named; no default'),
    captions: captionsParam(z),
    media_keys: z.array(z.string().max(200)).max(10).optional().describe('media_key trong thư viện (list_social_media / upload_social_media) / Library media keys'),
    scheduled_at: z
      .string()
      .max(40)
      .optional()
      .describe('Giờ hẹn đăng theo giờ Việt Nam, dạng YYYY-MM-DDTHH:mm (vd 2026-10-20T09:00), trong vòng 90 ngày tới. Bỏ trống = đăng ngay. / Scheduled time in Vietnam time (YYYY-MM-DDTHH:mm), up to 90 days ahead; omit to post now'),
    use_queue: useQueueParam(z),
    ...utmParams(z),
    confirmed_by_user: postConfirmParam(z),
  }),
  async prepare(args, { deps, user }) {
    const s = await social(deps);
    const queued = await queueTime(s, args);
    const ids = Array.isArray(args.account_ids) ? (args.account_ids as unknown[]).map(optInt).filter((x): x is number => x !== undefined) : [];
    const caps = new Map<number, string>();
    const opts = new Map<number, Record<string, unknown>>();
    for (const c of Array.isArray(args.captions) ? (args.captions as Array<Record<string, unknown>>) : []) {
      const id = optInt(c.account_id);
      if (!id) continue;
      if (!ids.includes(id)) throw new ActionUserError(`captions có account_id ${id} không nằm trong account_ids.`);
      if (typeof c.caption === 'string' && c.caption.trim()) caps.set(id, c.caption.trim());
      const o = optionsFromCaption(c);
      if (Object.keys(o).length) opts.set(id, o);
    }
    const params = {
      content: typeof args.content === 'string' ? args.content : '',
      media_keys: Array.isArray(args.media_keys) ? (args.media_keys as unknown[]).filter((k): k is string => typeof k === 'string') : [],
      targets: ids.map((account_id) => ({ account_id, caption: caps.get(account_id) ?? null, options: opts.get(account_id) ?? {} })),
      scheduled_at: queued ?? parseScheduledAt(args.scheduled_at),
      utm: utmFromArgs(args),
    };
    const v = await s.posts.validate(user, params);
    const details = postDetails(v);
    assertPostConfirmed(args.confirmed_by_user, details);
    const when = v.scheduledAt ? `Hẹn đăng lúc ${vnWhen(v.scheduledAt)}` : 'Đăng ngay';
    return { params: { ...params, scheduled_at: v.scheduledAt ? v.scheduledAt.toISOString() : null, ...(queued ? { queued: true } : {}) }, summary: shown(`${when} bài lên ${v.targets.length} kênh`), details };
  },
  async execute(params, { deps, user }) {
    const s = await social(deps);
    const { queued, ...input } = params as Record<string, unknown>;
    const slot = queued ? await recheckQueued(s, input.scheduled_at as string | null) : null;
    const p = await s.posts.create(user, { ...(input as never as Parameters<typeof s.posts.create>[1]), ...(slot ? { scheduled_at: slot.at } : {}), source: 'mcp' });
    return {
      ...(slot?.moved_from ? { moved_from: slot.moved_from, note: 'Khung đã chọn lúc xem trước không còn trống nên bài vào khung trống kế tiếp.' } : {}),
      post_id: p.id,
      status: p.status,
      scheduled_at: p.scheduled_at ? vnWhen(p.scheduled_at) : null,
      targets: p.targets.map((t) => ({ target_id: t.id, account: t.account_name, status: t.status })),
    };
  },
};

type PostPatch = { content?: string; account_ids?: number[]; captions?: Array<Record<string, unknown>>; scheduled_at?: string; utm?: { campaign: string; content?: string } | null };
type SocialSvc = NonNullable<ActionDeps['social']>;

/** Phần sửa + bài hiện tại ⇒ đầu vào đầy đủ cho `posts.update` (trường không sửa giữ như bài đang có), đã kiểm như lúc chạy. */
async function resolvePostUpdate(s: SocialSvc, user: Parameters<SocialSvc['posts']['validate']>[0], id: number, patch: PostPatch) {
  const { post, live } = await s.posts.editable(id).catch((e: Error) => {
    throw new ActionUserError(e.message);
  });
  const ids = patch.account_ids ?? live.map((t) => t.account_id);
  const caps = new Map<number, Record<string, unknown>>();
  for (const c of patch.captions ?? []) {
    const aid = optInt(c.account_id);
    if (!aid) continue;
    if (!ids.includes(aid)) throw new ActionUserError(`captions có account_id ${aid} không nằm trong danh sách kênh của bài.`);
    caps.set(aid, c);
  }
  const media = (Array.isArray(post.media) ? post.media : []) as Array<{ key: string }>;
  const firstUtm = (live.map((t) => (t.options as Record<string, unknown> | null)?.utm).find(Boolean) ?? null) as unknown;
  const inheritedUtm: Record<string, unknown> = firstUtm ? { utm: firstUtm } : {};
  const input = {
    content: patch.content ?? post.content,
    media_keys: media.map((m) => m.key),
    scheduled_at: patch.scheduled_at ?? (post.scheduled_at ? post.scheduled_at.toISOString() : null),
    ...(patch.utm !== undefined ? { utm: patch.utm } : {}),
    targets: ids.map((account_id) => {
      const old = live.find((t) => t.account_id === account_id);
      const c = caps.get(account_id);
      const caption = c && typeof c.caption === 'string' ? (c.caption.trim() || null) : (old?.caption ?? null);
      // Kênh mới thêm vào bài đang gắn UTM thì gắn theo (không để một kênh "sạch" lẫn các kênh có UTM).
      const base = old ? storedOptions(old.options) : inheritedUtm;
      return { account_id, caption, options: mergeOptions(base, c) };
    }),
  };
  try {
    s.posts.newSchedule(input.scheduled_at); // cùng luật với lúc chạy: sau bây giờ ≥ 1 phút, trong 90 ngày
  } catch (e) {
    throw new ActionUserError((e as Error).message);
  }
  const v = await s.posts.validate(user, input, { keepMedia: post.media as never });
  return { input, v, version: post.updated_at };
}

export const updateScheduledPostAction: ActionToolDef = {
  name: 'update_scheduled_post',
  label: 'Sửa bài đang hẹn giờ',
  title: 'Sửa bài đang hẹn giờ / Update scheduled post',
  description:
    'Sửa một bài đăng đa kênh ĐANG HẸN GIỜ (chưa tới giờ, chưa kênh nào đăng): nội dung, giờ đăng, danh sách kênh, nội dung riêng và tuỳ chọn từng kênh. Trường nào bỏ trống thì giữ như cũ; account_ids có thì thay cả danh sách kênh; trong captions gửi chuỗi rỗng "" cho youtube_playlist_id / youtube_thumbnail_media_key / youtube_description / youtube_title / facebook_first_comment để bỏ tuỳ chọn đó. ' +
    'Chỉ đổi giờ thì dùng reschedule_social_post. utm_campaign / utm_content gắn UTM vào các liên kết trong bài (đo lượt truy cập từ bài này; utm_source là tên mạng, utm_medium=social), utm_campaign "" để bỏ. Bài sẽ lên công khai nên cần confirmed_by_user sau khi người dùng xem bản sửa. / ' +
    'Edits a scheduled post that has not started publishing: text, time, channels, per-channel caption and options. Omitted fields keep their current value; account_ids replaces the channel list. To only move the time use reschedule_social_post. Requires confirmed_by_user.',
  permissions: ['social.post'],
  destructive: false,
  idempotent: false,
  input: (z) => ({
    post_id: z.number().int().min(1).max(2_147_483_647).describe('id bài (list_social_posts) / Post id'),
    content: z.string().max(63_206).optional().describe('Nội dung chung mới; bỏ trống = giữ / New post text'),
    account_ids: z.array(z.number().int().min(1).max(2_147_483_647)).min(1).max(20).optional().describe('Danh sách kênh mới (thay toàn bộ); bỏ trống = giữ / New channel list'),
    captions: captionsParam(z),
    scheduled_at: z.string().max(40).optional().describe('Giờ đăng mới, giờ Việt Nam YYYY-MM-DDTHH:mm; bỏ trống = giữ / New time (Vietnam time)'),
    ...utmParams(z),
    confirmed_by_user: postConfirmParam(z),
  }),
  async prepare(args, { deps, user }) {
    const s = await social(deps);
    const id = optInt(args.post_id);
    if (!id) throw new ActionUserError('post_id không hợp lệ.');
    // Chỉ lưu PHẦN SỬA (không lưu ảnh chụp cả bài): chế độ duyệt có thể chờ tới 24 giờ, bài sửa trên giao diện trong lúc đó không bị ghi đè.
    const patch: PostPatch = {
      content: typeof args.content === 'string' ? args.content : undefined,
      account_ids: Array.isArray(args.account_ids) ? (args.account_ids as unknown[]).map(optInt).filter((x): x is number => x !== undefined) : undefined,
      captions: Array.isArray(args.captions) ? (args.captions as Array<Record<string, unknown>>) : undefined,
      scheduled_at: parseScheduledAt(args.scheduled_at) ?? undefined,
      utm: utmFromArgs(args),
    };
    const { v } = await resolvePostUpdate(s, user, id, patch);
    const details = postDetails(v);
    assertPostConfirmed(args.confirmed_by_user, details);
    return { params: { post_id: id, patch }, summary: shown(`Sửa bài hẹn giờ #${id}`), details };
  },
  async execute(params, { deps, user }) {
    const s = await social(deps);
    const { post_id, patch } = params as { post_id: number; patch: PostPatch };
    // Ghép phần sửa với bài HIỆN TẠI (không phải lúc chuẩn bị) rồi kiểm lại.
    const { input, version } = await resolvePostUpdate(s, user, Number(post_id), patch ?? {});
    // Ghi đúng bản vừa ghép: có ai sửa chen ngang giữa hai bước ⇒ service báo xung đột thay vì ghi đè.
    const p = await s.posts.update(user, Number(post_id), input as never, { expectUpdatedAt: version }).catch((e: Error) => {
      if ((e as { status?: number }).status === 409) throw new ActionUserError(e.message);
      throw e;
    });
    return { post_id: p.id, status: p.status, scheduled_at: p.scheduled_at ? vnWhen(p.scheduled_at) : null, targets: p.targets.filter((t) => t.status !== 'cancelled').map((t) => ({ account: t.account_name, status: t.status })) };
  },
};

export const rescheduleSocialPostAction: ActionToolDef = {
  name: 'reschedule_social_post',
  label: 'Đổi giờ bài hẹn',
  title: 'Đổi giờ bài đang hẹn / Reschedule social post',
  description:
    'Đổi giờ đăng của một bài đang hẹn giờ (chưa tới giờ, chưa kênh nào đăng), giữ nguyên nội dung và kênh. Giờ theo giờ Việt Nam, sau bây giờ ít nhất 1 phút, trong 90 ngày. / ' +
    'Moves a scheduled post that has not started publishing to a new time (Vietnam time), keeping text and channels.',
  permissions: ['social.post'],
  destructive: false,
  idempotent: true,
  input: (z) => ({
    post_id: z.number().int().min(1).max(2_147_483_647).describe('id bài / Post id'),
    scheduled_at: z.string().max(40).describe('Giờ đăng mới, giờ Việt Nam YYYY-MM-DDTHH:mm / New time in Vietnam time'),
  }),
  async prepare(args, { deps }) {
    const s = await social(deps);
    const id = optInt(args.post_id);
    if (!id) throw new ActionUserError('post_id không hợp lệ.');
    const at = parseScheduledAt(args.scheduled_at);
    if (!at) throw new ActionUserError('Thiếu scheduled_at (giờ Việt Nam, YYYY-MM-DDTHH:mm).');
    const { post } = await s.posts.editable(id).catch((e: Error) => {
      throw new ActionUserError(e.message);
    });
    try {
      s.posts.newSchedule(at); // cùng luật với lúc chạy: sau bây giờ ≥ 1 phút, trong 90 ngày
    } catch (e) {
      throw new ActionUserError((e as Error).message);
    }
    return {
      params: { post_id: id, scheduled_at: at },
      summary: shown(`Đổi giờ bài #${id} sang ${vnWhen(new Date(at))}`),
      details: lines(line('Giờ cũ', post.scheduled_at ? vnWhen(post.scheduled_at) : null), line('Giờ mới', vnWhen(new Date(at))), line('Nội dung', post.content, 300)),
    };
  },
  async execute(params, { deps }) {
    const s = await social(deps);
    const p = await s.posts.reschedule(Number(params.post_id), params.scheduled_at);
    return { post_id: p.id, scheduled_at: p.scheduled_at ? vnWhen(p.scheduled_at) : null };
  },
};

export const retrySocialTargetAction: ActionToolDef = {
  name: 'retry_social_post_target',
  label: 'Thử đăng lại một kênh',
  title: 'Thử đăng lại kênh bị lỗi / Retry social post target',
  description:
    'Đưa một kênh đang lỗi của bài (target_id từ get_social_post) vào hàng đăng lại ngay. Kênh cần liên kết lại thì phải liên kết trong Trinity trước. / Requeues one failed channel of a post (target_id from get_social_post).',
  permissions: ['social.post'],
  destructive: false,
  idempotent: false,
  input: (z) => ({ target_id: z.number().int().min(1).max(2_147_483_647).describe('target_id từ get_social_post / Target id') }),
  async prepare(args, { deps }) {
    await social(deps);
    const id = optInt(args.target_id);
    if (!id) throw new ActionUserError('target_id không hợp lệ.');
    const t = await deps.prisma.socialPostTarget.findUnique({ where: { id } });
    if (!t) throw new ActionUserError('Không tìm thấy target_id này.');
    if (t.status !== 'failed') throw new ActionUserError('Chỉ thử lại được kênh đang báo lỗi.');
    return { params: { target_id: id }, summary: shown(`Thử đăng lại bài #${t.post_id} trên kênh ${t.network}`), details: lines(line('Lỗi lần trước', t.last_error)) };
  },
  async execute(params, { deps }) {
    const s = await social(deps);
    const p = await s.posts.retry(Number(params.target_id));
    return { post_id: p.id, status: p.status };
  },
};

/** Lỗi tiếng Việt của service (400/404/409) → lỗi AI sửa được. */
const asUserError = (e: Error): never => {
  const status = (e as { status?: number }).status;
  if (typeof status === 'number' && status < 500) throw new ActionUserError(e.message);
  throw e;
};

export const publishSocialDraftAction: ActionToolDef = {
  name: 'publish_social_draft',
  label: 'Đăng bài nháp',
  title: 'Đăng bài nháp mạng xã hội / Publish social draft',
  description:
    'Đăng một bài nháp đa kênh (draft_id từ list_social_drafts hoặc save_social_draft) thành bài thật: đăng ngay hoặc hẹn giờ theo giờ đã lưu trong nháp. scheduled_at (giờ Việt Nam, YYYY-MM-DDTHH:mm) có thì thay giờ của nháp; gửi chuỗi rỗng "" để đăng ngay dù nháp có giờ hẹn; bỏ trống = giữ giờ của nháp; use_queue = true đặt vào khung trống gần nhất của hàng đợi thay cho giờ của nháp. ' +
    'Nháp phải đủ để đăng: ít nhất một kênh, có nội dung hoặc ảnh/video, giờ hẹn còn trong 90 ngày tới và chưa qua — thiếu thì máy chủ báo rõ thiếu gì và nháp giữ nguyên để sửa bằng save_social_draft. Đăng xong nháp ẩn khỏi danh sách nháp. ' +
    'Bài lên công khai nên cần confirmed_by_user — lời người dùng đồng ý sau khi xem nội dung, kênh và giờ. / ' +
    'Publishes a saved multi-channel draft (draft_id from list_social_drafts / save_social_draft) as a real post, now or at the draft\'s scheduled time. scheduled_at (Vietnam time) overrides the draft\'s time; "" posts now; omitted keeps the draft\'s time. The draft must be complete (a channel, text or media, a valid time) or nothing is posted and the draft stays as it is. Requires confirmed_by_user.',
  permissions: ['social.post'],
  destructive: false,
  idempotent: false,
  input: (z) => ({
    draft_id: z.number().int().min(1).max(2_147_483_647).describe('id bài nháp (list_social_drafts) / Draft id'),
    scheduled_at: z.string().max(40).optional().describe('Giờ đăng thay cho giờ trong nháp, giờ Việt Nam YYYY-MM-DDTHH:mm; "" = đăng ngay; bỏ trống = giữ giờ của nháp / Override time in Vietnam time; "" = now; omit = keep'),
    use_queue: useQueueParam(z),
    confirmed_by_user: postConfirmParam(z),
  }),
  async prepare(args, { deps, user }) {
    const s = await social(deps);
    const queued = await queueTime(s, args);
    const id = optInt(args.draft_id);
    if (!id) throw new ActionUserError('draft_id không hợp lệ.');
    // Chỉ lưu {draft_id, phiên bản, giờ ghi đè} (không chụp cả nháp); lúc chạy kiểm nháp còn đúng phiên bản đã xem.
    const overrides: { scheduled_at?: string | null } = queued ? { scheduled_at: queued } : typeof args.scheduled_at === 'string' ? { scheduled_at: parseScheduledAt(args.scheduled_at) } : {};
    const draft = await s.drafts.get(id).catch(asUserError);
    let input = s.drafts.toPostInput(draft, overrides, 'mcp');
    // Nháp tự chọn "Vào hàng đợi" (không có giờ cụ thể): chốt khung ngay để bản xem trước đúng giờ sẽ đăng.
    let fromQueue = Boolean(queued);
    if (input.use_queue) {
      const [slot] = await s.queue.nextFree(1);
      if (!slot) throw new ActionUserError('Nháp chọn đăng vào hàng đợi nhưng chưa có khung trống (Đăng đa kênh › Lịch › Khung giờ). / No free queue slot.');
      overrides.scheduled_at = slot.toISOString();
      input = s.drafts.toPostInput(draft, overrides, 'mcp');
      fromQueue = true;
    }
    if (input.scheduled_at) {
      try {
        s.posts.newSchedule(input.scheduled_at); // cùng luật với lúc đăng: sau bây giờ ≥ 1 phút, trong 90 ngày
      } catch (e) {
        throw new ActionUserError((e as Error).message);
      }
    }
    const v = await s.posts.validate(user, input).catch(asUserError);
    const details = postDetails(v);
    assertPostConfirmed(args.confirmed_by_user, details);
    const when = v.scheduledAt ? `Hẹn đăng lúc ${vnWhen(v.scheduledAt)}` : 'Đăng ngay';
    // Gắn với ĐÚNG bản nháp người dùng đã xem: nháp sửa sau đó (save_social_draft, màn web) ⇒ lúc chạy báo xung đột, không đăng bản khác.
    return { params: { draft_id: id, version: draft.updated_at.toISOString(), ...overrides, ...(fromQueue ? { queued: true } : {}) }, summary: shown(`${when} bài nháp #${id} lên ${v.targets.length} kênh`), details };
  },
  async execute(params, { deps, user }) {
    const s = await social(deps);
    const slot = params.queued ? await recheckQueued(s, params.scheduled_at as string | null) : null;
    const overrides = slot ? { scheduled_at: slot.at } : 'scheduled_at' in params ? { scheduled_at: params.scheduled_at as string | null } : {};
    const version = typeof params.version === 'string' ? new Date(params.version) : undefined;
    const p = await s.drafts.publish(user, Number(params.draft_id), overrides, 'mcp', version).catch(asUserError);
    return {
      ...(slot?.moved_from ? { moved_from: slot.moved_from, note: 'Khung đã chọn lúc xem trước không còn trống nên bài vào khung trống kế tiếp.' } : {}),
      post_id: p.id,
      status: p.status,
      scheduled_at: p.scheduled_at ? vnWhen(p.scheduled_at) : null,
      targets: p.targets.map((t) => ({ target_id: t.id, account: t.account_name, status: t.status })),
    };
  },
};

/** Dòng chi tiết cho bản xem trước nhập hàng loạt: mỗi dòng một câu (kênh — giờ — nội dung) hoặc lỗi. */
function importDetails(plan: Awaited<ReturnType<NonNullable<ActionDeps['social']>['importer']['planRows']>>['plan']): DetailLine[] {
  return plan.rows.map((r) => {
    const when = r.preview.use_queue ? `hàng đợi${r.preview.scheduled_at ? ` (${vnWhen(new Date(r.preview.scheduled_at))})` : ''}` : r.preview.scheduled_at ? vnWhen(new Date(r.preview.scheduled_at)) : 'không có giờ';
    const head = `${r.preview.channels.map((c) => c.name).join(', ') || 'chưa chọn kênh'} — ${when} — ${r.preview.content_excerpt || '(chỉ có tệp)'}`;
    return { label: `Dòng ${r.row}`, value: shown(r.ok ? head : `${head} — LỖI: ${r.errors.join(' ')}`, 500) };
  });
}

export const importSocialPostsAction: ActionToolDef = {
  name: 'import_social_posts',
  label: 'Nhập nhiều bài mạng xã hội',
  title: 'Nhập nhiều bài mạng xã hội / Import social posts in bulk',
  description:
    'Tạo nhiều bài đăng đa kênh một lần (tối đa 50 dòng): mỗi dòng là một bài với nội dung, kênh (account_ids từ list_social_accounts), giờ hẹn (scheduled_at giờ Việt Nam YYYY-MM-DDTHH:mm, hoặc use_queue = true lấy khung trống kế tiếp của hàng đợi; mỗi dòng hàng đợi một khung riêng), tệp (media_keys), first_comment (Facebook), youtube_title, utm_campaign. ' +
    'mode "drafts" = chỉ lưu thành bài nháp để người dùng xem trong Trinity, KHÔNG đăng gì, không cần confirmed_by_user (kênh và giờ có thể để trống). ' +
    'mode "schedule" = tạo bài hẹn giờ công khai trên kênh của công ty: mỗi dòng phải có kênh và giờ (hoặc use_queue), không có chế độ đăng ngay; gọi lần đầu KHÔNG có confirmed_by_user để nhận bản xem trước từng dòng (kênh, giờ, lỗi) và chưa tạo gì, người dùng xem rồi đồng ý thì gọi lại với đúng các dòng đó kèm confirmed_by_user. Nếu dữ liệu đổi giữa hai bước (kênh, tệp, giờ…) máy chủ từ chối và cần xem trước lại. Chỉ các dòng hợp lệ được tạo; dòng lỗi được báo trong skipped và không ảnh hưởng dòng khác. / ' +
    'Creates many multi-channel posts at once (up to 50 rows). Each row: text, account_ids, scheduled_at (Vietnam time) or use_queue (each queue row gets its own free slot), media_keys, first_comment (Facebook), youtube_title, utm_campaign. mode "drafts" only saves drafts: nothing is published, no confirmation needed. mode "schedule" creates PUBLIC scheduled posts (every row needs channels and a time or use_queue; no post-now): call first without confirmed_by_user to get the per-row preview (channels, time, errors) and nothing is created; after the user approves, call again with the same rows and confirmed_by_user. The server re-checks at execution and refuses if anything changed since the preview. Only valid rows are created; failed rows are reported in skipped.',
  permissions: ['social.post'],
  destructive: false,
  idempotent: false,
  input: (z) => ({
    rows: z
      .array(
        z.object({
          content: z.string().max(63_206).optional().describe('Nội dung bài (có thể bỏ trống nếu có media_keys) / Post text'),
          account_ids: z.array(z.number().int().min(1).max(2_147_483_647)).max(20).optional().describe('id kênh (list_social_accounts); bắt buộc khi mode schedule / Account ids'),
          scheduled_at: z.string().max(40).optional().describe('Giờ hẹn giờ Việt Nam YYYY-MM-DDTHH:mm; không dùng cùng use_queue / Vietnam time'),
          use_queue: z.boolean().optional().describe('true = khung trống kế tiếp của hàng đợi (mỗi dòng một khung) / next free queue slot'),
          media_keys: z.array(z.string().max(200)).max(10).optional().describe('media_key trong thư viện / Library media keys'),
          first_comment: z.string().max(8000).optional().describe('Bình luận đầu tiên (kênh Facebook của dòng) / Facebook first comment'),
          youtube_title: z.string().max(100).optional().describe('Tiêu đề YouTube (kênh YouTube của dòng) / YouTube title'),
          utm_campaign: z.string().max(100).optional().describe('Tên chiến dịch UTM gắn vào liên kết trong bài / UTM campaign'),
        }),
      )
      .min(1)
      .max(50)
      .describe('Các dòng/bài cần nhập, tối đa 50 / Rows to import, at most 50'),
    mode: z.enum(['drafts', 'schedule']).describe('drafts = lưu nháp, không đăng; schedule = tạo bài hẹn giờ công khai (cần confirmed_by_user) / drafts = save drafts; schedule = public scheduled posts'),
    confirmed_by_user: z
      .string()
      .max(300)
      .optional()
      .describe(
        'Chỉ cho mode schedule: lời người dùng đồng ý tạo các bài hẹn giờ sau khi xem bản xem trước từng dòng, chép nguyên văn (vd "ok tạo đi"). Bỏ trống ở lần đầu để nhận bản xem trước; máy chủ không tạo gì nếu thiếu. / ' +
          'Only for mode schedule: the user\'s own words approving the scheduled posts after seeing the per-row preview, verbatim. Omit on the first call to get the preview; nothing is created without it.',
      ),
  }),
  async prepare(args, { deps, user }) {
    const s = await social(deps);
    const mode = args.mode;
    if (mode !== 'drafts' && mode !== 'schedule') throw new ActionUserError('mode phải là "drafts" hoặc "schedule". / mode must be drafts or schedule.');
    const rows = rowsFromStructured((Array.isArray(args.rows) ? args.rows : []) as Parameters<typeof rowsFromStructured>[0]);
    if (rows.length === 0 || rows.length > 50) throw new ActionUserError('rows cần từ 1 đến 50 dòng. / rows needs 1 to 50 entries.');
    const { plan } = await s.importer.planRows(user, rows, mode).catch(asUserError);
    const details = importDetails(plan);
    if (plan.ok_count === 0) throw new ActionUserError(`Không dòng nào hợp lệ nên chưa tạo gì. ${details.map((d) => `${d.label}: ${d.value}`).join(' | ')} / No valid row; nothing created.`);
    // Nháp không đăng gì ⇒ không cần xác nhận; bài hẹn giờ là công khai ⇒ cần lời đồng ý sau khi xem từng dòng.
    if (mode === 'schedule') assertPostConfirmed(args.confirmed_by_user, details);
    return {
      // Chỉ lưu dòng đã chuẩn hoá + băm: lúc chạy kiểm lại và từ chối nếu khác bản đã xem.
      params: { mode, rows, plan_hash: plan.plan_hash },
      summary: shown(mode === 'drafts' ? `Lưu ${plan.ok_count} bài nháp từ ${plan.total} dòng` : `Tạo ${plan.ok_count} bài hẹn giờ từ ${plan.total} dòng`),
      details,
    };
  },
  async execute(params, { deps, user }) {
    const s = await social(deps);
    const p = params as { mode: 'drafts' | 'schedule'; rows: Parameters<typeof s.importer.importRows>[1]; plan_hash: string };
    const r = await s.importer.importRows(user, p.rows, p.mode, p.plan_hash, 'mcp').catch((e: Error) => {
      if ((e as { status?: number }).status === 409) throw new ActionUserError(`${e.message} / The data changed since the preview; call again without confirmed_by_user to preview.`);
      return asUserError(e);
    });
    return { mode: r.mode, created_count: r.created.length, created: r.created, skipped: r.skipped };
  },
};
