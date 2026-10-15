import { BadRequestException, NotFoundException } from '@nestjs/common';
import { wrapData } from '../ai-output';
import { isUserConfirmation } from '../actions/user-confirmation';
import { cleanList, normalizePostId, postLink, type CommentRuleInput } from '../../../facebook/facebook-comments.service';
import { activityRange, vnIso } from './ai-activity-tool';
import { ToolUserError, clampLimit, type McpDeps, type ToolDef } from './tool-types';

const STATUSES = ['received', 'done', 'test', 'skipped', 'failed'] as const;

async function commentsDeps(deps: Pick<McpDeps, 'facebookComments' | 'orgFeatures'>) {
  if (!deps.facebookComments) throw new ToolUserError('Máy chủ này chưa có tính năng bình luận Fanpage. / Facebook comment automation is not available on this server.');
  if (!(await deps.orgFeatures.isEnabled('facebook_page'))) {
    throw new ToolUserError('Tính năng "Fanpage Facebook" đang tắt (Cài đặt › Tính năng). / The Facebook Page feature is turned off for this workspace.');
  }
  return deps.facebookComments;
}

/** id bài dạng <page>_<post> ⇒ link (khoá `post_link` được giữ nguyên khi che số). */
const linkOf = (postId: string | null) => (postId && /^\d+_\d+$/.test(postId) ? postLink(postId) : null);

const RULES_URL = '/settings?tab=integrations&muc=facebook&xem=binh-luan';

type RuleRow = Awaited<ReturnType<NonNullable<McpDeps['facebookComments']>['listRules']>>[number];

async function pageNames(deps: Pick<McpDeps, 'prisma'>) {
  const pages = await deps.prisma.facebookPage.findMany({ select: { page_id: true, name: true } });
  return new Map(pages.map((p) => [p.page_id, p.name]));
}

function ruleForAi(r: RuleRow, names: Map<string, string>) {
  return {
    rule_id: r.id,
    name: r.name,
    page: r.page_id ? (names.get(r.page_id) ?? 'Page không còn kết nối') : 'Mọi Page',
    post_link: linkOf(r.post_id),
    all_posts: !r.post_id,
    keywords: r.keywords,
    exclude_keywords: r.exclude_keywords,
    public_replies: r.public_replies,
    private_reply: r.private_reply,
    hide_if_phone: r.hide_if_phone,
    once_per_user: r.once_per_user,
    mode: r.mode,
    is_active: r.is_active,
    position: r.position,
  };
}

export const listFacebookCommentsTool: ToolDef = {
  name: 'list_facebook_comments',
  title: 'Bình luận trên Fanpage / List Facebook Page comments',
  description:
    'Bình luận khách để lại dưới bài của các Fanpage đã kết nối với Trinity, kèm việc Trinity đã tự làm theo luật bình luận tự động: trả lời công khai, nhắn riêng qua Messenger, ẩn bình luận có SĐT, khách hàng đã tạo/ghép (contact_id). ' +
    'status: received = không luật nào khớp; done = đã làm; test = luật ở chế độ thử, chỉ ghi lại việc sẽ làm; skipped = bỏ qua (đã trả lời người này ở bài này); failed = Facebook từ chối (xem note). ' +
    'Mặc định hôm nay theo giờ Việt Nam; from/to dạng YYYY-MM-DD, tối đa 92 ngày. Chỉ đọc. / ' +
    'Comments left on posts of the Facebook Pages linked to Trinity, with what Trinity did automatically (public reply, private Messenger reply, hiding comments with phone numbers, linked contact). Defaults to today (Vietnam time). Read-only.',
  permissions: ['integrations.webhooks'],
  input: (z) => ({
    from: z.string().max(10).optional().describe('Từ ngày YYYY-MM-DD; bỏ trống = hôm nay / From date'),
    to: z.string().max(10).optional().describe('Đến hết ngày YYYY-MM-DD / To date (inclusive)'),
    status: z.enum(STATUSES).optional().describe('Lọc theo kết quả xử lý / Filter by outcome'),
    limit: z.number().int().min(1).max(50).optional().describe('Số bình luận tối đa (1-50, mặc định 20) / Max comments'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const svc = await commentsDeps(deps);
    const range = activityRange(args.from, args.to);
    const status = typeof args.status === 'string' && (STATUSES as readonly string[]).includes(args.status) ? args.status : undefined;
    const rows = (await svc.listComments({ limit: 100, status, since: range.from })).filter((r) => r.created_at < range.to).slice(0, clampLimit(args.limit));
    const out = wrapData({
      range: range.label,
      timezone: 'Asia/Ho_Chi_Minh',
      comments: rows.map((r) => ({
        page: r.page_name,
        post_link: linkOf(r.post_id),
        from_name: r.from_name,
        message: r.message,
        commented_at: vnIso(r.commented_at),
        status: r.status,
        rule: r.rule_name,
        actions: r.actions,
        note: r.note,
        hidden: r.hidden,
        contact_id: r.contact_id,
        contact_url: r.contact_id ? `${baseUrl}/contacts/${r.contact_id}` : null,
      })),
      manage_url: `${baseUrl}${RULES_URL}`,
    });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const listFacebookCommentRulesTool: ToolDef = {
  name: 'list_facebook_comment_rules',
  title: 'Luật tự xử lý bình luận Fanpage / List comment automation rules',
  description:
    'Các luật bình luận tự động (kiểu ManyChat): bình luận chứa một trong keywords (không phân biệt hoa thường, dấu; rỗng = mọi bình luận) và không chứa exclude_keywords ⇒ trả lời công khai một câu ngẫu nhiên trong public_replies + nhắn riêng private_reply qua Messenger ({ten} = tên người bình luận); hide_if_phone = ẩn bình luận có SĐT. ' +
    'Phạm vi: page (rỗng = mọi Page), post_link (rỗng = mọi bài). mode: test = chỉ ghi lại, live = gửi thật. Luật xét theo position tăng dần, khớp luật đầu tiên. Thêm luật bằng create_comment_rule, sửa/bật/tắt bằng update_comment_rule, thử với bình luận mẫu bằng test_comment_rule. Chỉ đọc. / ' +
    'Comment automation rules (ManyChat-style keyword triggers with public reply + private reply). Use create_comment_rule / update_comment_rule / test_comment_rule to change or try them. Read-only.',
  permissions: ['integrations.webhooks'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps, baseUrl }) {
    const svc = await commentsDeps(deps);
    const rules = await svc.listRules();
    const names = await pageNames(deps);
    const out = wrapData({
      rules: rules.map((r) => ruleForAi(r, names)),
      manage_url: `${baseUrl}${RULES_URL}`,
    });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/** Trường chung của create/update luật — mô tả song ngữ, không có trường xoá. */
function ruleFields(z: Parameters<ToolDef['input']>[0]) {
  return {
    page_id: z.string().max(40).nullable().optional().describe('page_id Fanpage áp luật; bỏ trống/null = mọi Page / Facebook Page id, null = all Pages'),
    post_link: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe('Link hoặc id bài áp luật (dạng .../posts/<số> hoặc <page>_<post>); bỏ trống/null = mọi bài / Post link or id; null = all posts'),
    keywords: z.array(z.string().min(1).max(100)).max(50).optional().describe('Bình luận chứa MỘT trong các từ này thì khớp (không phân biệt dấu); rỗng = mọi bình luận / Trigger keywords; empty = every comment'),
    exclude_keywords: z.array(z.string().min(1).max(100)).max(50).optional().describe('Có một trong các từ này thì bỏ qua / Skip comments containing these'),
    public_replies: z.array(z.string().min(1).max(1000)).max(10).optional().describe('Các câu trả lời công khai dưới bình luận, chọn ngẫu nhiên một câu; {ten} = tên người bình luận; rỗng = không trả lời công khai / Public replies (one picked at random)'),
    private_reply: z.string().max(2000).nullable().optional().describe('Tin nhắn riêng gửi qua Messenger cho người bình luận; {ten} = tên; null = không nhắn / Private Messenger reply'),
    hide_if_phone: z.boolean().optional().describe('Ẩn bình luận có số điện thoại để người khác không thấy / Hide comments that contain a phone number'),
    once_per_user: z.boolean().optional().describe('Mỗi người chỉ xử lý một lần mỗi bài (mặc định có) / Handle each person once per post'),
    mode: z.enum(['test', 'live']).optional().describe('test = chỉ ghi lại việc sẽ làm, không gửi gì; live = trả lời/nhắn/ẩn thật trên Facebook / test only records, live acts on Facebook'),
    position: z.number().int().min(0).max(100000).optional().describe('Thứ tự xét (nhỏ xét trước, khớp luật đầu tiên) / Evaluation order'),
  };
}

const CONFIRM_PARAM_DESC =
  'Lời người dùng đồng ý cho luật chạy thật (mode live và đang bật), chép nguyên văn (vd "ok bật đi"), sau khi họ xem các câu trả lời. Bỏ trống ở lần gọi đầu để lấy bản xem trước. / ' +
  "The user's approval copied verbatim, needed when the rule ends up live and active. Omit on the first call to get a preview.";

/** Đầu vào tool ⇒ CommentRuleInput (chỉ trường AI gửi; trường thiếu giữ nguyên khi sửa). */
function ruleInput(args: Record<string, unknown>): Partial<CommentRuleInput> {
  const d: Partial<CommentRuleInput> = {};
  if (typeof args.name === 'string') d.name = args.name;
  if (args.page_id !== undefined) d.page_id = typeof args.page_id === 'string' ? args.page_id : null;
  if (args.post_link !== undefined) d.post_id = typeof args.post_link === 'string' ? args.post_link : null;
  for (const k of ['keywords', 'exclude_keywords', 'public_replies'] as const) if (Array.isArray(args[k])) d[k] = args[k] as string[];
  if (args.private_reply !== undefined) d.private_reply = typeof args.private_reply === 'string' ? args.private_reply : null;
  for (const k of ['hide_if_phone', 'once_per_user'] as const) if (typeof args[k] === 'boolean') d[k] = args[k] as boolean;
  if (args.mode === 'test' || args.mode === 'live') d.mode = args.mode;
  if (typeof args.active === 'boolean') d.is_active = args.active;
  if (typeof args.position === 'number') d.position = args.position;
  return d;
}

/** Luật chạy thật trên Fanpage (trả lời công khai, nhắn riêng, ẩn bình luận) ⇒ cần lời đồng ý. */
const goesLive = (r: { mode: string; is_active: boolean }) => r.mode === 'live' && r.is_active;

function toolError(err: unknown): never {
  if (err instanceof BadRequestException || err instanceof NotFoundException) throw new ToolUserError(err.message);
  throw err;
}

/** Link bài đọc không được ⇒ báo ngay, đừng để người dùng duyệt bản xem trước rồi mới hỏng lúc lưu. */
function checkPostLink(postId: string | null | undefined, pageId: string | null) {
  if (!postId) return;
  let id: string | null = null;
  try {
    id = normalizePostId(postId, pageId);
  } catch (err) {
    toolError(err);
  }
  // id bài dạng <page>_<bài>: Page phải khớp Page của luật, không thì luật không bao giờ chạy.
  if (id && pageId && !id.startsWith(`${pageId}_`)) {
    throw new ToolUserError('Bài này thuộc Fanpage khác với page_id của luật. Chọn đúng Page của bài, hoặc bỏ page_id. / The post belongs to another Page.');
  }
}

/** page_id gửi lên phải là Fanpage đang kết nối. */
async function checkPage(deps: Pick<McpDeps, 'prisma'>, pageId: string | null | undefined) {
  if (!pageId) return;
  const p = await deps.prisma.facebookPage.findUnique({ where: { page_id: pageId }, select: { page_id: true } });
  if (!p) throw new ToolUserError(`Không có Fanpage page_id = ${pageId} đã kết nối. / Unknown page_id.`);
}

function needApproval(preview: Record<string, unknown>) {
  const out = wrapData({
    saved: false,
    preview,
    next_step:
      'CHƯA LƯU. Luật này sẽ trả lời/nhắn/ẩn bình luận THẬT trên Fanpage. Đưa người dùng xem từ khoá, câu trả lời công khai, tin nhắn riêng; người dùng đồng ý thì gọi lại y hệt với confirmed_by_user. ' +
      'Muốn thử trước thì đặt mode = "test" (không cần đồng ý) hoặc dùng test_comment_rule.',
  });
  return { structured: out, text: JSON.stringify(out) };
}

/** Thêm luật — GHI THẲNG khi ở chế độ thử; chạy thật (live + bật) cần confirmed_by_user. Không có tool xoá (xoá ở giao diện). */
export const createCommentRuleTool: ToolDef = {
  name: 'create_comment_rule',
  title: 'Thêm luật tự xử lý bình luận Fanpage / Create comment automation rule',
  description:
    'Thêm một luật xử lý bình luận dưới bài Fanpage (kiểu ManyChat): bình luận khớp keywords ⇒ trả lời công khai (public_replies), nhắn riêng qua Messenger (private_reply), và/hoặc ẩn bình luận có SĐT (hide_if_phone). ' +
    'Cần name và ít nhất một việc (public_replies, private_reply hoặc hide_if_phone). Phạm vi: page_id (bỏ trống = mọi Page), post_link (bỏ trống = mọi bài). ' +
    'mode mặc định "test": chỉ ghi lại việc sẽ làm (xem bằng list_facebook_comments, status=test), không gửi gì ra Facebook — dùng cho tới khi người dùng muốn chạy thật. ' +
    'mode "live" (và active, mặc định bật) thì gọi lần đầu KHÔNG có confirmed_by_user để lấy bản xem trước, đưa người dùng xem, rồi gọi lại kèm câu đồng ý nguyên văn. Kết quả có manage_url. Cần scope crm.write. / ' +
    'Adds a Facebook Page comment automation rule (keywords ⇒ public reply, private Messenger reply, hide comments with phone numbers). Defaults to mode "test" (records only). A live, active rule needs confirmed_by_user after the user sees a preview.',
  permissions: ['integrations.webhooks'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    name: z.string().min(1).max(120).describe('Tên luật, vd "Hỏi giá khoá học" / Rule name'),
    ...ruleFields(z),
    active: z.boolean().optional().describe('Bật luật (mặc định bật) / Rule enabled (default true)'),
    confirmed_by_user: z.string().max(300).optional().describe(CONFIRM_PARAM_DESC),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const svc = await commentsDeps(deps);
    const input = ruleInput(args);
    if (!cleanList(input.public_replies).length && !input.private_reply?.trim() && !input.hide_if_phone) {
      throw new ToolUserError('Luật cần ít nhất một việc: public_replies, private_reply hoặc hide_if_phone = true. / The rule needs at least one action.');
    }
    const final = { mode: input.mode ?? 'test', is_active: input.is_active ?? true };
    await checkPage(deps, input.page_id);
    checkPostLink(input.post_id, input.page_id ?? null);
    if (goesLive(final) && !isUserConfirmation(args.confirmed_by_user)) return needApproval({ ...input, ...final });
    try {
      const r = await svc.createRule({ ...input, name: input.name ?? '', mode: final.mode, is_active: final.is_active }, principal.user.userId);
      const out = wrapData({
        saved: true,
        rule: ruleForAi(r, await pageNames(deps)),
        next_step: goesLive(r) ? 'Luật đang chạy thật.' : r.mode === 'test' ? 'Luật ở chế độ thử: chỉ ghi lại việc sẽ làm. Khi người dùng muốn chạy thật thì dùng update_comment_rule đặt mode = "live".' : 'Luật đang tắt.',
        manage_url: `${baseUrl}${RULES_URL}`,
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      toolError(err);
    }
  },
};

/** Sửa / bật / tắt luật — tắt hoặc về chế độ thử ghi thẳng; kết quả chạy thật cần confirmed_by_user. */
export const updateCommentRuleTool: ToolDef = {
  name: 'update_comment_rule',
  title: 'Sửa, bật, tắt luật bình luận Fanpage / Update comment automation rule',
  description:
    'Sửa một luật xử lý bình luận Fanpage (rule_id lấy từ list_facebook_comment_rules): đổi từ khoá, câu trả lời, tin nhắn riêng, ẩn SĐT, phạm vi bài/Page, thứ tự; active=false để tắt, active=true để bật; mode "test"/"live" để chuyển chế độ thử/chạy thật. ' +
    'Chỉ gửi các trường muốn đổi, trường bỏ trống giữ nguyên; danh sách (keywords, public_replies…) gửi là thay cả danh sách. ' +
    'Tắt luật hoặc đặt mode "test" thì lưu ngay. Nếu sau khi sửa luật đang bật ở mode "live" (trừ khi chỉ đổi tên/thứ tự) thì gọi lần đầu KHÔNG có confirmed_by_user để lấy bản xem trước, người dùng đồng ý rồi gọi lại kèm câu đồng ý nguyên văn. Cần scope crm.write. / ' +
    'Updates a comment automation rule by rule_id: change keywords, replies, hide-phone, scope, order; active=false/true to turn it off/on; mode test/live. Only send fields to change. Turning off or switching to test saves directly; a resulting live, active rule needs confirmed_by_user.',
  permissions: ['integrations.webhooks'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({
    rule_id: z.number().int().min(1).max(2_147_483_647).describe('rule_id từ list_facebook_comment_rules / Rule id'),
    name: z.string().min(1).max(120).optional().describe('Tên mới / New name'),
    ...ruleFields(z),
    active: z.boolean().optional().describe('false = tắt luật, true = bật / Turn the rule off or on'),
    confirmed_by_user: z.string().max(300).optional().describe(CONFIRM_PARAM_DESC),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const svc = await commentsDeps(deps);
    const id = Number(args.rule_id);
    const cur = (await svc.listRules()).find((r) => r.id === id);
    if (!cur) throw new ToolUserError(`Không có luật rule_id = ${id}. Xem list_facebook_comment_rules. / No rule with this id.`);
    const input = ruleInput(args);
    const changed = Object.keys(input);
    if (!changed.length) throw new ToolUserError('Không có trường nào để sửa. / Nothing to change.');
    const final = { mode: input.mode ?? cur.mode, is_active: input.is_active ?? cur.is_active };
    const cosmetic = changed.every((k) => k === 'name' || k === 'position');
    const pageId = input.page_id !== undefined ? (input.page_id ?? null) : cur.page_id;
    if (input.page_id !== undefined) await checkPage(deps, input.page_id);
    checkPostLink(input.post_id, pageId);
    // Link dạng /posts/<số> cần Page để ghép id: chuẩn hoá ở đây theo Page hiệu lực (service chỉ thấy Page khi có gửi kèm).
    if (input.post_id) input.post_id = normalizePostId(input.post_id, pageId);
    // Luật đang bật mà sửa xong không còn việc nào ⇒ nó vẫn "khớp trước" và nuốt bình luận của luật sau.
    const after = {
      public_replies: input.public_replies !== undefined ? cleanList(input.public_replies) : cur.public_replies,
      private_reply: input.private_reply !== undefined ? input.private_reply : cur.private_reply,
      hide_if_phone: input.hide_if_phone ?? cur.hide_if_phone,
    };
    if (final.is_active && !after.public_replies.length && !after.private_reply?.trim() && !after.hide_if_phone) {
      throw new ToolUserError('Sau khi sửa luật không còn việc nào (public_replies, private_reply, hide_if_phone). Giữ ít nhất một việc, hoặc tắt luật (active=false). / The rule would have no action left.');
    }
    // Luật áp cho một bài mà đổi Page: id bài cũ dạng <page cũ>_<bài> sẽ không bao giờ khớp ⇒ bắt chọn lại bài.
    if (input.page_id !== undefined && (input.page_id ?? null) !== cur.page_id && cur.post_id && input.post_id === undefined) {
      throw new ToolUserError('Luật đang áp cho một bài cụ thể; đổi Page thì gửi kèm post_link của bài trên Page mới, hoặc post_link = null để áp mọi bài. / Changing the page of a post-scoped rule needs post_link too.');
    }
    if (goesLive(final) && !cosmetic && !isUserConfirmation(args.confirmed_by_user)) return needApproval({ rule_id: id, current: ruleForAi(cur, await pageNames(deps)), changes: input });
    try {
      const r = await svc.updateRule(id, input);
      const out = wrapData({ saved: true, rule: ruleForAi(r, await pageNames(deps)), manage_url: `${baseUrl}${RULES_URL}` });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      toolError(err);
    }
  },
};

/** Thử luật với một bình luận mẫu — KHÔNG ghi gì, KHÔNG gửi gì. */
export const testCommentRuleTool: ToolDef = {
  name: 'test_comment_rule',
  title: 'Thử luật bình luận với câu mẫu / Try comment rules on a sample comment',
  description:
    'Chạy thử các luật bình luận với một bình luận mẫu để xem luật nào khớp và Trinity sẽ làm gì (câu trả lời công khai, tin nhắn riêng, có ẩn vì SĐT không). Không ghi gì, không gửi gì ra Facebook. ' +
    'Tuỳ chọn page_id, post_link (để xét luật theo bài), from_name (tên người bình luận mẫu, thay vào {ten}). Chỉ đọc. / ' +
    'Dry-runs the comment rules against a sample comment and returns the matched rule and planned actions. Nothing is saved or sent. Read-only.',
  permissions: ['integrations.webhooks'],
  input: (z) => ({
    message: z.string().min(1).max(5000).describe('Nội dung bình luận mẫu / Sample comment text'),
    page_id: z.string().max(40).optional().describe('page_id Fanpage; bỏ trống = Page đầu tiên / Facebook Page id'),
    post_link: z.string().max(500).optional().describe('Link hoặc id bài / Post link or id'),
    from_name: z.string().max(120).optional().describe('Tên người bình luận mẫu / Sample commenter name'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps }) {
    const svc = await commentsDeps(deps);
    const pageId = typeof args.page_id === 'string' && args.page_id.trim() ? args.page_id.trim() : null;
    try {
      const postId = typeof args.post_link === 'string' ? normalizePostId(args.post_link, pageId) : null;
      const r = await svc.dryRun({ message: String(args.message ?? ''), page_id: pageId, post_id: postId, from_name: typeof args.from_name === 'string' ? args.from_name : null });
      const out = wrapData({
        ...r,
        note: r.matched_rule ? (r.matched_rule.mode === 'test' ? 'Luật khớp đang ở chế độ thử — khi có bình luận thật chỉ ghi lại, không gửi.' : 'Luật khớp đang chạy thật.') : 'Không luật nào khớp — bình luận này sẽ không được xử lý.',
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      toolError(err);
    }
  },
};

export const FACEBOOK_COMMENT_TOOLS: readonly ToolDef[] = [
  listFacebookCommentsTool,
  listFacebookCommentRulesTool,
  createCommentRuleTool,
  updateCommentRuleTool,
  testCommentRuleTool,
];
