import { BadRequestException, NotFoundException } from '@nestjs/common';
import { wrapData } from '../ai-output';
import type { FlowInput, FlowView } from '../../../facebook/facebook-flows.service';
import { ToolUserError, type McpDeps, type ToolDef } from './tool-types';

async function flowsDeps(deps: Pick<McpDeps, 'facebookFlows' | 'orgFeatures'>) {
  if (!deps.facebookFlows) throw new ToolUserError('Máy chủ này chưa có tính năng kịch bản nhắn tin. / Messenger flows are not available on this server.');
  if (!(await deps.orgFeatures.isEnabled('facebook_page'))) {
    throw new ToolUserError('Tính năng "Fanpage Facebook" đang tắt (Cài đặt › Tính năng). / The Facebook Page feature is turned off for this workspace.');
  }
  return deps.facebookFlows;
}

const MANAGE = '/settings?tab=integrations&muc=facebook&xem=kich-ban';
const TRIGGER_VI: Record<string, string> = { keyword: 'khách nhắn có từ khoá', chat_link: 'khách vào qua link/QR', first_message: 'tin đầu tiên của khách mới' };

function flowForAi(f: FlowView, baseUrl: string) {
  return {
    flow_id: f.id,
    name: f.name,
    page: f.page_name,
    page_id: f.page_id,
    trigger: f.trigger,
    trigger_text: TRIGGER_VI[f.trigger] ?? f.trigger,
    keywords: f.trigger === 'keyword' ? f.keywords : undefined,
    chat_link: f.trigger === 'chat_link' ? { link_id: f.chat_link_id, name: f.chat_link_name } : undefined,
    active: f.is_active,
    steps: f.steps,
    started: f.starts,
    completed: f.completes,
    running_now: f.running,
    edit_url: `${baseUrl}${MANAGE}&kich-ban=${f.id}`,
  };
}

export const listMessageFlowsTool: ToolDef = {
  name: 'list_message_flows',
  title: 'Kịch bản nhắn tin Messenger / List Messenger flows',
  description:
    'Các kịch bản tự nhắn riêng nhiều bước cho khách trên Messenger của Fanpage. Mỗi kịch bản có: trigger (keyword = khách nhắn có từ khoá, chat_link = khách vào qua link/QR, first_message = tin đầu tiên của khách mới), ' +
    'active (đang bật), steps (các bước: text là nội dung tin, buttons là nút khách bấm để rẽ nhánh, ask là câu hỏi lưu SĐT/email/ghi chú, wait_minutes là chờ bao lâu rồi gửi), ' +
    'started (số lượt đã chạy), completed (số lượt đi hết), running_now (khách đang ở giữa kịch bản), edit_url (màn sửa trong Trinity). Chỉ đọc. / ' +
    'Multi-step Messenger auto-reply flows of the Facebook Page: trigger, active, steps (text, buttons, ask, wait_minutes), started/completed counts, running_now, edit_url. Read-only.',
  permissions: ['integrations.webhooks'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps, baseUrl }) {
    const svc = await flowsDeps(deps);
    const out = wrapData({ flows: (await svc.list()).map((f) => flowForAi(f, baseUrl)), manage_url: `${baseUrl}${MANAGE}` });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/** Lược đồ các bước — dùng chung cho tạo và sửa kịch bản. */
function stepsSchema(z: Parameters<ToolDef['input']>[0]) {
  return z
    .array(
      z.object({
        id: z.string().min(1).max(16).describe('Mã bước, vd "s1" / Step id'),
        text: z.string().min(1).max(2000).describe('Nội dung tin; {ten} = tên khách / Message text'),
        buttons: z
          .array(z.object({ title: z.string().min(1).max(20), next: z.string().max(16).nullable().describe('id bước tiếp theo, null = kết thúc') }))
          .max(10)
          .optional()
          .describe('Nút trả lời nhanh / Quick reply buttons'),
        ask: z.enum(['phone', 'email', 'note']).optional().describe('Hỏi và lưu câu trả lời / Ask and save the answer'),
        wait_minutes: z.number().int().min(0).max(1380).optional().describe('Chờ trước khi gửi bước này (phút) / Delay before this step'),
        next: z.string().max(16).nullable().optional().describe('Bước sau khi không có nút; null = kết thúc / Next step'),
      }),
    )
    .min(1)
    .max(20)
    .describe('Các bước theo thứ tự / Steps in order');
}

/** Tạo kịch bản — GHI THẲNG nhưng mặc định TẮT: không nhắn ai cho tới khi bật. Không có tool xoá (xoá ở giao diện). */
export const createMessageFlowTool: ToolDef = {
  name: 'create_message_flow',
  title: 'Tạo kịch bản nhắn tin Messenger / Create Messenger flow',
  description:
    'Tạo kịch bản tự nhắn riêng nhiều bước cho khách trên Messenger (kiểu chatbot: chào, hỏi nhu cầu bằng nút bấm, xin SĐT, nhắc lại sau). ' +
    'Cần: name; trigger = "keyword" (kèm keywords, vd ["học phí","giá"]) hoặc "chat_link" (kèm chat_link_id lấy từ list_chat_links) hoặc "first_message"; steps = danh sách bước theo thứ tự. ' +
    'Mỗi bước: id ngắn (vd "s1", "gia"), text (nội dung; {ten} = tên khách), tuỳ chọn buttons = [{title ≤20 ký tự, next = id bước đi tới hoặc null để kết thúc}], ' +
    'hoặc ask = "phone" | "email" | "note" (hỏi và lưu câu trả lời vào khách), wait_minutes (chờ bao nhiêu phút rồi mới gửi bước này, tối đa 1380), next (bước sau, bỏ trống = bước kế tiếp, null = kết thúc). ' +
    'Messenger chỉ cho nhắn trong 24 giờ từ tin cuối của khách nên kịch bản tự dừng khi quá hạn. Kịch bản tạo ra ở trạng thái TẮT; chỉ đặt active=true khi người dùng nói rõ muốn bật luôn. ' +
    'page_id bỏ trống nếu công ty chỉ có một Fanpage. Kết quả có edit_url để người dùng xem lại. Cần scope crm.write. / ' +
    'Creates a multi-step Messenger flow. Needs name, trigger (keyword + keywords | chat_link + chat_link_id | first_message) and steps [{id, text, buttons?[{title, next}], ask?, wait_minutes?, next?}]. Created INACTIVE unless active=true.',
  permissions: ['integrations.webhooks'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    name: z.string().min(1).max(120).describe('Tên kịch bản, vd "Chào khách hỏi học phí" / Flow name'),
    trigger: z.enum(['keyword', 'chat_link', 'first_message']).describe('Cách bắt đầu / How the flow starts'),
    keywords: z.array(z.string().min(1).max(100)).max(30).optional().describe('Từ khoá (khi trigger=keyword), không phân biệt dấu / Keywords'),
    chat_link_id: z.number().int().min(1).optional().describe('link_id từ list_chat_links (khi trigger=chat_link) / Chat link id'),
    steps: stepsSchema(z),
    active: z.boolean().optional().describe('Bật ngay (chỉ khi người dùng yêu cầu) / Activate now'),
    page_id: z.string().max(40).optional().describe('page_id Fanpage; bỏ trống khi chỉ có một Page / Facebook Page id'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const svc = await flowsDeps(deps);
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
    try {
      const f = await svc.create(
        {
          name: String(args.name ?? ''),
          page_id: pageId,
          trigger: args.trigger as 'keyword' | 'chat_link' | 'first_message',
          keywords: Array.isArray(args.keywords) ? (args.keywords as string[]) : undefined,
          chat_link_id: typeof args.chat_link_id === 'number' ? args.chat_link_id : undefined,
          steps: args.steps,
          is_active: args.active === true,
        },
        principal.user.userId,
      );
      const out = wrapData({
        ...flowForAi(f, baseUrl),
        next_step: f.is_active ? 'Kịch bản đã bật.' : 'Kịch bản đang TẮT — người dùng mở edit_url để xem lại rồi bật.',
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      if (err instanceof BadRequestException) throw new ToolUserError(err.message);
      throw err;
    }
  },
};

/** Sửa / bật / tắt kịch bản — GHI THẲNG (tin nhắn riêng, khách tự nhắn Page trước). Không có tool xoá. */
export const updateMessageFlowTool: ToolDef = {
  name: 'update_message_flow',
  title: 'Sửa, bật, tắt kịch bản nhắn tin Messenger / Update Messenger flow',
  description:
    'Sửa một kịch bản nhắn tin Messenger (flow_id lấy từ list_message_flows): đổi tên, cách bắt đầu (trigger + keywords / chat_link_id), các bước; active=true để bật, active=false để tắt. ' +
    'Chỉ gửi các trường muốn đổi, trường bỏ trống giữ nguyên. steps gửi là thay TOÀN BỘ các bước (cùng định dạng create_message_flow) — muốn sửa một bước thì lấy steps hiện tại từ list_message_flows, sửa bước đó rồi gửi lại cả danh sách. ' +
    'Đổi bước hoặc tắt kịch bản thì khách đang ở giữa kịch bản dừng lại. Chỉ đặt active=true khi người dùng nói rõ muốn bật. Kết quả có edit_url. Cần scope crm.write. / ' +
    'Updates a Messenger flow by flow_id: name, trigger, keywords, chat_link_id, steps (replaces all steps), active=true/false to turn it on/off. Only send fields to change. Changing steps or turning off stops runs in progress.',
  permissions: ['integrations.webhooks'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({
    flow_id: z.number().int().min(1).max(2_147_483_647).describe('flow_id từ list_message_flows / Flow id'),
    name: z.string().min(1).max(120).optional().describe('Tên mới / New name'),
    trigger: z.enum(['keyword', 'chat_link', 'first_message']).optional().describe('Cách bắt đầu mới / New trigger'),
    keywords: z.array(z.string().min(1).max(100)).max(30).optional().describe('Từ khoá (khi trigger=keyword) / Keywords'),
    chat_link_id: z.number().int().min(1).max(2_147_483_647).optional().describe('link_id từ list_chat_links (khi trigger=chat_link) / Chat link id'),
    steps: stepsSchema(z).optional(),
    active: z.boolean().optional().describe('true = bật, false = tắt / Turn the flow on or off'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const svc = await flowsDeps(deps);
    const input: FlowInput = {};
    if (typeof args.name === 'string') input.name = args.name;
    if (typeof args.trigger === 'string') input.trigger = args.trigger as FlowInput['trigger'];
    if (Array.isArray(args.keywords)) input.keywords = args.keywords as string[];
    if (typeof args.chat_link_id === 'number') input.chat_link_id = args.chat_link_id;
    if (args.steps !== undefined) input.steps = args.steps;
    if (typeof args.active === 'boolean') input.is_active = args.active;
    if (!Object.keys(input).length) throw new ToolUserError('Không có trường nào để sửa. / Nothing to change.');
    try {
      const f = await svc.update(Number(args.flow_id), input);
      const out = wrapData({ ...flowForAi(f, baseUrl), next_step: f.is_active ? 'Kịch bản đang bật.' : 'Kịch bản đang TẮT.' });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof NotFoundException) throw new ToolUserError(err.message);
      throw err;
    }
  },
};

export const FACEBOOK_FLOW_TOOLS: readonly ToolDef[] = [listMessageFlowsTool, createMessageFlowTool, updateMessageFlowTool];
