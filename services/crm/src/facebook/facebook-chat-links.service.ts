import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { FacebookChatLink } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { loadFacebookConfig } from './facebook.config';

export interface ChatLinkInput {
  name?: string;
  page_id?: string;
  source_id?: number | null;
  is_active?: boolean;
}

/** Mã trong link: chữ thường + số, bỏ ký tự dễ nhầm (0/o, 1/l/i) để đọc từ ấn phẩm không nhầm. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newLinkCode(len = 8): string {
  const b = randomBytes(len);
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
}

/** Link mở thẳng Messenger của Page kèm mã nguồn — Meta gửi lại `ref` trong webhook khi khách vào chat. */
export const messengerUrl = (pageId: string, code: string): string => `https://m.me/${encodeURIComponent(pageId)}?ref=${encodeURIComponent(code)}`;

export interface ChatLinkView extends FacebookChatLink {
  /** Link đưa ra ngoài (in QR, gắn web): qua Trinity để đếm lượt mở. null khi chưa đặt địa chỉ công khai. */
  url: string | null;
  /** Link thẳng Messenger (không đếm lượt mở). */
  messenger_url: string;
  page_name: string | null;
  source_label: string | null;
}

/**
 * Link/QR mở chat Messenger kèm nguồn khách (kiểu "growth tool" của ManyChat). Khách mở link → Trinity đếm lượt mở → chuyển
 * sang `m.me/<page>?ref=<mã>`; Meta gửi `ref` về webhook (messaging_referrals / postback / tin đầu) → hội thoại và khách mới
 * được gắn nguồn theo link. Xử lý webhook nằm ở `FacebookMessengerService.ingestReferral`.
 */
@Injectable()
export class FacebookChatLinksService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ChatLinkView[]> {
    const rows = await this.prisma.facebookChatLink.findMany({ orderBy: { id: 'desc' } });
    return this.views(rows);
  }

  async create(input: ChatLinkInput, userId: number): Promise<ChatLinkView> {
    const data = await this.validate(input, true);
    for (let i = 0; ; i++) {
      try {
        const row = await this.prisma.facebookChatLink.create({
          data: { name: data.name as string, page_id: data.page_id as string, source_id: data.source_id ?? null, is_active: data.is_active ?? true, code: newLinkCode(), created_by: userId },
        });
        return (await this.views([row]))[0];
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002' || i >= 4) throw err; // trùng mã (rất hiếm) ⇒ thử mã khác
      }
    }
  }

  async update(id: number, input: ChatLinkInput): Promise<ChatLinkView> {
    await this.find(id);
    const data = await this.validate(input, false);
    const row = await this.prisma.facebookChatLink.update({ where: { id }, data });
    return (await this.views([row]))[0];
  }

  async remove(id: number): Promise<void> {
    await this.find(id);
    await this.prisma.$transaction([
      this.prisma.facebookConversation.updateMany({ where: { entry_link_id: id }, data: { entry_link_id: null } }),
      this.prisma.facebookChatLink.delete({ where: { id } }),
    ]);
  }

  /** Mở link công khai: đếm lượt rồi trả đích Messenger. Link tắt ⇒ vẫn mở Messenger của Page nhưng không gắn nguồn, không đếm. */
  async open(code: string): Promise<string | null> {
    const link = await this.prisma.facebookChatLink.findUnique({ where: { code: code.slice(0, 32) } });
    if (!link) return null;
    if (!link.is_active) return `https://m.me/${encodeURIComponent(link.page_id)}`;
    await this.prisma.facebookChatLink.update({ where: { id: link.id }, data: { clicks: { increment: 1 } } });
    return messengerUrl(link.page_id, link.code);
  }

  private async find(id: number): Promise<FacebookChatLink> {
    const row = await this.prisma.facebookChatLink.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy link');
    return row;
  }

  private async validate(input: ChatLinkInput, creating: boolean): Promise<ChatLinkInput> {
    const out: ChatLinkInput = {};
    if (creating || input.name !== undefined) {
      const name = (input.name ?? '').trim();
      if (!name) throw new BadRequestException('Đặt tên cho link (vd "Tờ rơi quán", "QR bàn 5")');
      out.name = name.slice(0, 120);
    }
    if (creating || input.page_id !== undefined) {
      const page = input.page_id ? await this.prisma.facebookPage.findUnique({ where: { page_id: input.page_id }, select: { id: true } }) : null;
      if (!page) throw new BadRequestException('Chọn Fanpage đã kết nối');
      out.page_id = input.page_id;
    }
    if (input.source_id !== undefined) {
      if (input.source_id !== null) {
        const opt = await this.prisma.settingOption.findFirst({ where: { id: input.source_id, group_key: 'contact_source' }, select: { id: true } });
        if (!opt) throw new BadRequestException('Nguồn khách không hợp lệ');
      }
      out.source_id = input.source_id;
    }
    if (input.is_active !== undefined) out.is_active = input.is_active;
    return out;
  }

  private async views(rows: FacebookChatLink[]): Promise<ChatLinkView[]> {
    const base = loadFacebookConfig().baseUrl;
    const pageIds = [...new Set(rows.map((r) => r.page_id))];
    const srcIds = [...new Set(rows.map((r) => r.source_id).filter((x): x is number => x !== null))];
    const [pages, srcs] = await Promise.all([
      pageIds.length ? this.prisma.facebookPage.findMany({ where: { page_id: { in: pageIds } }, select: { page_id: true, name: true } }) : [],
      srcIds.length ? this.prisma.settingOption.findMany({ where: { id: { in: srcIds } }, select: { id: true, label: true } }) : [],
    ]);
    const pageName = new Map(pages.map((p) => [p.page_id, p.name]));
    const srcLabel = new Map(srcs.map((s) => [s.id, s.label]));
    return rows.map((r) => ({
      ...r,
      url: base ? `${base}/api/v1/facebook/go/${r.code}` : null,
      messenger_url: messengerUrl(r.page_id, r.code),
      page_name: pageName.get(r.page_id) ?? null,
      source_label: r.source_id !== null ? (srcLabel.get(r.source_id) ?? null) : null,
    }));
  }
}
