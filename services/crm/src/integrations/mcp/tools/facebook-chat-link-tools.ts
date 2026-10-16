import { BadRequestException } from '@nestjs/common';
import { wrapData } from '../ai-output';
import type { ChatLinkView } from '../../../facebook/facebook-chat-links.service';
import { ToolUserError, type McpDeps, type ToolDef } from './tool-types';

async function chatLinksDeps(deps: Pick<McpDeps, 'facebookChatLinks' | 'orgFeatures'>) {
  if (!deps.facebookChatLinks) throw new ToolUserError('Máy chủ này chưa có tính năng link mở chat. / Chat entry links are not available on this server.');
  if (!(await deps.orgFeatures.isEnabled('facebook_page'))) {
    throw new ToolUserError('Tính năng "Fanpage Facebook" đang tắt (Cài đặt › Tính năng). / The Facebook Page feature is turned off for this workspace.');
  }
  return deps.facebookChatLinks;
}

const MANAGE = '/connections?muc=facebook&xem=link-chat';

function linkForAi(l: ChatLinkView, baseUrl: string) {
  return {
    link_id: l.id,
    name: l.name,
    page: l.page_name,
    page_id: l.page_id,
    url: l.url ?? l.messenger_url,
    contact_source: l.source_label ?? 'nguồn mặc định của Page',
    active: l.is_active,
    clicks: l.clicks,
    chats: l.chats,
    qr_url: `${baseUrl}${MANAGE}&link=${l.id}`,
  };
}

export const listChatLinksTool: ToolDef = {
  name: 'list_chat_links',
  title: 'Link/QR mở chat Messenger / List chat entry links',
  description:
    'Các link (và mã QR) mở thẳng khung chat Messenger của Fanpage, mỗi link gắn một nguồn khách — dùng in tờ rơi, dán ở quầy, gắn lên web/bài đăng để biết khách đến từ đâu. ' +
    'Mỗi link có: url (đưa cho khách), contact_source (nguồn gán cho khách mới vào qua link), clicks (số lượt mở link), chats (số hội thoại bắt đầu từ link), qr_url (trang Trinity hiện mã QR để tải về in). Chỉ đọc. / ' +
    'Links (and QR codes) that open Messenger with the Facebook Page, each tagged with a lead source — for flyers, counters, websites. Each has url, contact_source, clicks, chats and qr_url (Trinity page showing the QR to download). Read-only.',
  permissions: ['integrations.webhooks'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps, baseUrl }) {
    const svc = await chatLinksDeps(deps);
    const out = wrapData({ links: (await svc.list()).map((l) => linkForAi(l, baseUrl)), manage_url: `${baseUrl}${MANAGE}` });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/** Tạo link mở chat — GHI THẲNG: chỉ thêm cấu hình trong Trinity, không gửi gì cho khách. Không có tool xoá (xoá/tắt ở giao diện). */
export const createChatLinkTool: ToolDef = {
  name: 'create_chat_link',
  title: 'Tạo link/QR mở chat Messenger / Create chat entry link',
  description:
    'Tạo một link mở thẳng khung chat Messenger của Fanpage, gắn nguồn khách: khách bấm link hoặc quét QR rồi nhắn tin thì thành khách hàng mang nguồn này. ' +
    'Cần name (vd "Tờ rơi quán", "QR bàn 5"). page_id lấy từ list_chat_links hoặc bỏ trống nếu công ty chỉ có một Fanpage. ' +
    'source_id = id nguồn khách (lấy từ list_crm_options, nhóm sources); bỏ trống = nguồn mặc định của Page. ' +
    'Kết quả có url để đưa khách và qr_url (trang Trinity có mã QR tải về in). Không gửi gì cho khách. Cần scope crm.write. / ' +
    'Creates a link that opens Messenger with the Facebook Page, tagged with a lead source. Needs name; page_id optional when there is one Page; source_id = a contact_source option id (default: the Page\'s source). Returns url and qr_url.',
  permissions: ['integrations.webhooks'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    name: z.string().min(1).max(120).describe('Tên link, vd "Tờ rơi quán" / Link name'),
    page_id: z.string().max(40).optional().describe('page_id Fanpage; bỏ trống khi chỉ có một Page / Facebook Page id'),
    source_id: z.number().int().min(1).optional().describe('id nguồn khách (contact_source); bỏ trống = nguồn của Page / Lead source option id'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const svc = await chatLinksDeps(deps);
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
      const l = await svc.create({ name: String(args.name ?? ''), page_id: pageId, source_id: typeof args.source_id === 'number' ? args.source_id : undefined }, principal.user.userId);
      const out = wrapData({ ...linkForAi(l, baseUrl), next_step: 'Gửi url hoặc mở qr_url để tải mã QR in ấn.' });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      if (err instanceof BadRequestException) throw new ToolUserError(err.message);
      throw err;
    }
  },
};

export const FACEBOOK_CHAT_LINK_TOOLS: readonly ToolDef[] = [listChatLinksTool, createChatLinkTool];
