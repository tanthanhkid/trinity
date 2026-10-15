import { BadRequestException, NotFoundException } from '@nestjs/common';
import { wrapData } from '../ai-output';
import { isUserConfirmation } from '../actions/user-confirmation';
import { socialDeps } from './social-tools';
import { ToolUserError, type McpDeps, type ToolDef } from './tool-types';

/**
 * Đánh giá Google của địa điểm Google Business đã liên kết ở màn Đăng đa kênh. Đọc thẳng từ Google (không lưu bản sao);
 * trả lời là công khai ⇒ hai bước (xem trước → `confirmed_by_user`).
 */
const MANAGE = '/social?tab=channels';

/** account_id bỏ trống ⇒ dùng địa điểm duy nhất; nhiều địa điểm thì liệt kê để chọn. */
async function gbpAccount(deps: Pick<McpDeps, 'social' | 'orgFeatures'>, accountId: unknown) {
  const s = await socialDeps(deps);
  const places = (await s.accounts.list()).filter((a) => a.network === 'google_business');
  if (typeof accountId === 'number') {
    const a = places.find((p) => p.id === accountId);
    if (!a) throw new ToolUserError(`account_id ${accountId} không phải địa điểm Google Business đã liên kết. / Not a linked Google Business location.`);
    return { s, a };
  }
  if (places.length !== 1) {
    throw new ToolUserError(
      places.length
        ? `Có ${places.length} địa điểm Google, cần chọn account_id: ${places.map((p) => `${p.name} = ${p.id}`).join('; ')}. / Several locations — pass account_id.`
        : 'Chưa liên kết địa điểm Google Business nào (Đăng đa kênh › Kênh). / No Google Business location linked yet.',
    );
  }
  return { s, a: places[0] };
}

/** Tìm đánh giá qua các trang (Google trả 50/trang, mới cập nhật trước), bắt đầu từ `pageToken` nếu có; tối đa 40 trang (2.000 đánh giá). */
async function findReview(s: Awaited<ReturnType<typeof socialDeps>>, accountId: number, reviewId: string, pageToken?: string) {
  let token: string | undefined = pageToken;
  for (let i = 0; i < 40; i++) {
    const page = await s.posts.gbpReviews(accountId, token);
    const hit = page.reviews.find((x) => x.id === reviewId);
    if (hit) return hit;
    if (!page.next_page_token) return null;
    token = page.next_page_token;
  }
  return null;
}

function toolError(err: unknown): never {
  if (err instanceof BadRequestException || err instanceof NotFoundException) throw new ToolUserError(err.message);
  throw err;
}

export const listGoogleReviewsTool: ToolDef = {
  name: 'list_google_reviews',
  title: 'Đánh giá Google của địa điểm / List Google reviews',
  description:
    'Đánh giá của khách trên Google (Google Maps / Google Business) cho địa điểm công ty đã liên kết ở màn Đăng đa kênh, mới cập nhật trước, 50 đánh giá mỗi trang: review_id, reviewer, stars (1–5), comment, created_at, reply (câu trả lời của công ty nếu đã có). ' +
    'Kèm average (điểm trung bình) và total. account_id bỏ trống nếu chỉ có một địa điểm; next_page_token để lấy trang sau. Chỉ đọc. / ' +
    'Customer reviews on Google for the linked Google Business location, newest first (50 per page): review_id, reviewer, stars, comment, existing reply, plus average rating and total. Read-only.',
  permissions: ['social.post'],
  input: (z) => ({
    account_id: z.number().int().min(1).max(2_147_483_647).optional().describe('id địa điểm từ list_social_accounts (network google_business) / Location account id'),
    page_token: z.string().max(500).optional().describe('next_page_token của trang trước / Next page token'),
    unanswered_only: z.boolean().optional().describe('Chỉ đánh giá chưa trả lời / Only reviews without a reply'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const { s, a } = await gbpAccount(deps, args.account_id);
    try {
      const r = await s.posts.gbpReviews(a.id, typeof args.page_token === 'string' && args.page_token ? args.page_token : undefined);
      const reviews = args.unanswered_only === true ? r.reviews.filter((x) => !x.reply) : r.reviews;
      const out = wrapData({
        location: a.name,
        account_id: a.id,
        average: r.average,
        total: r.total,
        reviews: reviews.map((x) => ({ review_id: x.id, reviewer: x.reviewer, stars: x.stars, comment: x.comment, created_at: x.created_at, reply: x.reply })),
        next_page_token: r.next_page_token,
        manage_url: `${baseUrl}${MANAGE}`,
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      toolError(err);
    }
  },
};

export const replyToGoogleReviewTool: ToolDef = {
  name: 'reply_to_google_review',
  title: 'Trả lời đánh giá Google / Reply to a Google review',
  description:
    'Trả lời công khai một đánh giá Google của địa điểm (review_id từ list_google_reviews); đánh giá đã có câu trả lời thì câu mới thay câu cũ. Câu trả lời hiện công khai trên Google Maps dưới tên công ty. ' +
    'Bước 1: gọi KHÔNG có confirmed_by_user ⇒ không gửi gì, trả bản xem trước (đánh giá + câu trả lời). Bước 2: người dùng đồng ý thì gọi lại y hệt kèm confirmed_by_user là câu đồng ý chép nguyên văn. Cần scope crm.write. / ' +
    'Publicly replies to a Google review (replaces an existing reply). Call once without confirmed_by_user for a preview, then again with the user approval verbatim.',
  permissions: ['social.post'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({
    review_id: z.string().min(1).max(200).describe('review_id từ list_google_reviews / Review id'),
    comment: z.string().min(1).max(4000).describe('Câu trả lời / Reply text'),
    account_id: z.number().int().min(1).max(2_147_483_647).optional().describe('id địa điểm; bỏ trống nếu chỉ có một / Location account id'),
    page_token: z.string().max(500).optional().describe('page_token đã dùng khi list_google_reviews trả đánh giá này (nếu ở trang sau) / Page token of the page that listed this review'),
    confirmed_by_user: z
      .string()
      .max(300)
      .optional()
      .describe('Lời người dùng đồng ý gửi, chép nguyên văn, sau khi xem câu trả lời. Bỏ trống ở lần gọi đầu. / The user approval verbatim; omit on the first call.'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const { s, a } = await gbpAccount(deps, args.account_id);
    const reviewId = String(args.review_id ?? '').trim();
    const comment = String(args.comment ?? '').trim();
    if (!comment) throw new ToolUserError('Nhập câu trả lời. / Reply text is required.');
    try {
      if (!isUserConfirmation(args.confirmed_by_user)) {
        const review = await findReview(s, a.id, reviewId, typeof args.page_token === 'string' && args.page_token ? args.page_token : undefined);
        if (!review) throw new ToolUserError(`Không tìm thấy đánh giá review_id = ${reviewId} của ${a.name}. Lấy lại review_id bằng list_google_reviews. / Review not found.`);
        const out = wrapData({
          sent: false,
          preview: { location: a.name, review: { reviewer: review.reviewer, stars: review.stars, comment: review.comment, current_reply: review.reply?.comment ?? null }, reply: comment },
          next_step: 'CHƯA GỬI. Câu trả lời sẽ hiện công khai trên Google. Đưa người dùng xem; người dùng đồng ý thì gọi lại với confirmed_by_user.',
        });
        return { structured: out, text: JSON.stringify(out) };
      }
      await s.posts.gbpReply(a.id, reviewId, comment, principal.user);
      const out = wrapData({ sent: true, location: a.name, review_id: reviewId, reply: comment });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      toolError(err);
    }
  },
};

export const GOOGLE_REVIEW_TOOLS: readonly ToolDef[] = [listGoogleReviewsTool, replyToGoogleReviewTool];
