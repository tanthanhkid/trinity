import { BadRequestException, NotFoundException } from '@nestjs/common';
import { wrapData } from '../ai-output';
import { parseScheduledAt, vnWhen } from '../actions/action-social-tools';
import { isUserConfirmation } from '../actions/user-confirmation';
import { cleanAudience, type BroadcastView } from '../../../facebook/facebook-broadcasts.service';
import { ToolUserError, type McpDeps, type ToolDef } from './tool-types';

export async function broadcastsDeps(deps: Pick<McpDeps, 'facebookBroadcasts' | 'orgFeatures'>) {
  if (!deps.facebookBroadcasts) throw new ToolUserError('Máy chủ này chưa có tính năng gửi tin hàng loạt. / Messenger broadcasts are not available on this server.');
  if (!(await deps.orgFeatures.isEnabled('facebook_page'))) {
    throw new ToolUserError('Tính năng "Fanpage Facebook" đang tắt (Cài đặt › Tính năng). / The Facebook Page feature is turned off for this workspace.');
  }
  return deps.facebookBroadcasts;
}

const MANAGE = '/connections?muc=facebook&xem=gui-hang-loat';
export const STATUS_VI: Record<string, string> = { draft: 'nháp', scheduled: 'chờ gửi', sending: 'đang gửi', done: 'đã xong', cancelled: 'đã huỷ' };

export function broadcastForAi(b: BroadcastView, baseUrl: string) {
  return {
    broadcast_id: b.id,
    name: b.name,
    page: b.page_name,
    text: b.text,
    status: b.status,
    status_text: STATUS_VI[b.status] ?? b.status,
    scheduled_at: b.scheduled_at ? vnWhen(b.scheduled_at) : null,
    recipients: b.total,
    sent: b.sent,
    failed: b.failed,
    skipped_outside_24h: b.skipped,
    filter: b.audience,
    url: `${baseUrl}${MANAGE}&luot=${b.id}`,
  };
}

export const listMessengerBroadcastsTool: ToolDef = {
  name: 'list_messenger_broadcasts',
  title: 'Các lượt gửi tin hàng loạt Messenger / List Messenger broadcasts',
  description:
    'Các lượt gửi một tin cho nhiều khách cùng lúc qua Messenger của Fanpage. Mỗi lượt có: status (draft = nháp, scheduled = chờ tới giờ gửi, sending = đang gửi, done = đã xong, cancelled = đã huỷ), ' +
    'scheduled_at (giờ gửi), recipients (số người nhận đã chốt lúc gửi), sent (đã gửi), failed (lỗi), skipped_outside_24h (bỏ qua vì khách đã quá 24 giờ không nhắn Page), problems (lý do lỗi/bỏ qua kèm số người — dựa vào đây để giải thích, đừng đoán), filter (lọc theo nguồn khách / link chat), url (màn xem trong Trinity). Chỉ đọc. / ' +
    'Messenger broadcasts of the Facebook Page with status, schedule, recipient/sent/failed/skipped counts, problems (failure reasons with counts) and url. Read-only.',
  permissions: ['integrations.webhooks'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps, baseUrl }) {
    const svc = await broadcastsDeps(deps);
    const rows = await svc.list(20);
    const broadcasts = await Promise.all(
      rows.map(async (b) => {
        if (b.failed + b.skipped === 0) return broadcastForAi(b, baseUrl);
        // Lý do lỗi / bỏ qua (gộp theo nội dung) để AI nói đúng nguyên nhân thay vì đoán.
        const reasons = new Map<string, number>();
        for (const r of await svc.recipients(b.id, 200)) if ((r.status === 'failed' || r.status === 'skipped') && r.note) reasons.set(r.note, (reasons.get(r.note) ?? 0) + 1);
        return { ...broadcastForAi(b, baseUrl), problems: [...reasons].slice(0, 5).map(([reason, count]) => ({ reason, count })) };
      }),
    );
    const out = wrapData({ broadcasts, manage_url: `${baseUrl}${MANAGE}` });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/**
 * Gửi hàng loạt — tin đi thẳng tới khách nên phải có lời đồng ý. Thiếu `confirmed_by_user` ⇒ không tạo gì, trả bản xem trước
 * (số người nhận, số khách đã quá 24h) để AI đưa người dùng xem rồi mới gọi lại.
 */
export const sendMessengerBroadcastTool: ToolDef = {
  name: 'send_messenger_broadcast',
  title: 'Gửi tin hàng loạt qua Messenger / Send Messenger broadcast',
  description:
    'Gửi một tin cho nhiều khách cùng lúc qua Messenger của Fanpage (vd báo lịch khai giảng, khuyến mãi cho khách vừa hỏi). ' +
    'LUẬT CỦA FACEBOOK: Page chỉ được nhắn khách trong 24 giờ kể từ tin cuối của khách, nên chỉ khách đã nhắn Page trong 24 giờ qua mới nhận được; khách cũ hơn tự bị bỏ qua — không có cách nào gửi cho họ ở đây. ' +
    'Cần: name (tên lượt gửi), text (nội dung; {ten} = tên khách). Tuỳ chọn: source_ids (chỉ khách thuộc các nguồn này — id lấy từ list_crm_options mục sources), chat_link_ids (chỉ khách vào chat qua các link/QR này — link_id từ list_chat_links), ' +
    'scheduled_at (giờ gửi theo giờ Việt Nam YYYY-MM-DDTHH:mm, tối đa 7 ngày tới; người nhận chốt lúc tới giờ), page_id (bỏ trống nếu chỉ có một Fanpage). ' +
    'Bước 1: gọi KHÔNG có confirmed_by_user ⇒ máy chủ không gửi gì, trả preview (eligible = số khách sẽ nhận, outside_window = số khách khớp lọc nhưng đã quá 24h, sample = vài tên). Đưa người dùng xem nội dung + số người nhận. ' +
    'Bước 2: người dùng đồng ý thì gọi lại y hệt, thêm confirmed_by_user = câu đồng ý của họ chép nguyên văn. Gửi chạy nền; tiến độ xem bằng list_messenger_broadcasts. Lượt hẹn giờ chưa tới giờ thì huỷ được bằng cancel_messenger_broadcast. Cần scope crm.write. / ' +
    'Sends one message to many Messenger customers of the Page. Only customers who messaged the Page in the last 24 hours can receive it (Facebook rule). Call once without confirmed_by_user to get a preview (eligible count, outside_window count), show the user, then call again with their approval verbatim in confirmed_by_user.',
  permissions: ['integrations.webhooks'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    name: z.string().min(1).max(120).describe('Tên lượt gửi, vd "Báo lịch khai giảng tháng 11" / Broadcast name'),
    text: z.string().min(1).max(2000).describe('Nội dung tin; {ten} = tên khách / Message text'),
    source_ids: z.array(z.number().int().min(1).max(2_147_483_647)).max(50).optional().describe('Chỉ khách thuộc các nguồn này (list_crm_options › sources) / Only contacts from these sources'),
    chat_link_ids: z.array(z.number().int().min(1).max(2_147_483_647)).max(50).optional().describe('Chỉ khách vào chat qua các link/QR này (list_chat_links) / Only customers who came via these chat links'),
    scheduled_at: z.string().max(40).optional().describe('Giờ gửi theo giờ Việt Nam YYYY-MM-DDTHH:mm, tối đa 7 ngày tới; bỏ trống = gửi ngay / Send time in Vietnam time; omit to send now'),
    page_id: z.string().max(40).optional().describe('page_id Fanpage; bỏ trống khi chỉ có một Page / Facebook Page id'),
    confirmed_by_user: z
      .string()
      .max(300)
      .optional()
      .describe(
        'Lời người dùng đồng ý gửi, chép nguyên văn (vd "ok gửi đi"), sau khi họ xem nội dung và số người nhận. Bỏ trống ở lần gọi đầu để lấy bản xem trước. / ' +
          "The user's approval words copied verbatim after seeing the text and recipient count. Omit on the first call to get a preview.",
      ),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const svc = await broadcastsDeps(deps);
    let pageId = typeof args.page_id === 'string' ? args.page_id.trim() : '';
    if (!pageId) {
      const pages = await deps.prisma.facebookPage.findMany({ where: { is_active: true }, select: { page_id: true, name: true } });
      if (pages.length !== 1) {
        throw new ToolUserError(
          pages.length
            ? `Có ${pages.length} Fanpage, cần chọn page_id: ${pages.map((p) => `${p.name} = ${p.page_id}`).join('; ')}. / Several Pages — pass page_id.`
            : 'Chưa kết nối Fanpage nào (Cài đặt › Kết nối & AI › Fanpage Facebook). / No Facebook Page linked yet.',
        );
      }
      pageId = pages[0].page_id;
    }
    const audience = cleanAudience({ source_ids: args.source_ids, chat_link_ids: args.chat_link_ids });
    let at: string | null;
    try {
      at = parseScheduledAt(args.scheduled_at);
    } catch (err) {
      throw new ToolUserError((err as Error).message);
    }
    try {
      const input = { name: String(args.name ?? ''), page_id: pageId, text: String(args.text ?? ''), audience };
      await svc.validate(input);
      svc.sendTime(at); // quá 7 ngày ⇒ báo ngay, không để tới lúc gửi
      const preview = await svc.preview(pageId, audience);
      const when = at ? `Hẹn gửi lúc ${vnWhen(new Date(at))}` : 'Gửi ngay';
      if (!isUserConfirmation(args.confirmed_by_user)) {
        const out = wrapData({
          started: false,
          preview: { ...preview, when, text: input.text },
          next_step:
            preview.eligible === 0 && !at
              ? 'Hiện không có khách nào nhắn Page trong 24 giờ qua khớp bộ lọc — gửi lúc này sẽ không ai nhận. Báo người dùng.'
              : 'CHƯA GỬI. Đưa người dùng xem nội dung, số người nhận (eligible) và số khách quá 24h không nhận được (outside_window); người dùng đồng ý thì gọi lại với confirmed_by_user.' +
                (at ? ' Người nhận chốt lúc tới giờ hẹn nên con số có thể khác.' : ''),
        });
        return { structured: out, text: JSON.stringify(out) };
      }
      const created = await svc.create(input, principal.user.userId, 'mcp');
      const b = await svc.send(created.id, at);
      if (!at) svc.kick();
      const out = wrapData({ started: true, ...broadcastForAi(b, baseUrl), expected_recipients: preview.eligible, next_step: `${when}. Tin gửi chạy nền theo lô; xem tiến độ bằng list_messenger_broadcasts hoặc mở url.` });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      if (err instanceof BadRequestException) throw new ToolUserError(err.message);
      throw err;
    }
  },
};

/**
 * Sửa lượt chưa chạy (nháp / chờ gửi): nội dung, bộ lọc, giờ gửi. Tin sẽ đi tới khách nên cũng cần `confirmed_by_user` —
 * thiếu thì không sửa gì, trả bản xem trước. Huỷ: cancel_messenger_broadcast; không có xoá.
 */
export const updateMessengerBroadcastTool: ToolDef = {
  name: 'update_messenger_broadcast',
  title: 'Sửa lượt gửi tin hàng loạt chưa gửi / Update a pending Messenger broadcast',
  description:
    'Sửa một lượt gửi tin hàng loạt Messenger CHƯA chạy (status draft hoặc scheduled; broadcast_id lấy từ list_messenger_broadcasts): đổi name, text ({ten} = tên khách), bộ lọc source_ids / chat_link_ids, giờ gửi scheduled_at (giờ Việt Nam YYYY-MM-DDTHH:mm, tối đa 7 ngày tới), hoặc send_now = true để gửi ngay. ' +
    'Chỉ gửi các trường muốn đổi. Lượt nháp mà không có scheduled_at/send_now thì vẫn là nháp. Lượt đã gửi xong/đang gửi/đã huỷ thì không sửa được. ' +
    'Bước 1: gọi KHÔNG có confirmed_by_user ⇒ không sửa gì, trả preview (nội dung mới, eligible = số khách sẽ nhận, outside_window = số khách quá 24h). Bước 2: người dùng đồng ý thì gọi lại y hệt kèm confirmed_by_user nguyên văn. Cần scope crm.write. / ' +
    'Edits a Messenger broadcast that has not run yet (draft or scheduled): name, text, audience filters, send time, or send_now. Call once without confirmed_by_user for a preview, then again with the user approval verbatim.',
  permissions: ['integrations.webhooks'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    broadcast_id: z.number().int().min(1).max(2_147_483_647).describe('broadcast_id từ list_messenger_broadcasts / Broadcast id'),
    name: z.string().min(1).max(120).optional().describe('Tên mới / New name'),
    text: z.string().min(1).max(2000).optional().describe('Nội dung mới; {ten} = tên khách / New message text'),
    source_ids: z.array(z.number().int().min(1).max(2_147_483_647)).max(50).optional().describe('Chỉ khách thuộc các nguồn này; [] = bỏ lọc / Only contacts from these sources'),
    chat_link_ids: z.array(z.number().int().min(1).max(2_147_483_647)).max(50).optional().describe('Chỉ khách vào qua các link/QR này; [] = bỏ lọc / Only customers from these chat links'),
    scheduled_at: z.string().max(40).optional().describe('Giờ gửi mới theo giờ Việt Nam YYYY-MM-DDTHH:mm / New send time (Vietnam time)'),
    send_now: z.boolean().optional().describe('true = gửi ngay / Send right away'),
    confirmed_by_user: z
      .string()
      .max(300)
      .optional()
      .describe('Lời người dùng đồng ý, chép nguyên văn, sau khi xem nội dung và số người nhận. Bỏ trống ở lần gọi đầu. / The user approval verbatim; omit on the first call.'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const svc = await broadcastsDeps(deps);
    if (typeof args.scheduled_at === 'string' && args.send_now === true) throw new ToolUserError('Chọn một: scheduled_at hoặc send_now. / Pass either scheduled_at or send_now.');
    let at: string | null = null;
    try {
      at = parseScheduledAt(args.scheduled_at);
    } catch (err) {
      throw new ToolUserError((err as Error).message);
    }
    try {
      const cur = await svc.get(Number(args.broadcast_id));
      if (cur.status !== 'draft' && cur.status !== 'scheduled') throw new ToolUserError(`Lượt này ${STATUS_VI[cur.status] ?? cur.status} — không sửa được. / This broadcast already ran or was cancelled.`);
      const input: { name?: string; text?: string; audience?: unknown } = {};
      if (typeof args.name === 'string') input.name = args.name;
      if (typeof args.text === 'string') input.text = args.text;
      if (Array.isArray(args.source_ids) || Array.isArray(args.chat_link_ids)) {
        input.audience = cleanAudience({ ...cur.audience, ...(Array.isArray(args.source_ids) ? { source_ids: args.source_ids } : {}), ...(Array.isArray(args.chat_link_ids) ? { chat_link_ids: args.chat_link_ids } : {}) });
      }
      const sendNow = args.send_now === true;
      if (!Object.keys(input).length && !at && !sendNow) throw new ToolUserError('Không có trường nào để sửa. / Nothing to change.');
      await svc.validate(input as Parameters<typeof svc.validate>[0], true);
      if (at) svc.sendTime(at);
      if (!isUserConfirmation(args.confirmed_by_user)) {
        const preview = await svc.preview(cur.page_id, input.audience ?? cur.audience);
        const when = sendNow ? 'Gửi ngay' : at ? `Hẹn gửi lúc ${vnWhen(new Date(at))}` : cur.status === 'scheduled' && cur.scheduled_at ? `Giữ giờ hẹn ${vnWhen(cur.scheduled_at)}` : 'Vẫn là nháp (chưa gửi)';
        const out = wrapData({
          saved: false,
          current: broadcastForAi(cur, baseUrl),
          preview: { ...preview, when, text: input.text ?? cur.text },
          next_step: 'CHƯA SỬA. Đưa người dùng xem nội dung, giờ gửi và số người nhận; người dùng đồng ý thì gọi lại với confirmed_by_user.',
        });
        return { structured: out, text: JSON.stringify(out) };
      }
      // Kiểm giờ gửi TRƯỚC khi sửa nội dung: hỏng giờ thì không để lại nội dung đã đổi mà giờ không đổi.
      if (at) svc.sendTime(at);
      let b = Object.keys(input).length ? await svc.update(cur.id, input as Parameters<typeof svc.update>[1]) : cur;
      if (sendNow || at) {
        b = await svc.send(cur.id, sendNow ? null : at);
        if (sendNow) svc.kick();
      }
      const out = wrapData({ saved: true, ...broadcastForAi(b, baseUrl) });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof NotFoundException) throw new ToolUserError(err.message);
      throw err;
    }
  },
};

export const FACEBOOK_BROADCAST_TOOLS: readonly ToolDef[] = [listMessengerBroadcastsTool, sendMessengerBroadcastTool, updateMessengerBroadcastTool];
