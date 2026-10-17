import { BadRequestException } from '@nestjs/common';
import { wrapData } from '../ai-output';
import { activityRange, vnIso } from './ai-activity-tool';
import { ActionUserError } from '../actions/action-types';
import { describeRule, recurrenceStatus } from '../actions/action-recurring-tools';
import { VN_WEEKDAYS, captionsParam, mergeOptions, optionsFromCaption, parseScheduledAt, utmFromArgs, utmParams, vnWhen } from '../actions/action-social-tools';
import { ToolUserError, clampLimit, optInt, rejectDigitProbe, type McpDeps, type ToolDef } from './tool-types';

const POST_STATUSES = ['scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled'] as const;

/** Tính năng đăng đa kênh phải được nối (module) và bật cho tổ chức. */
export async function socialDeps(deps: Pick<McpDeps, 'social' | 'orgFeatures'>) {
  if (!deps.social) throw new ToolUserError('Máy chủ này chưa có tính năng đăng đa kênh. / Social posting is not available on this server.');
  if (!(await deps.orgFeatures.isEnabled('social_posting'))) {
    throw new ToolUserError('Tính năng "Đăng đa kênh" đang tắt (Cài đặt › Tính năng). / Social posting is turned off for this workspace.');
  }
  return deps.social;
}

type PostLike = Awaited<ReturnType<NonNullable<McpDeps['social']>['posts']['get']>>;

/** Bài đăng dạng gọn cho AI: giờ VN, trạng thái từng kênh, link bài đã lên. */
export function postForAi(p: PostLike, baseUrl: string) {
  const media = Array.isArray(p.media) ? (p.media as Array<{ type?: string }>) : [];
  return {
    post_id: p.id,
    status: p.status,
    content: p.content,
    media: media.map((m) => m.type ?? 'file'),
    created_at: vnIso(p.created_at),
    scheduled_at: vnIso(p.scheduled_at),
    source: p.source,
    targets: p.targets.map((t) => ({
      target_id: t.id,
      account_id: t.account_id,
      account_name: t.account_name,
      network: t.network,
      status: t.status,
      caption: t.caption,
      post_link: t.url,
      error: t.last_error,
      published_at: vnIso(t.published_at),
      attempts: t.attempts,
      metrics: t.metrics ?? null,
      metrics_updated_at: vnIso(t.metrics_at ?? null),
    })),
    url: `${baseUrl}/social?post=${p.id}`,
  };
}

export const listSocialAccountsTool: ToolDef = {
  name: 'list_social_accounts',
  title: 'Kênh mạng xã hội đã liên kết / List social accounts',
  description:
    'Bước đầu của việc đăng bài lên Fanpage Facebook hoặc kênh YouTube của công ty qua Trinity: các kênh mạng xã hội công ty đã liên kết với Trinity (Fanpage Facebook, kênh YouTube). Chưa có kênh thì người dùng liên kết ở màn Đăng đa kênh › Kênh. Trả về id kênh, mạng, tên, trạng thái (active = đăng được; reauth = cần liên kết lại trong Trinity), removed (true = người dùng đã gỡ kênh, KHÔNG đăng được; bật lại bằng enable_social_account hoặc liên kết lại), inbox (chỉ Fanpage: on/off/null = phần nhận tin nhắn của cùng Page đã nối, đang tắt, hay chưa nối). ' +
    'Kèm danh sách mạng và mạng nào đã hỗ trợ. account_id dùng cho create_social_post. Danh sách không xếp theo mức dùng và không có kênh mặc định. Chỉ đọc. / ' +
    'First step for posting to the company\'s Facebook Page or YouTube channel through Trinity: social accounts linked to Trinity (Facebook Pages, YouTube channels); with none linked, the user links them in Trinity under Đăng đa kênh › Kênh. Returns id, network, name, status (active, or reauth = needs relinking in Trinity), removed (true = the user removed the channel; cannot post, re-enable with enable_social_account), inbox (Facebook only: on/off/null = whether the message inbox of the same Page is connected, off, or not connected), plus which networks are supported. Not ordered by usage; no default channel. Read-only.',
  permissions: ['social.post'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps, baseUrl }) {
    const s = await socialDeps(deps);
    const accounts = await s.accounts.list();
    const networks = s.accounts.networks().map((n) => ({ network: n.network, label: n.label, supported: n.supported, configured: n.configured }));
    const out = wrapData({
      accounts: accounts.map((a) => ({ account_id: a.id, network: a.network, name: a.name, status: a.status, removed: a.removed ?? false, ...(a.network === 'facebook' ? { inbox: a.inbox ?? null } : {}), error: a.last_error })),
      networks,
      manage_url: `${baseUrl}/social?tab=channels`,
    });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const listSocialPostsTool: ToolDef = {
  name: 'list_social_posts',
  title: 'Bài đăng mạng xã hội / List social posts',
  description:
    'Bài đăng đa kênh theo ngày (giờ Việt Nam): bài hẹn giờ tính theo giờ hẹn (scheduled_at), bài đăng ngay tính theo giờ tạo. Mỗi bài có trạng thái tổng (scheduled = đang chờ tới giờ hẹn) và trạng thái từng kênh (queued/publishing/published/failed/cancelled), link bài đã lên, lỗi nếu có. ' +
    'Mặc định hôm nay; from/to dạng YYYY-MM-DD, tối đa 92 ngày — muốn xem các bài đã hẹn sắp tới thì đặt to là ngày xa hơn. Xem lịch đăng bài tuần/tháng: from = ngày đầu, to = ngày cuối của tuần/tháng đó. Chỉ đọc. / ' +
    'Social posts by day (Vietnam time): scheduled posts by their scheduled time, others by creation time; status scheduled = waiting for its time. Per-channel status, links and errors. Defaults to today; set a later `to` to see upcoming scheduled posts. For a weekly/monthly posting calendar pass the first and last day of that week or month. Read-only.',
  permissions: ['social.post'],
  input: (z) => ({
    from: z.string().max(10).optional().describe('Từ ngày YYYY-MM-DD; bỏ trống = hôm nay / From date'),
    to: z.string().max(10).optional().describe('Đến hết ngày YYYY-MM-DD / To date (inclusive)'),
    status: z.enum(POST_STATUSES).optional().describe('Lọc trạng thái bài / Post status filter'),
    limit: z.number().int().min(1).max(50).optional().describe('Số bài tối đa (1-50, mặc định 20) / Max posts'),
    cursor: z.number().int().min(1).max(2_147_483_647).optional().describe('next_cursor của trang trước / Pagination cursor'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const s = await socialDeps(deps);
    const range = activityRange(args.from, args.to);
    const status = typeof args.status === 'string' && (POST_STATUSES as readonly string[]).includes(args.status) ? args.status : undefined;
    const r = await s.posts.list({ from: range.from.toISOString(), to: new Date(range.to.getTime() - 1).toISOString(), status, limit: clampLimit(args.limit), cursor: optInt(args.cursor) });
    const out = wrapData({ range: range.label, timezone: 'Asia/Ho_Chi_Minh', posts: r.data.map((p) => postForAi(p, baseUrl)), next_cursor: r.next_cursor });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const getSocialPostTool: ToolDef = {
  name: 'get_social_post',
  title: 'Chi tiết bài đăng đa kênh / Get social post',
  description:
    'Một bài đăng đa kênh: nội dung, trạng thái từng kênh (target_id dùng cho retry_social_post_target), link bài đã lên, lỗi (nếu có) và số lần đã thử. Bài đăng chạy nền vài giây đến vài phút (video lâu hơn) nên trạng thái có thể còn publishing. Chỉ đọc. / ' +
    'One social post with per-channel status (target_id for retry_social_post_target), links, errors and attempts. Publishing runs in the background, so status may still be publishing. Read-only.',
  permissions: ['social.post'],
  input: (z) => ({ post_id: z.number().int().min(1).max(2_147_483_647).describe('id bài / Post id') }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const s = await socialDeps(deps);
    const id = optInt(args.post_id);
    if (!id) throw new ToolUserError('post_id không hợp lệ.');
    const out = wrapData(postForAi(await s.posts.get(id), baseUrl));
    return { structured: out, text: JSON.stringify(out) };
  },
};

type LibraryItemLike = Awaited<ReturnType<NonNullable<McpDeps['social']>['posts']['media']['list']>>['data'][number];

const mediaForAi = (m: LibraryItemLike, baseUrl: string) => ({
  media_id: m.id,
  media_key: m.key,
  type: m.type,
  name: m.name,
  size_kb: Math.round(m.size / 1024),
  uploaded_at: vnIso(m.created_at),
  preview_url: `${baseUrl}/social?tab=library&media=${m.id}`,
});

export const listSocialMediaTool: ToolDef = {
  name: 'list_social_media',
  title: 'Thư viện ảnh/video đăng bài / List social media library',
  description:
    'Thư viện ảnh và video dùng chung của công ty trong Trinity (người dùng tải ở màn Đăng đa kênh, hoặc AI tải bằng upload_social_media). ' +
    'Mỗi tệp có media_key — đưa media_key vào create_social_post.media_keys để đăng lại ảnh/video có sẵn. Mới nhất trước; lọc type (image/video) hoặc q (tìm theo tên tệp). Chỉ đọc. / ' +
    'The company\'s shared image/video library for social posts. Each file has a media_key to pass in create_social_post.media_keys. Newest first; filter by type or name (q). Read-only.',
  permissions: ['social.post'],
  input: (z) => ({
    type: z.enum(['image', 'video']).optional().describe('Chỉ ảnh hoặc chỉ video / Only images or only videos'),
    q: z.string().max(100).optional().describe('Tìm theo tên tệp / Search by file name'),
    limit: z.number().int().min(1).max(50).optional().describe('Số tệp tối đa (1-50, mặc định 20) / Max files'),
    cursor: z.number().int().min(1).max(2_147_483_647).optional().describe('next_cursor của trang trước / Pagination cursor'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const s = await socialDeps(deps);
    const r = await s.posts.media.list({
      type: typeof args.type === 'string' ? args.type : undefined,
      q: typeof args.q === 'string' ? args.q : undefined,
      limit: clampLimit(args.limit),
      cursor: optInt(args.cursor),
    });
    const out = wrapData({ files: r.data.map((m) => mediaForAi(m, baseUrl)), next_cursor: r.next_cursor });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/**
 * AI của người dùng tự tạo ảnh/video (máy chủ Trinity không gọi AI) rồi đưa vào thư viện — GHI THẲNG: chỉ thêm tệp vào
 * thư viện, chưa đăng gì ra ngoài; đăng vẫn qua create_social_post có confirmed_by_user.
 */
export const uploadSocialMediaTool: ToolDef = {
  name: 'upload_social_media',
  title: 'Tải ảnh/video vào thư viện đăng bài / Upload social media',
  description:
    'Đưa một ảnh hoặc video vào thư viện đăng bài của Trinity để dùng trong create_social_post — vd ảnh/video bạn vừa tạo cho người dùng. ' +
    'Cách 1 (nên dùng): url = link https công khai trỏ THẲNG tới tệp ảnh/video (không phải trang web chứa ảnh); ảnh JPG/PNG/WebP/GIF ≤ 10 MB, video MP4/MOV/WebM ≤ 100 MB. ' +
    'Cách 2: ảnh nhỏ ≤ 3 MB gửi data_base64 kèm file_name có đuôi (vd banner.png). Chỉ một trong hai cách. ' +
    'Kết quả có media_key — đưa vào create_social_post.media_keys. Tải lên KHÔNG đăng gì ra mạng xã hội. Cần scope crm.write. / ' +
    'Adds an image or video to Trinity\'s posting library (e.g. one you just generated). Prefer url (public https link straight to the file; images ≤ 10 MB, videos ≤ 100 MB); or data_base64 + file_name for small images ≤ 3 MB. Returns media_key for create_social_post.media_keys. Uploading does not post anything.',
  permissions: ['social.post'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    url: z.string().max(2000).optional().describe('Link https công khai trỏ thẳng tới tệp ảnh/video / Public https URL of the file'),
    data_base64: z.string().max(4_200_000).optional().describe('Nội dung ảnh dạng base64 (≤ 3 MB) — chỉ khi không có link / Base64 image when no URL'),
    file_name: z.string().max(200).optional().describe('Tên tệp có đuôi, bắt buộc khi dùng data_base64 (vd banner.png) / File name with extension'),
    name: z.string().max(200).optional().describe('Tên hiển thị trong thư viện (tuỳ chọn) / Display name'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const s = await socialDeps(deps);
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    const b64 = typeof args.data_base64 === 'string' ? args.data_base64.trim() : '';
    const name = typeof args.name === 'string' ? args.name : undefined;
    if (!url === !b64) throw new ToolUserError('Cần đúng một trong hai: url hoặc data_base64. / Provide exactly one of url or data_base64.');
    let m: LibraryItemLike;
    try {
      if (url) m = await s.posts.media.importFromUrl(principal.user, url, name);
      else {
        const fileName = typeof args.file_name === 'string' ? args.file_name.trim() : '';
        if (!fileName) throw new ToolUserError('Gửi data_base64 thì cần file_name có đuôi (vd banner.png). / file_name is required with data_base64.');
        m = await s.posts.media.importBase64(principal.user, b64, fileName, name);
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw new ToolUserError(err.message);
      throw err;
    }
    const out = wrapData({ ...mediaForAi(m, baseUrl), next_step: 'Đưa media_key vào create_social_post.media_keys; người dùng vẫn phải đồng ý nội dung trước khi đăng.' });
    return { structured: out, text: JSON.stringify(out) };
  },
};

type DraftLike = Awaited<ReturnType<NonNullable<McpDeps['social']>['drafts']['get']>>;
type DraftTargetLike = { account_id: number; caption?: string | null; options?: Record<string, unknown> };

/** Tuỳ chọn đã lưu → dạng captions mà AI gửi vào (ngược của optionsFromCaption). */
function captionFromTarget(t: DraftTargetLike) {
  const o = t.options ?? {};
  const out: Record<string, unknown> = { account_id: t.account_id };
  if (t.caption) out.caption = t.caption;
  const map: Record<string, string> = { title: 'youtube_title', privacy: 'youtube_privacy', description: 'youtube_description', tags: 'youtube_tags', category_id: 'youtube_category', made_for_kids: 'youtube_made_for_kids', playlist_id: 'youtube_playlist_id', first_comment: 'facebook_first_comment', thumbnail_key: 'youtube_thumbnail_media_key' };
  for (const [k, v] of Object.entries(map)) if (o[k] !== undefined) out[v] = o[k];
  return out;
}

/** UTM lưu trong tuỳ chọn các kênh → utm_campaign/utm_content cho AI (không có ⇒ không thêm khoá). */
function draftUtm(targets: DraftTargetLike[]): Record<string, string> {
  const u = targets.map((t) => (t.options ?? {}).utm as { campaign?: string; content?: string } | undefined).find((x) => x?.campaign);
  return u?.campaign ? { utm_campaign: u.campaign, ...(u.content ? { utm_content: u.content } : {}) } : {};
}

/** Nháp dạng gọn cho AI: giờ VN, kênh có tên, link mở nháp trên web. */
export function draftForAi(d: DraftLike, names: Map<number, { name: string; network: string }>, baseUrl: string) {
  const media = Array.isArray(d.media) ? (d.media as Array<{ key?: string; type?: string; name?: string }>) : [];
  const targets = Array.isArray(d.targets) ? (d.targets as unknown as DraftTargetLike[]) : [];
  return {
    draft_id: d.id,
    title: d.title,
    content: d.content,
    media: media.map((m) => ({ media_key: m.key, type: m.type ?? 'file', name: m.name })),
    channels: targets.map((t) => ({ account_id: t.account_id, name: names.get(t.account_id)?.name ?? null, network: names.get(t.account_id)?.network ?? null })),
    captions: targets.map(captionFromTarget).filter((c) => Object.keys(c).length > 1),
    ...draftUtm(targets),
    scheduled_at: vnIso(d.scheduled_at),
    use_queue: d.use_queue,
    source: d.source,
    updated_at: vnIso(d.updated_at),
    edit_url: `${baseUrl}/social?tab=drafts&draft=${d.id}`,
  };
}

const accountNames = async (s: NonNullable<McpDeps['social']>) => new Map((await s.accounts.list()).map((a) => [a.id, { name: a.name, network: a.network }]));

export const listSocialDraftsTool: ToolDef = {
  name: 'list_social_drafts',
  title: 'Bài nháp đăng đa kênh / List social drafts',
  description:
    'Các bài nháp đăng đa kênh chưa đăng của công ty (mới sửa trước, tối đa 100): nội dung, kênh đã chọn, nội dung riêng và tuỳ chọn từng kênh, ảnh/video, giờ hẹn (giờ Việt Nam) nếu có, và edit_url để mở nháp trong Trinity. Nháp có thể chưa đủ để đăng (chưa chọn kênh, chưa có nội dung). draft_id dùng cho save_social_draft và publish_social_draft. Chỉ đọc. / ' +
    'Unpublished multi-channel drafts (most recently edited first, up to 100): text, chosen channels, per-channel captions/options, media, scheduled time (Vietnam time) and edit_url. A draft may be incomplete. draft_id is used by save_social_draft and publish_social_draft. Read-only.',
  permissions: ['social.post'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps, baseUrl }) {
    const s = await socialDeps(deps);
    const [r, names] = await Promise.all([s.drafts.list(), accountNames(s)]);
    const out = wrapData({ timezone: 'Asia/Ho_Chi_Minh', drafts: r.data.map((d) => draftForAi(d, names, baseUrl)) });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const saveSocialDraftTool: ToolDef = {
  name: 'save_social_draft',
  title: 'Lưu bài nháp đăng đa kênh / Save social draft',
  description:
    'Lưu một bài nháp đăng đa kênh để người dùng xem, sửa trong Trinity (Đăng đa kênh › Nháp) rồi đăng sau — KHÔNG đăng gì ra mạng xã hội. Bỏ trống draft_id = tạo nháp mới; có draft_id (từ list_social_drafts) = sửa nháp đó, trường nào bỏ trống thì giữ như cũ. ' +
    'Nháp được phép thiếu: chưa chọn kênh, chưa có nội dung, chưa có giờ. account_ids (có thì thay cả danh sách kênh), captions (nội dung riêng và tuỳ chọn từng kênh, cùng dạng như create_social_post), media_keys (thay cả danh sách tệp; từ list_social_media / upload_social_media), scheduled_at (giờ Việt Nam YYYY-MM-DDTHH:mm; "" = bỏ giờ hẹn). title là tên gợi nhớ. utm_campaign / utm_content lưu cấu hình gắn UTM vào các liên kết trong bài (đo lượt truy cập từ bài này; utm_source là tên mạng, utm_medium=social; "" = bỏ) và áp khi đăng. ' +
    'Muốn đăng nháp thì dùng publish_social_draft. Cần scope crm.write. / ' +
    'Saves a multi-channel draft for the user to review and edit in Trinity, then post later; nothing is published. Without draft_id a new draft is created; with draft_id only the fields sent change (account_ids and media_keys replace the whole list; scheduled_at "" clears the time). utm_campaign/utm_content store UTM tagging for the links (applied when posted). Drafts may be incomplete. To post a draft use publish_social_draft.',
  permissions: ['social.post'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    draft_id: z.number().int().min(1).max(2_147_483_647).optional().describe('id nháp cần sửa (list_social_drafts); bỏ trống = tạo nháp mới / Draft to update; omit to create'),
    title: z.string().max(120).optional().describe('Tên gợi nhớ của nháp / Draft title'),
    content: z.string().max(63_206).optional().describe('Nội dung chung / Post text'),
    account_ids: z.array(z.number().int().min(1).max(2_147_483_647)).max(20).optional().describe('id các kênh, từ list_social_accounts; có thì thay cả danh sách / Account ids; replaces the list'),
    captions: captionsParam(z),
    media_keys: z.array(z.string().max(200)).max(10).optional().describe('media_key trong thư viện; có thì thay cả danh sách tệp / Library media keys; replaces the list'),
    scheduled_at: z.string().max(40).optional().describe('Giờ hẹn theo giờ Việt Nam YYYY-MM-DDTHH:mm; "" = bỏ giờ hẹn; bỏ trống = giữ / Vietnam time; "" clears'),
    ...utmParams(z),
    use_queue: z.boolean().optional().describe('true = khi đăng, nháp vào khung trống gần nhất của hàng đợi (bỏ giờ hẹn cụ thể); false = bỏ chọn / Publish into the next free queue slot'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const s = await socialDeps(deps);
    const user = principal.user;
    const id = args.draft_id === undefined ? undefined : optInt(args.draft_id);
    if (args.draft_id !== undefined && !id) throw new ToolUserError('draft_id không hợp lệ.');
    try {
      const cur = id ? await s.drafts.get(id) : null;
      const old = new Map(((cur?.targets ?? []) as unknown as DraftTargetLike[]).map((t) => [t.account_id, t]));
      const input: Parameters<typeof s.drafts.create>[1] = {};
      if (typeof args.title === 'string') input.title = args.title;
      if (typeof args.content === 'string') input.content = args.content;
      if (Array.isArray(args.media_keys)) input.media_keys = (args.media_keys as unknown[]).filter((k): k is string => typeof k === 'string');
      if (args.scheduled_at !== undefined) input.scheduled_at = parseScheduledAt(args.scheduled_at);
      if (typeof args.use_queue === 'boolean') input.use_queue = args.use_queue;
      const utm = utmFromArgs(args);
      if (utm !== undefined) input.utm = utm;
      const ids = Array.isArray(args.account_ids) ? (args.account_ids as unknown[]).map(optInt).filter((x): x is number => x !== undefined) : undefined;
      const caps = new Map<number, Record<string, unknown>>();
      for (const c of Array.isArray(args.captions) ? (args.captions as Array<Record<string, unknown>>) : []) {
        const aid = optInt(c.account_id);
        if (aid) caps.set(aid, c);
      }
      if (ids || caps.size) {
        const list = ids ?? [...old.keys()];
        for (const aid of caps.keys()) if (!list.includes(aid)) throw new ToolUserError(`captions có account_id ${aid} không nằm trong danh sách kênh của nháp.`);
        input.targets = list.map((account_id) => {
          const o = old.get(account_id);
          const c = caps.get(account_id);
          const caption = c && typeof c.caption === 'string' ? c.caption.trim() || null : (o?.caption ?? null);
          return { account_id, caption, options: c ? mergeOptions(o?.options ?? {}, c) : (o?.options ?? {}) };
        });
      }
      // UTM lưu theo từng kênh: nháp chưa có kênh thì không có chỗ lưu ⇒ báo rõ thay vì mất âm thầm.
      if (utm && !(input.targets ? input.targets.length : old.size)) {
        throw new ToolUserError('Nháp chưa có kênh nên chưa gắn UTM được — gửi kèm account_ids (list_social_accounts). / Add account_ids before setting UTM.');
      }
      const saved = id ? await s.drafts.update(user, id, input) : await s.drafts.create(user, input, 'mcp');
      const out = wrapData({
        ...draftForAi(saved, await accountNames(s), baseUrl),
        next_step: 'Nháp ĐÃ LƯU, CHƯA ĐĂNG gì. Người dùng xem/sửa ở edit_url; muốn đăng thì dùng publish_social_draft sau khi họ đồng ý.',
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      if (err instanceof ActionUserError) throw new ToolUserError(err.message);
      const st = (err as { status?: number }).status;
      if (typeof st === 'number' && st < 500) throw new ToolUserError((err as Error).message);
      throw err;
    }
  },
};

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export const listQueueSlotsTool: ToolDef = {
  name: 'list_queue_slots',
  title: 'Khung giờ hàng đợi đăng bài / List queue slots',
  description:
    'Khung giờ đăng hàng đợi hằng tuần của công ty (giờ Việt Nam; thứ + giờ, vd Thứ Hai 09:00) và 5 khung trống gần nhất (next_free; khung đã có bài hẹn thì bỏ qua). Dùng use_queue trong create_social_post / publish_social_draft để đặt bài vào khung trống gần nhất. Chỉ đọc. / ' +
    'The company\'s weekly posting-queue slots (Vietnam time) and the next 5 free slots (slots already holding a scheduled post are skipped). Use use_queue in create_social_post / publish_social_draft to take the nearest free slot. Read-only.',
  permissions: ['social.post'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps }) {
    const s = await socialDeps(deps);
    const [slots, next] = await Promise.all([s.queue.slots(), s.queue.nextFree(5)]);
    const out = wrapData({
      timezone: 'Asia/Ho_Chi_Minh',
      slots: slots.map((x) => ({ weekday: x.weekday, weekday_text: VN_WEEKDAYS[x.weekday], time: hhmm(x.minute) })),
      next_free: next.map(vnWhen),
    });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const previewSocialPostTool: ToolDef = {
  name: 'preview_social_post',
  title: 'Xem trước bài theo từng kênh / Preview social post per channel',
  description:
    'Cho người dùng xem từng kênh sẽ hiện bài thế nào TRƯỚC khi đăng: chữ đúng như sẽ gửi (đã gắn UTM), tiêu đề + mô tả YouTube, bình luận đầu tiên Facebook, độ dài / giới hạn, điểm bị gập sau "Xem thêm" (truncated_at, xấp xỉ), tệp đính kèm và cảnh báo (quá giới hạn, thiếu tệp, kênh cần liên kết lại…). Nên gọi trước create_social_post để người dùng duyệt. ' +
    'Nhận cùng đầu vào như create_social_post (account_ids, content, captions, media_keys, scheduled_at, use_queue, utm_campaign / utm_content) trừ confirmed_by_user. Chỉ đọc: KHÔNG đăng, không lưu gì, không giữ khung hàng đợi. / ' +
    'Shows how each channel will render the post BEFORE posting: the exact text that will be sent (UTM applied), YouTube title + description, Facebook first comment, length vs limit, the approximate "See more" cut point (truncated_at), attachments and warnings (over limit, missing media, account needs re-linking…). Useful before create_social_post so the user can review. Same inputs as create_social_post except confirmed_by_user. Read-only: nothing is posted, saved or reserved in the queue.',
  permissions: ['social.post'],
  input: (z) => ({
    content: z.string().max(63_206).optional().describe('Nội dung chung của bài / Post text'),
    account_ids: z.array(z.number().int().min(1).max(2_147_483_647)).min(1).max(20).describe('id các kênh cần xem, từ list_social_accounts / Account ids to preview'),
    captions: captionsParam(z),
    media_keys: z.array(z.string().max(200)).max(10).optional().describe('media_key trong thư viện / Library media keys'),
    scheduled_at: z.string().max(40).optional().describe('Giờ hẹn theo giờ Việt Nam YYYY-MM-DDTHH:mm; bỏ trống = đăng ngay / Vietnam time; omit to post now'),
    use_queue: z.boolean().optional().describe('true = xem giờ của khung trống gần nhất trong hàng đợi (không giữ chỗ) / true = show the nearest free queue slot (not reserved)'),
    ...utmParams(z),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const s = await socialDeps(deps);
    const ids = Array.isArray(args.account_ids) ? (args.account_ids as unknown[]).map(optInt).filter((x): x is number => x !== undefined) : [];
    const caps = new Map<number, { caption?: string; options: Record<string, unknown> }>();
    for (const c of Array.isArray(args.captions) ? (args.captions as Array<Record<string, unknown>>) : []) {
      const id = optInt(c.account_id);
      if (!id) continue;
      if (!ids.includes(id)) throw new ToolUserError(`captions có account_id ${id} không nằm trong account_ids.`);
      caps.set(id, { caption: typeof c.caption === 'string' && c.caption.trim() ? c.caption.trim() : undefined, options: optionsFromCaption(c) });
    }
    try {
      const p = await s.posts.preview(principal.user, {
        content: typeof args.content === 'string' ? args.content : '',
        media_keys: Array.isArray(args.media_keys) ? (args.media_keys as unknown[]).filter((k): k is string => typeof k === 'string') : [],
        targets: ids.map((account_id) => ({ account_id, caption: caps.get(account_id)?.caption ?? null, options: caps.get(account_id)?.options ?? {} })),
        scheduled_at: args.use_queue === true ? null : parseScheduledAt(args.scheduled_at),
        use_queue: args.use_queue === true ? true : undefined,
        utm: utmFromArgs(args),
      });
      const out = wrapData({
        scheduled_at: p.scheduled_at ? vnWhen(new Date(p.scheduled_at)) : 'Đăng ngay',
        from_queue: p.from_queue,
        warnings: p.warnings,
        channels: p.targets,
        next_step: 'ĐÂY CHỈ LÀ XEM TRƯỚC — CHƯA ĐĂNG gì. Cho người dùng xem từng kênh (nhất là warnings); họ đồng ý thì gọi create_social_post với confirmed_by_user. truncated_at là mốc xấp xỉ, mỗi mạng đổi theo thiết bị.',
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      if (err instanceof ActionUserError) throw new ToolUserError(err.message);
      const st = (err as { status?: number }).status;
      if (typeof st === 'number' && st < 500) throw new ToolUserError((err as Error).message);
      throw err;
    }
  },
};

export const setQueueSlotsTool: ToolDef = {
  name: 'set_queue_slots',
  title: 'Đặt khung giờ hàng đợi đăng bài / Set queue slots',
  description:
    'Đặt lại TOÀN BỘ khung giờ đăng hàng đợi hằng tuần (giờ Việt Nam): danh sách gửi lên thay hẳn danh sách cũ, nên muốn thêm khung thì đọc list_queue_slots trước rồi gửi khung đang có cộng khung mới. Phải còn ít nhất một khung (xoá hết khung làm ở màn Lịch của Trinity). Mỗi khung gồm weekday (0 = Chủ nhật, 1 = Thứ Hai … 6 = Thứ Bảy) và time "HH:mm"; tối đa 100 khung, khung trùng được gộp. Chỉ đổi lịch khung giờ, không đăng và không đổi bài nào đã hẹn. Cần scope crm.write. / ' +
    'Replaces the WHOLE weekly posting-queue slot list (Vietnam time): to add a slot, read list_queue_slots first and send the existing slots plus the new one. At least one slot is required (clearing all slots is done in the Trinity web app). Each slot is weekday (0 = Sunday … 6 = Saturday) + time "HH:mm"; up to 100, duplicates merged. Only the slot schedule changes; nothing is published and no scheduled post is touched.',
  permissions: ['social.post'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({
    slots: z
      .array(
        z.object({
          weekday: z.number().int().min(0).max(6).describe('0 = Chủ nhật, 1 = Thứ Hai … 6 = Thứ Bảy / 0 = Sunday … 6 = Saturday'),
          time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time phải dạng HH:mm (00:00–23:59)').describe('Giờ Việt Nam "HH:mm", vd "09:00", "19:30" / Vietnam time'),
        }),
      )
      .min(1)
      .max(100)
      .describe('Danh sách khung MỚI (ít nhất 1), thay toàn bộ danh sách cũ / The new full list (at least one slot)'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps }) {
    const s = await socialDeps(deps);
    const raw = Array.isArray(args.slots) ? (args.slots as Array<{ weekday: number; time: string }>) : [];
    // Xoá hết khung là việc của màn web: một lần gửi nhầm "[]" (tưởng là thêm khung) không được xoá lịch cả công ty.
    if (raw.length === 0) throw new ToolUserError('Cần ít nhất một khung. Muốn thêm khung thì gửi khung đang có (list_queue_slots) cộng khung mới; xoá hết khung làm ở màn Lịch của Trinity. / At least one slot is required.');
    const list = raw.map((x) => {
      const m = /^(\d{2}):(\d{2})$/.exec(String(x.time));
      if (!m) throw new ToolUserError(`time "${String(x.time).slice(0, 10)}" không đúng dạng HH:mm.`);
      return { weekday: x.weekday, minute: Number(m[1]) * 60 + Number(m[2]) };
    });
    try {
      const saved = await s.queue.setSlots(list);
      const out = wrapData({
        timezone: 'Asia/Ho_Chi_Minh',
        slots: saved.map((x) => ({ weekday: x.weekday, weekday_text: VN_WEEKDAYS[x.weekday], time: hhmm(x.minute) })),
        next_step: 'Đã lưu khung giờ hàng đợi; chưa đăng gì. Dùng use_queue trong create_social_post / publish_social_draft để đặt bài vào khung trống.',
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      const st = (err as { status?: number }).status;
      if (typeof st === 'number' && st < 500) throw new ToolUserError((err as Error).message);
      throw err;
    }
  },
};

const snippetForAi = (r: { id: number; kind: string; name: string; content: string; is_default: boolean }) => ({ id: r.id, name: r.name, content: r.content, is_default: r.is_default });

export const listSocialSnippetsTool: ToolDef = {
  name: 'list_social_snippets',
  title: 'Bộ hashtag và chữ ký / List social snippets',
  description:
    'Các mẫu chữ công ty đã lưu trong Trinity để dùng lại khi soạn bài đăng đa kênh: bộ hashtag (hashtags) và chữ ký cuối bài (signature), mỗi mẫu có id, tên, nội dung, is_default (chữ ký mặc định). Khi người dùng nhờ ("thêm bộ hashtag khai giảng", "kèm chữ ký") thì nối nội dung mẫu vào cuối nội dung bài trước khi tạo bài hoặc lưu nháp. Chỉ đọc. / ' +
    'Reusable text snippets saved in Trinity for social posts, grouped by kind: hashtag sets and signatures, each with id, name, content and is_default. When the user asks (e.g. "add the opening-day hashtags", "with the signature"), append the snippet content to the end of the post text before creating a post or saving a draft. Read-only.',
  permissions: ['social.post'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps }) {
    const s = await socialDeps(deps);
    const rows = await s.snippets.list();
    const out = wrapData({
      hashtags: rows.filter((r) => r.kind === 'hashtags').map(snippetForAi),
      signatures: rows.filter((r) => r.kind === 'signature').map(snippetForAi),
    });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const saveSocialSnippetTool: ToolDef = {
  name: 'save_social_snippet',
  title: 'Lưu bộ hashtag / chữ ký / Save social snippet',
  description:
    'Lưu một mẫu chữ dùng lại khi soạn bài: bỏ trống snippet_id = tạo mẫu mới (cần kind, name, content); có snippet_id (từ list_social_snippets) = sửa mẫu đó, trường nào bỏ trống thì giữ như cũ và không đổi được kind. kind = hashtags (bộ hashtag; Trinity tự thêm # còn thiếu và bỏ trùng) hoặc signature (chữ ký cuối bài). name tối đa 80 ký tự, content tối đa 2000. is_default = true đặt chữ ký làm mặc định (tự điền vào bài mới ở web; chữ ký mặc định cũ bị bỏ cờ); chỉ dùng cho chữ ký. Không đăng gì ra mạng xã hội. Không có công cụ xoá mẫu — xoá ở màn Đăng đa kênh. Cần scope crm.write. / ' +
    'Saves a reusable snippet for social posts: without snippet_id a new one is created (kind, name, content required); with snippet_id only the fields sent change and kind cannot change. kind = hashtags (missing # added, duplicates removed) or signature. name up to 80 chars, content up to 2000. is_default = true makes a signature the default (pre-filled in new posts on the web; the previous default is cleared); signatures only. Nothing is published. There is no delete tool.',
  permissions: ['social.post'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    snippet_id: z.number().int().min(1).max(2_147_483_647).optional().describe('id mẫu cần sửa (list_social_snippets); bỏ trống = tạo mới / Snippet to update; omit to create'),
    kind: z.enum(['hashtags', 'signature']).optional().describe('hashtags = bộ hashtag, signature = chữ ký; bắt buộc khi tạo / Required when creating'),
    name: z.string().max(80).optional().describe('Tên mẫu, vd "Khai giảng" / Snippet name'),
    content: z.string().max(2000).optional().describe('Nội dung mẫu / Snippet text'),
    is_default: z.boolean().optional().describe('true = chữ ký mặc định cho bài mới (chỉ chữ ký) / Default signature'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const s = await socialDeps(deps);
    const id = args.snippet_id === undefined ? undefined : optInt(args.snippet_id);
    if (args.snippet_id !== undefined && !id) throw new ToolUserError('snippet_id không hợp lệ.');
    const input: { kind?: string; name?: string; content?: string; is_default?: boolean } = {};
    if (typeof args.kind === 'string') input.kind = args.kind;
    if (typeof args.name === 'string') input.name = args.name;
    if (typeof args.content === 'string') input.content = args.content;
    if (typeof args.is_default === 'boolean') input.is_default = args.is_default;
    try {
      const saved = id ? await s.snippets.update(id, input) : await s.snippets.create(principal.user, input);
      const out = wrapData({
        kind: saved.kind,
        ...snippetForAi(saved),
        next_step: 'Mẫu ĐÃ LƯU; chưa đăng gì. Dùng list_social_snippets để lấy lại khi soạn bài.',
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      const st = (err as { status?: number }).status;
      if (typeof st === 'number' && st < 500) throw new ToolUserError((err as Error).message);
      throw err;
    }
  },
};

export const getSocialPostStatsTool: ToolDef = {
  name: 'get_social_post_stats',
  title: 'Thống kê bài đăng mạng xã hội / Social post stats',
  description:
    'Thống kê các bài công ty đã đăng qua Trinity lên Fanpage Facebook / kênh YouTube: tổng số bài, lượt xem, cảm xúc (Facebook) hoặc lượt thích (YouTube), bình luận, chia sẻ; tách theo từng kênh; và các bài tương tác cao nhất (tương tác = cảm xúc/thích + bình luận + chia sẻ). ' +
    'Dùng khi người dùng hỏi bài nào hiệu quả, tuần/tháng này đăng được bao nhiêu, kênh nào tốt hơn. Tính theo ngày bài lên mạng (giờ Việt Nam); bỏ trống from/to = 30 ngày gần nhất; from/to dạng YYYY-MM-DD, tối đa 92 ngày. ' +
    'Số do Trinity lấy tự động mỗi 1–6 giờ (xem updated_at); views = null nghĩa là mạng không cung cấp lượt xem cho loại bài đó (bài chữ/ảnh Facebook), không phải 0. posts_removed_on_channel = số bài đã bị xoá trên kênh (removed = true ở top_posts; số là lần lấy cuối) — báo người dùng là bài đã bị xoá, đừng nói là lỗi lấy số. Chỉ đọc. / ' +
    'Stats for posts published through Trinity to the Facebook Page / YouTube channel: totals (posts, views, reactions or likes, comments, shares), per channel, and top posts by engagement (reactions + comments + shares). ' +
    'By publish date (Vietnam time); default last 30 days; from/to YYYY-MM-DD, max 92 days. Numbers refresh automatically every 1–6 hours (see updated_at); views = null means the network does not report views for that post type; posts_removed_on_channel counts posts deleted on the network. Read-only.',
  permissions: ['social.post'],
  input: (z) => ({
    from: z.string().max(10).optional().describe('Từ ngày YYYY-MM-DD; bỏ trống = 30 ngày trước / From date'),
    to: z.string().max(10).optional().describe('Đến hết ngày YYYY-MM-DD; bỏ trống = hôm nay / To date (inclusive)'),
    top: z.number().int().min(1).max(20).optional().describe('Số bài tương tác cao nhất trả về (1-20, mặc định 5) / Number of top posts'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const s = await socialDeps(deps);
    const hasFrom = typeof args.from === 'string' && args.from.trim();
    const hasTo = typeof args.to === 'string' && args.to.trim();
    // Mặc định 30 ngày gần nhất (giờ VN) thay vì "hôm nay" như các tool lịch.
    const day = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
    const range = activityRange(hasFrom ? args.from : day(Date.now() - 29 * 86_400_000), hasTo ? args.to : day(Date.now()));
    const top = optInt(args.top);
    const r = await s.posts.stats({ from: range.from, to: new Date(range.to.getTime() - 1), top: top && top <= 20 ? top : 5 });
    const out = wrapData({
      range: range.label,
      timezone: 'Asia/Ho_Chi_Minh',
      totals: r.totals,
      by_channel: r.by_account,
      top_posts: r.top.map((t) => ({ ...t, published_at: vnIso(t.published_at), trinity_url: `${baseUrl}/social?post=${t.post_id}` })),
      posts_without_numbers_yet: r.without_metrics,
      posts_removed_on_channel: r.removed,
      updated_at: vnIso(r.updated_at),
    });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/** Một trang playlist ≤ MAX_ITEMS của ai-output (mảng dài hơn bị cắt). */
const PLAYLIST_PAGE = 50;

export const listYoutubePlaylistsTool: ToolDef = {
  name: 'list_youtube_playlists',
  title: 'Playlist của kênh YouTube / List YouTube playlists',
  description:
    'Các playlist của một kênh YouTube đã liên kết (account_id từ list_social_accounts) — lấy id để đặt youtube_playlist_id khi đăng video. Tối đa 50 playlist mỗi lần; search lọc theo tên; còn nữa thì gọi lại với offset = next_offset. Chỉ đọc. / ' +
    'Playlists of a linked YouTube channel (account_id from list_social_accounts), for youtube_playlist_id when posting. Up to 50 per call; search filters by title; call again with offset = next_offset for more. Read-only.',
  permissions: ['social.post'],
  input: (z) => ({
    account_id: z.number().int().min(1).max(2_147_483_647).describe('id kênh YouTube / YouTube account id'),
    search: z.string().max(100).optional().describe('Lọc theo tên playlist (không phân biệt hoa thường) / Filter by title'),
    offset: z.number().int().min(0).max(5000).optional().describe('Bỏ qua bao nhiêu playlist đầu (lấy từ next_offset) / Skip this many'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps }) {
    const s = await socialDeps(deps);
    const id = optInt(args.account_id);
    if (!id) throw new ToolUserError('account_id không hợp lệ.');
    let playlists: Array<{ id: string; title: string }>;
    try {
      playlists = await s.posts.youtubePlaylists(id);
    } catch (e) {
      if (e instanceof BadRequestException || (e as { status?: number }).status === 404) throw new ToolUserError((e as Error).message);
      throw e;
    }
    const q = typeof args.search === 'string' ? args.search.trim().toLowerCase() : '';
    if (q) rejectDigitProbe(q); // tên playlist có thể chứa số bị che — không cho dò từng chữ số
    const matched = q ? playlists.filter((p) => p.title.toLowerCase().includes(q)) : playlists;
    const offset = typeof args.offset === 'number' ? Math.max(0, Math.trunc(args.offset)) : 0;
    const page = matched.slice(offset, offset + PLAYLIST_PAGE);
    const next = offset + PLAYLIST_PAGE < matched.length ? offset + PLAYLIST_PAGE : null;
    const out = wrapData({ account_id: id, playlists: page.map((p) => ({ playlist_id: p.id, title: p.title })), total: matched.length, offset, next_offset: next });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const refreshSocialPostMetricsTool: ToolDef = {
  name: 'refresh_social_post_metrics',
  title: 'Cập nhật số liệu một bài / Refresh social post metrics',
  description:
    'Lấy ngay lượt xem, cảm xúc/thích, bình luận, chia sẻ mới nhất của một bài đã đăng (thường tự cập nhật mỗi 1–6 giờ) và lưu lại. Trả về bài kèm số liệu; refresh_failed liệt kê kênh mạng xã hội không trả số lần này; not_refreshed liệt kê kênh vừa lấy dưới 1 phút trước nên chưa lấy lại (số của các kênh này là của lần lấy trước, metrics_updated_at cho biết lúc nào). Cần scope crm.write. / ' +
    'Fetches the latest views, reactions, comments and shares of a published post now (normally refreshed every 1–6 hours). Channels in refresh_failed (error) or not_refreshed (checked less than a minute ago) kept their previous figures.',
  permissions: ['social.post'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({ post_id: z.number().int().min(1).max(2_147_483_647).describe('id bài / Post id') }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const s = await socialDeps(deps);
    const id = optInt(args.post_id);
    if (!id) throw new ToolUserError('post_id không hợp lệ.');
    const { post, failed, throttled } = await s.posts.refreshPostMetricsReport(id);
    const view = postForAi(post, baseUrl);
    const pick = (ids: number[]) => post.targets.filter((t) => ids.includes(t.id)).map((t) => ({ target_id: t.id, account_name: t.account_name, network: t.network }));
    const refresh_failed = pick(failed);
    const not_refreshed = pick(throttled);
    const notes = [
      refresh_failed.length ? 'Một số kênh không trả số lần này — số hiện ra là của lần lấy trước.' : '',
      not_refreshed.length ? 'Một số kênh vừa được lấy số dưới 1 phút trước nên chưa lấy lại — xem metrics_updated_at; thử lại sau 1 phút.' : '',
    ].filter(Boolean);
    const out = wrapData({ ...view, refresh_failed, not_refreshed, note: notes.length ? notes.join(' ') : undefined });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const listRecurringPostsTool: ToolDef = {
  name: 'list_recurring_posts',
  title: 'Bài đăng lặp lại / List recurring posts',
  description:
    'Các lịch đăng lặp lại của công ty (hằng ngày / tuần / tháng, giờ Việt Nam): tên, nội dung, kênh, luật lặp, trạng thái (active = đang chạy, paused = tạm dừng, finished = đã hết), số bài đã tạo, 3 lần đăng tới (tính ra theo giờ Việt Nam), lỗi nếu lịch bị tạm dừng tự động (vd kênh cần liên kết lại) và vài bài gần nhất của lịch. recurrence_id dùng cho update_recurring_post / set_recurring_post_active. Chỉ đọc. / ' +
    'The company\'s recurring post schedules (daily / weekly / monthly, Vietnam time): name, text, channels, rule, status (active, paused, finished), posts created so far, the next 3 run times (computed, Vietnam time), the error if it was paused automatically (e.g. a channel needs re-linking) and its latest posts. Use recurrence_id with update_recurring_post / set_recurring_post_active. Read-only.',
  permissions: ['social.post'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps }) {
    const s = await socialDeps(deps);
    const rows = await s.recurrences.list();
    const out = wrapData({
      timezone: 'Asia/Ho_Chi_Minh',
      recurrences: rows.map((r) => ({
        recurrence_id: r.id,
        title: r.title,
        status: recurrenceStatus(r),
        rule: describeRule(r.rule),
        content: r.template.content,
        account_ids: r.template.targets.map((t) => t.account_id),
        media_count: r.template.media_keys.length,
        utm_campaign: r.template.utm?.campaign ?? null,
        starts_on: r.starts_on,
        ends_on: r.ends_on,
        max_count: r.max_count,
        posts_created: r.count,
        next_times: r.next_times.map((t) => vnWhen(new Date(t))),
        last_error: r.last_error,
        recent_posts: r.posts.map((p) => ({ post_id: p.id, status: p.status, scheduled_at: vnIso(p.scheduled_at) })),
      })),
    });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/** Bật lại kênh đã gỡ — chỉ lật cờ cấu hình, không đăng gì. Không có tool gỡ/xoá (gỡ ở giao diện). */
export const enableSocialAccountTool: ToolDef = {
  name: 'enable_social_account',
  title: 'Bật lại kênh đăng bài đã gỡ / Re-enable a removed social account',
  description:
    'Bật lại một kênh đăng bài mà người dùng từng gỡ (list_social_accounts có removed = true). account_id lấy từ list_social_accounts. Chỉ bật được khi kênh còn quyền đăng cũ; kênh gỡ xong đã xoá quyền thì báo "Liên kết lại để bật kênh này" và người dùng phải liên kết lại ở Đăng đa kênh › Kênh. Không đăng gì ra mạng xã hội. Không có công cụ gỡ kênh. Cần scope crm.write. / ' +
    'Re-enables a social account the user previously removed (removed = true in list_social_accounts). Works only while the channel still holds its posting credentials; otherwise it says to link again under Đăng đa kênh › Kênh. Nothing is published. There is no tool to remove a channel.',
  permissions: ['social.manage'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({
    account_id: z.number().int().min(1).max(2_147_483_647).describe('id kênh đã gỡ (list_social_accounts) / Removed account id'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const s = await socialDeps(deps);
    const id = optInt(args.account_id);
    if (!id) throw new ToolUserError('account_id không hợp lệ. / Invalid account_id.');
    try {
      const a = await s.accounts.enable(id);
      const out = wrapData({ account_id: a.id, network: a.network, name: a.name, status: a.status, manage_url: `${baseUrl}/social?tab=channels` });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      const st = (err as { status?: number }).status;
      if (typeof st === 'number' && st < 500) throw new ToolUserError((err as Error).message);
      throw err;
    }
  },
};

export const SOCIAL_READ_TOOLS: readonly ToolDef[] = [listSocialAccountsTool, listSocialPostsTool, getSocialPostTool, getSocialPostStatsTool, listSocialMediaTool, listYoutubePlaylistsTool, listSocialDraftsTool, listQueueSlotsTool, listSocialSnippetsTool, previewSocialPostTool, listRecurringPostsTool];

/** Ghi (lưu số liệu mới) ⇒ cần crm.write. */
export const SOCIAL_METRICS_TOOLS: readonly ToolDef[] = [refreshSocialPostMetricsTool, saveSocialDraftTool, setQueueSlotsTool, saveSocialSnippetTool, enableSocialAccountTool];
