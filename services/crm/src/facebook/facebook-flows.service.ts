import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { FacebookFlow, FacebookFlowRun } from '@prisma/client';
import { Prisma, PrismaService } from '@trinity/prisma';
import { publishMessengerEvent } from './facebook-events';
import { runInBackground } from '@trinity/rbac-nest';
import { isWithinMessagingWindow } from './channel';
import { fillTemplate, matchesKeywords } from './facebook-comments.service';
import { findVnPhone, MAX_TEXT, referralRef, type MessagingEvent } from './facebook-messenger.service';
import { FacebookPagesService } from './facebook-pages.service';
import { GraphApiError, GraphClient } from './graph-client';

export type FlowTrigger = 'keyword' | 'chat_link' | 'first_message';
export const FLOW_TRIGGERS: readonly FlowTrigger[] = ['keyword', 'chat_link', 'first_message'];
export type FlowAsk = 'phone' | 'email' | 'note';

export interface FlowButton {
  title: string;
  /** Bước đi tới khi khách bấm; null = kết thúc. */
  next: string | null;
}
export interface FlowStep {
  id: string;
  /** Nội dung tin; `{ten}` = tên khách. */
  text: string;
  /** Chờ bao nhiêu phút rồi mới gửi bước này (0 = gửi ngay). Tối đa 23 giờ vì Messenger chỉ cho nhắn trong 24h từ tin cuối của khách. */
  wait_minutes?: number;
  /** Nút trả lời nhanh — khách bấm nút nào đi bước đó. */
  buttons?: FlowButton[];
  /** Hỏi và chờ khách trả lời, lưu câu trả lời vào khách: SĐT / email / ghi chú. Không đi cùng `buttons`. */
  ask?: FlowAsk | null;
  /** Bước sau (khi không có nút): bỏ trống = bước kế trong danh sách; null = kết thúc. */
  next?: string | null;
}

export interface FlowInput {
  name?: string;
  page_id?: string;
  trigger?: FlowTrigger;
  keywords?: string[];
  chat_link_id?: number | null;
  steps?: unknown;
  is_active?: boolean;
}

export const MAX_STEPS = 20;
export const MAX_BUTTONS = 10;
export const MAX_BUTTON_TITLE = 20;
export const MAX_WAIT_MINUTES = 23 * 60;
/** Cùng kịch bản không chạy lại cho cùng hội thoại trong khoảng này (Meta gửi lại webhook, khách bấm link liên tục). */
const RESTART_GUARD_MS = 10 * 60_000;
/** Số tin tối đa gửi liền trong một lần xử lý (chặn vòng lặp). */
const MAX_SENDS_PER_PASS = 10;
const ACTIVE: string[] = ['waiting_button', 'waiting_answer', 'scheduled', 'sending'];
const PAYLOAD_PREFIX = 'FLOW:';
const STEP_ID = /^[A-Za-z0-9_-]{1,16}$/;
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/;

/** Payload nút: FLOW:<run>:<bước>:<thứ tự nút>. */
export const buttonPayload = (runId: number, stepId: string, index: number): string => `${PAYLOAD_PREFIX}${runId}:${stepId}:${index}`;
export function parseButtonPayload(payload: string | undefined | null): { runId: number; stepId: string; index: number } | null {
  if (!payload?.startsWith(PAYLOAD_PREFIX)) return null;
  const [run, step, idx] = payload.slice(PAYLOAD_PREFIX.length).split(':');
  const runId = Number(run);
  const index = Number(idx);
  if (!Number.isInteger(runId) || runId <= 0 || !step || !Number.isInteger(index) || index < 0) return null;
  return { runId, stepId: step, index };
}

/** Bước đi sau một bước không có nút: `next` đặt rõ, hoặc bước kế trong danh sách. */
export function nextAfter(steps: FlowStep[], step: FlowStep): string | null {
  if (step.next !== undefined) return step.next;
  const i = steps.findIndex((s) => s.id === step.id);
  return steps[i + 1]?.id ?? null;
}

/** Chuẩn hoá + kiểm danh sách bước; lỗi ném BadRequest (câu chữ cho người dùng). */
export function cleanSteps(raw: unknown): FlowStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException('Kịch bản cần ít nhất một bước');
  if (raw.length > MAX_STEPS) throw new BadRequestException(`Kịch bản tối đa ${MAX_STEPS} bước`);
  const steps: FlowStep[] = raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const n = i + 1;
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `s${n}`;
    if (!STEP_ID.test(id)) throw new BadRequestException(`Bước ${n}: mã bước chỉ gồm chữ, số, "-", "_" (tối đa 16 ký tự)`);
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text) throw new BadRequestException(`Bước ${n}: chưa có nội dung tin`);
    if (text.length > MAX_TEXT) throw new BadRequestException(`Bước ${n}: tin tối đa ${MAX_TEXT} ký tự`);
    const step: FlowStep = { id, text };
    if (o.wait_minutes !== undefined && o.wait_minutes !== null && o.wait_minutes !== 0) {
      const w = Number(o.wait_minutes);
      if (!Number.isInteger(w) || w < 0 || w > MAX_WAIT_MINUTES) throw new BadRequestException(`Bước ${n}: thời gian chờ từ 0 đến ${MAX_WAIT_MINUTES} phút (23 giờ)`);
      if (w > 0) step.wait_minutes = w;
    }
    const buttons = Array.isArray(o.buttons) ? o.buttons : [];
    if (buttons.length > MAX_BUTTONS) throw new BadRequestException(`Bước ${n}: tối đa ${MAX_BUTTONS} nút`);
    if (buttons.length) {
      step.buttons = buttons.map((b, j) => {
        const bo = (b ?? {}) as Record<string, unknown>;
        const title = typeof bo.title === 'string' ? bo.title.trim() : '';
        if (!title) throw new BadRequestException(`Bước ${n}, nút ${j + 1}: chưa có chữ trên nút`);
        if (title.length > MAX_BUTTON_TITLE) throw new BadRequestException(`Bước ${n}, nút ${j + 1}: chữ trên nút tối đa ${MAX_BUTTON_TITLE} ký tự`);
        const next = typeof bo.next === 'string' && bo.next.trim() ? bo.next.trim() : null;
        return { title, next };
      });
    }
    if (o.ask !== undefined && o.ask !== null && o.ask !== '') {
      if (!['phone', 'email', 'note'].includes(String(o.ask))) throw new BadRequestException(`Bước ${n}: kiểu câu hỏi phải là phone, email hoặc note`);
      if (step.buttons) throw new BadRequestException(`Bước ${n}: bước hỏi khách không kèm nút được — tách thành hai bước`);
      step.ask = o.ask as FlowAsk;
    }
    if (o.next !== undefined) step.next = typeof o.next === 'string' && o.next.trim() ? o.next.trim() : null;
    return step;
  });
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) throw new BadRequestException(`Mã bước "${s.id}" bị trùng`);
    ids.add(s.id);
  }
  const known = (target: string | null | undefined, where: string) => {
    if (target && !ids.has(target)) throw new BadRequestException(`${where}: bước "${target}" không có trong kịch bản`);
  };
  steps.forEach((s, i) => {
    known(s.next, `Bước ${i + 1}`);
    s.buttons?.forEach((b, j) => known(b.next, `Bước ${i + 1}, nút ${j + 1}`));
  });
  // Vòng toàn bước tự đi (không nút, không hỏi) ⇒ gửi mãi không dừng.
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const start of steps) {
    const seen = new Set<string>();
    let cur: FlowStep | undefined = start;
    while (cur && !cur.buttons && !cur.ask) {
      if (seen.has(cur.id)) throw new BadRequestException(`Các bước tự gửi nối thành vòng (qua bước "${cur.id}") — thêm nút, câu hỏi hoặc cho một bước kết thúc`);
      seen.add(cur.id);
      const nx = nextAfter(steps, cur);
      cur = nx ? byId.get(nx) : undefined;
    }
  }
  return steps;
}

export interface FlowView extends Omit<FacebookFlow, 'steps'> {
  steps: FlowStep[];
  page_name: string | null;
  chat_link_name: string | null;
  /** Số lượt đang chạy dở (chờ khách bấm/trả lời/chờ giờ gửi). */
  running: number;
}

/**
 * Kịch bản nhắn riêng nhiều bước trên Messenger (kiểu ManyChat): kích hoạt bằng từ khoá, link/QR mở chat hoặc tin đầu tiên của
 * khách; mỗi bước là một tin, có thể kèm nút trả lời nhanh (rẽ nhánh), hỏi và lưu SĐT/email/ghi chú, hoặc chờ N phút rồi gửi.
 * Luôn trong cửa sổ 24h của Messenger: quá hạn thì dừng (expired), không gửi chủ động. Nhân viên trả lời trong Trinity ⇒ dừng kịch bản.
 */
@Injectable()
export class FacebookFlowsService {
  private readonly logger = new Logger(FacebookFlowsService.name);
  private running = false;
  private lastDueCheck = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphClient,
    private readonly pages: FacebookPagesService,
  ) {}

  /* ---------------- Quản trị ---------------- */

  async list(): Promise<FlowView[]> {
    return this.views(await this.prisma.facebookFlow.findMany({ orderBy: { id: 'desc' } }));
  }

  async get(id: number): Promise<FlowView> {
    return (await this.views([await this.find(id)]))[0];
  }

  async create(input: FlowInput, userId: number): Promise<FlowView> {
    const d = await this.validate(input, null);
    const row = await this.prisma.facebookFlow.create({
      data: {
        name: d.name as string,
        page_id: d.page_id as string,
        trigger: d.trigger as string,
        keywords: d.keywords ?? [],
        chat_link_id: d.chat_link_id ?? null,
        steps: d.steps as unknown as Prisma.InputJsonValue,
        is_active: d.is_active ?? false,
        created_by: userId,
      },
    });
    return (await this.views([row]))[0];
  }

  async update(id: number, input: FlowInput): Promise<FlowView> {
    const cur = await this.find(id);
    const d = await this.validate(input, cur);
    const row = await this.prisma.facebookFlow.update({
      where: { id },
      data: { ...d, steps: d.steps ? (d.steps as unknown as Prisma.InputJsonValue) : undefined },
    });
    if (input.is_active === false || d.steps) {
      // Tắt hoặc đổi bước ⇒ lượt đang dở dừng lại (bước cũ có thể không còn).
      await this.prisma.facebookFlowRun.updateMany({ where: { flow_id: id, status: { in: ACTIVE } }, data: { status: 'stopped', step_id: null, due_at: null, note: 'Kịch bản đã sửa hoặc tắt' } });
    }
    return (await this.views([row]))[0];
  }

  async remove(id: number): Promise<void> {
    await this.find(id);
    await this.prisma.$transaction([
      this.prisma.facebookFlowRun.deleteMany({ where: { flow_id: id } }),
      this.prisma.facebookFlow.delete({ where: { id } }),
    ]);
  }

  /** Lượt chạy gần nhất của một kịch bản (để xem khách đang ở bước nào). */
  async runs(flowId: number, limit = 50) {
    await this.find(flowId);
    const rows = await this.prisma.facebookFlowRun.findMany({ where: { flow_id: flowId }, orderBy: { started_at: 'desc' }, take: Math.min(Math.max(limit, 1), 200) });
    const convs = rows.length
      ? await this.prisma.facebookConversation.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.conversation_id))] } }, select: { id: true, customer_name: true, contact_id: true } })
      : [];
    const byId = new Map(convs.map((c) => [c.id, c]));
    return rows.map((r) => ({ ...r, customer_name: byId.get(r.conversation_id)?.customer_name ?? null, contact_id: byId.get(r.conversation_id)?.contact_id ?? null }));
  }

  private async find(id: number): Promise<FacebookFlow> {
    const row = await this.prisma.facebookFlow.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy kịch bản');
    return row;
  }

  private async validate(input: FlowInput, cur: FacebookFlow | null) {
    const out: { name?: string; page_id?: string; trigger?: FlowTrigger; keywords?: string[]; chat_link_id?: number | null; steps?: FlowStep[]; is_active?: boolean } = {};
    if (!cur || input.name !== undefined) {
      const name = (input.name ?? '').trim();
      if (!name) throw new BadRequestException('Đặt tên cho kịch bản (vd "Chào khách mới", "Báo giá khoá học")');
      out.name = name.slice(0, 120);
    }
    if (!cur) {
      const page = input.page_id ? await this.prisma.facebookPage.findUnique({ where: { page_id: input.page_id }, select: { id: true } }) : null;
      if (!page) throw new BadRequestException('Chọn Fanpage đã kết nối');
      out.page_id = input.page_id;
    }
    const pageId = cur?.page_id ?? (out.page_id as string);
    const trigger = (input.trigger ?? cur?.trigger) as FlowTrigger | undefined;
    if (!trigger || !FLOW_TRIGGERS.includes(trigger)) throw new BadRequestException('Cách bắt đầu phải là keyword, chat_link hoặc first_message');
    if (input.trigger !== undefined) out.trigger = trigger;
    if (input.keywords !== undefined) {
      out.keywords = [...new Set(input.keywords.map((k) => String(k).trim()).filter(Boolean).map((k) => k.slice(0, 100)))].slice(0, 30);
    }
    const keywords = out.keywords ?? cur?.keywords ?? [];
    if (trigger === 'keyword' && !keywords.length) throw new BadRequestException('Kịch bản theo từ khoá cần ít nhất một từ khoá');
    if (input.chat_link_id !== undefined) out.chat_link_id = input.chat_link_id;
    const linkId = out.chat_link_id !== undefined ? out.chat_link_id : (cur?.chat_link_id ?? null);
    if (trigger === 'chat_link') {
      const link = linkId ? await this.prisma.facebookChatLink.findUnique({ where: { id: linkId }, select: { page_id: true } }) : null;
      if (!link || link.page_id !== pageId) throw new BadRequestException('Chọn link/QR mở chat của cùng Fanpage');
    } else if (input.trigger !== undefined) {
      out.chat_link_id = null;
    }
    if (!cur || input.steps !== undefined) out.steps = cleanSteps(input.steps);
    if (input.is_active !== undefined) out.is_active = input.is_active;
    return out;
  }

  private async views(rows: FacebookFlow[]): Promise<FlowView[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const linkIds = rows.map((r) => r.chat_link_id).filter((x): x is number => x !== null);
    const [pages, links, running] = await Promise.all([
      this.prisma.facebookPage.findMany({ where: { page_id: { in: [...new Set(rows.map((r) => r.page_id))] } }, select: { page_id: true, name: true } }),
      linkIds.length ? this.prisma.facebookChatLink.findMany({ where: { id: { in: linkIds } }, select: { id: true, name: true } }) : [],
      this.prisma.facebookFlowRun.groupBy({ by: ['flow_id'], where: { flow_id: { in: ids }, status: { in: ACTIVE } }, _count: { _all: true } }),
    ]);
    const pageName = new Map(pages.map((p) => [p.page_id, p.name]));
    const linkName = new Map(links.map((l) => [l.id, l.name]));
    const runCount = new Map(running.map((r) => [r.flow_id, r._count._all]));
    return rows.map((r) => ({
      ...r,
      steps: r.steps as unknown as FlowStep[],
      page_name: pageName.get(r.page_id) ?? null,
      chat_link_name: r.chat_link_id !== null ? (linkName.get(r.chat_link_id) ?? null) : null,
      running: runCount.get(r.id) ?? 0,
    }));
  }

  /* ---------------- Chạy ---------------- */

  /**
   * Gọi từ webhook sau `ingestReferral`/`ingest`. `isNewMessage` = tin này vừa được ghi (không phải Meta gửi lại) — chỉ khi đó mới
   * xử lý nút bấm/câu trả lời/từ khoá. Trả true nếu có kịch bản chạy/đi tiếp.
   */
  async handleEvent(pageId: string, ev: MessagingEvent, isNewMessage: boolean): Promise<boolean> {
    if (ev.message?.is_echo) return false;
    const psid = ev.sender?.id;
    if (!psid) return false;
    const conv = await this.prisma.facebookConversation.findUnique({ where: { page_id_psid: { page_id: pageId, psid } } });
    if (!conv) return false;

    const ref = referralRef(ev);
    if (ref) {
      const link = await this.prisma.facebookChatLink.findUnique({ where: { code: ref }, select: { id: true, page_id: true, is_active: true } });
      if (link && link.page_id === pageId && link.is_active) {
        const flow = await this.prisma.facebookFlow.findFirst({ where: { page_id: pageId, is_active: true, trigger: 'chat_link', chat_link_id: link.id }, orderBy: { id: 'desc' } });
        if (flow) return this.start(flow, conv.id);
      }
    }
    if (!isNewMessage || !ev.message) return false;

    const btn = parseButtonPayload((ev.message as { quick_reply?: { payload?: string } }).quick_reply?.payload);
    if (btn) return this.onButton(conv.id, btn);

    const text = ev.message.text ?? null;
    const active = await this.prisma.facebookFlowRun.findFirst({ where: { conversation_id: conv.id, status: { in: ACTIVE } }, orderBy: { id: 'desc' } });
    if (active?.status === 'waiting_answer' && text) return this.onAnswer(active, text);

    if (text) {
      const flows = await this.prisma.facebookFlow.findMany({ where: { page_id: pageId, is_active: true, trigger: 'keyword' }, orderBy: { id: 'desc' } });
      const hit = flows.find((f) => f.keywords.length > 0 && matchesKeywords(text, f.keywords, []));
      if (hit) return this.start(hit, conv.id);
    }
    if (active) return false; // đang chờ khách bấm nút / chờ giờ gửi ⇒ tin thường để nhân viên xử lý

    const inbound = await this.prisma.facebookMessage.count({ where: { conversation_id: conv.id, direction: 'in' } });
    if (inbound !== 1) return false;
    if (await this.prisma.facebookFlowRun.count({ where: { conversation_id: conv.id } })) return false;
    const welcome = await this.prisma.facebookFlow.findFirst({ where: { page_id: pageId, is_active: true, trigger: 'first_message' }, orderBy: { id: 'desc' } });
    return welcome ? this.start(welcome, conv.id) : false;
  }

  /** Bắt đầu kịch bản cho hội thoại: dừng lượt khác đang dở, chạy từ bước đầu. */
  async start(flow: FacebookFlow, conversationId: number): Promise<boolean> {
    const recent = await this.prisma.facebookFlowRun.findFirst({
      where: { flow_id: flow.id, conversation_id: conversationId, started_at: { gte: new Date(Date.now() - RESTART_GUARD_MS) } },
      select: { id: true },
    });
    if (recent) return false;
    const steps = flow.steps as unknown as FlowStep[];
    if (!steps.length) return false;
    const run = await this.prisma.$transaction(async (tx) => {
      await tx.facebookFlowRun.updateMany({
        where: { conversation_id: conversationId, status: { in: ACTIVE } },
        data: { status: 'stopped', step_id: null, due_at: null, note: `Chuyển sang kịch bản "${flow.name}"`.slice(0, 300) },
      });
      await tx.facebookFlow.update({ where: { id: flow.id }, data: { starts: { increment: 1 } } });
      return tx.facebookFlowRun.create({ data: { flow_id: flow.id, conversation_id: conversationId, step_id: steps[0].id, status: 'sending' } });
    });
    await this.note(conversationId, `Bắt đầu kịch bản nhắn tin "${flow.name}"`, { flow_id: flow.id, run_id: run.id });
    await this.advance(run, flow, steps[0].id, false);
    return true;
  }

  private async onButton(conversationId: number, btn: { runId: number; stepId: string; index: number }): Promise<boolean> {
    const run = await this.prisma.facebookFlowRun.findUnique({ where: { id: btn.runId } });
    if (!run || run.conversation_id !== conversationId || run.status !== 'waiting_button' || run.step_id !== btn.stepId) return false;
    const flow = await this.prisma.facebookFlow.findUnique({ where: { id: run.flow_id } });
    if (!flow?.is_active) return false;
    const step = (flow.steps as unknown as FlowStep[]).find((s) => s.id === btn.stepId);
    const button = step?.buttons?.[btn.index];
    if (!button) return false;
    if (!(await this.claim(run, 'waiting_button'))) return false;
    await this.advance(run, flow, button.next, false);
    return true;
  }

  private async onAnswer(run: FacebookFlowRun, text: string): Promise<boolean> {
    const flow = await this.prisma.facebookFlow.findUnique({ where: { id: run.flow_id } });
    const steps = (flow?.steps as unknown as FlowStep[] | undefined) ?? [];
    const step = steps.find((s) => s.id === run.step_id);
    if (!flow?.is_active || !step?.ask) return false;
    if (!(await this.claim(run, 'waiting_answer'))) return false;
    const conv = await this.prisma.facebookConversation.findUnique({ where: { id: run.conversation_id }, select: { contact_id: true } });
    const answer = text.trim().slice(0, 1000);
    let saved = answer;
    if (step.ask === 'phone') {
      const phone = findVnPhone(answer);
      if (!phone && run.note !== 'retry') {
        // Chưa nhận ra số ⇒ hỏi lại MỘT lần, vẫn chờ ở bước này.
        await this.send(run, flow, { id: step.id, text: 'Mình chưa nhận ra số điện thoại, bạn gửi lại giúp mình số di động nhé.' });
        await this.prisma.facebookFlowRun.update({ where: { id: run.id }, data: { status: 'waiting_answer', note: 'retry' } });
        return true;
      }
      if (phone && conv?.contact_id) {
        saved = phone;
        const c = await this.prisma.contact.findUnique({ where: { id: conv.contact_id }, select: { phone: true, phone_2: true } });
        if (c && !c.phone) await this.prisma.contact.update({ where: { id: conv.contact_id }, data: { phone } });
        else if (c && c.phone !== phone && !c.phone_2) await this.prisma.contact.update({ where: { id: conv.contact_id }, data: { phone_2: phone } });
      }
    } else if (step.ask === 'email') {
      const email = EMAIL.exec(answer)?.[0] ?? null;
      if (!email && run.note !== 'retry') {
        await this.send(run, flow, { id: step.id, text: 'Mình chưa nhận ra email, bạn gửi lại giúp mình nhé (vd ten@gmail.com).' });
        await this.prisma.facebookFlowRun.update({ where: { id: run.id }, data: { status: 'waiting_answer', note: 'retry' } });
        return true;
      }
      if (email && conv?.contact_id) {
        saved = email;
        await this.prisma.contact.updateMany({ where: { id: conv.contact_id, OR: [{ email: null }, { email: '' }] }, data: { email } });
      }
    }
    await this.note(run.conversation_id, `Kịch bản "${flow.name}" — khách trả lời "${step.text.slice(0, 120)}": ${saved}`, { flow_id: flow.id, run_id: run.id, ask: step.ask });
    await this.prisma.facebookFlowRun.update({ where: { id: run.id }, data: { note: null } });
    await this.advance(run, flow, nextAfter(steps, step), false);
    return true;
  }

  /**
   * Bước "chờ N phút" tới giờ khi không có timer (serverless; Vercel Cron gói thường chỉ chạy mỗi ngày): web đang mở gọi
   * `POST facebook/tick` mỗi phút. Mỗi instance kiểm DB tối đa một lần mỗi 20 giây; không chạy chồng trong cùng process.
   */
  /** Giờ của bước kịch bản chờ sớm nhất (null = không có). */
  async nextDueAt(): Promise<Date | null> {
    const r = await this.prisma.facebookFlowRun.aggregate({ where: { status: 'scheduled' }, _min: { due_at: true } });
    return r._min.due_at ?? null;
  }

  async kickIfDue(now = Date.now()): Promise<{ due: boolean }> {
    if (this.running || now - this.lastDueCheck < 20_000) return { due: false };
    this.lastDueCheck = now;
    const due = await this.prisma.facebookFlowRun.findFirst({ where: { status: 'scheduled', due_at: { lte: new Date(now) } }, select: { id: true } });
    if (!due) return { due: false };
    this.running = true;
    runInBackground(
      () => this.runDue(40_000).finally(() => (this.running = false)),
      (err) => this.logger.error(`Kịch bản nhắn tin nền lỗi: ${(err as Error)?.message}`),
    );
    return { due: true };
  }

  /** Job: gửi các bước đã tới giờ. Trả số lượt đã xử lý. */
  async runDue(budgetMs = 40_000): Promise<{ processed: number }> {
    const until = Date.now() + budgetMs;
    let processed = 0;
    while (Date.now() < until) {
      const due = await this.prisma.facebookFlowRun.findMany({ where: { status: 'scheduled', due_at: { lte: new Date() } }, orderBy: { due_at: 'asc' }, take: 20 });
      if (!due.length) break;
      for (const run of due) {
        if (Date.now() >= until) break;
        if (!(await this.claim(run, 'scheduled'))) continue;
        const flow = await this.prisma.facebookFlow.findUnique({ where: { id: run.flow_id } });
        if (!flow?.is_active) {
          await this.finish(run.id, 'stopped', 'Kịch bản đã tắt');
          continue;
        }
        try {
          await this.advance(run, flow, run.step_id, true);
        } catch (err) {
          this.logger.error(`Kịch bản ${flow.id} lượt ${run.id} lỗi: ${(err as Error).message}`);
          await this.finish(run.id, 'failed', (err as Error).message);
        }
        processed++;
      }
    }
    return { processed };
  }

  /** Giành lượt (đổi trạng thái → 'sending') để webhook gửi lại / job chạy song song không gửi trùng. */
  private async claim(run: FacebookFlowRun, from: string): Promise<boolean> {
    const r = await this.prisma.facebookFlowRun.updateMany({ where: { id: run.id, status: from }, data: { status: 'sending' } });
    return r.count === 1;
  }

  /**
   * Đi từ bước `stepId`: gửi tin, rồi dừng ở bước có nút/câu hỏi/thời gian chờ, hoặc đi tiếp tới hết.
   * `waited` = bước đầu đã chờ đủ (job gọi) ⇒ không đặt lịch lại.
   */
  private async advance(run: FacebookFlowRun, flow: FacebookFlow, stepId: string | null, waited: boolean): Promise<void> {
    const steps = flow.steps as unknown as FlowStep[];
    let cur = stepId;
    let skipWait = waited;
    for (let sent = 0; ; sent++) {
      if (!cur) return this.finish(run.id, 'done', null, flow.id);
      const step = steps.find((s) => s.id === cur);
      if (!step) return this.finish(run.id, 'done', null, flow.id);
      if (sent >= MAX_SENDS_PER_PASS) return this.finish(run.id, 'failed', 'Quá nhiều tin liên tiếp');
      if (step.wait_minutes && !skipWait) {
        await this.prisma.facebookFlowRun.update({ where: { id: run.id }, data: { status: 'scheduled', step_id: step.id, due_at: new Date(Date.now() + step.wait_minutes * 60_000) } });
        return;
      }
      skipWait = false;
      const result = await this.send(run, flow, step);
      if (result !== 'sent') return;
      if (step.buttons?.length) {
        await this.prisma.facebookFlowRun.update({ where: { id: run.id }, data: { status: 'waiting_button', step_id: step.id, due_at: null } });
        return;
      }
      if (step.ask) {
        await this.prisma.facebookFlowRun.update({ where: { id: run.id }, data: { status: 'waiting_answer', step_id: step.id, due_at: null } });
        return;
      }
      cur = nextAfter(steps, step);
    }
  }

  /** Gửi một bước (trong cửa sổ 24h). Lỗi ⇒ kết thúc lượt với trạng thái tương ứng. */
  private async send(run: FacebookFlowRun, flow: FacebookFlow, step: FlowStep): Promise<'sent' | 'stopped'> {
    const conv = await this.prisma.facebookConversation.findUnique({ where: { id: run.conversation_id } });
    if (!conv) {
      await this.finish(run.id, 'stopped', 'Hội thoại không còn');
      return 'stopped';
    }
    if (!isWithinMessagingWindow(conv.last_inbound_at)) {
      await this.finish(run.id, 'expired', 'Quá 24 giờ kể từ tin cuối của khách — Messenger không cho gửi chủ động');
      return 'stopped';
    }
    const ctx = await this.pages.activePageWithToken(conv.page_id);
    if (!ctx) {
      await this.finish(run.id, 'failed', 'Fanpage đã tắt hoặc mất kết nối');
      return 'stopped';
    }
    const text = fillTemplate(step.text, conv.customer_name);
    try {
      const res = step.buttons?.length
        ? await this.graph.sendQuickReplies(ctx.token, conv.psid, text, step.buttons.map((b, i) => ({ title: b.title, payload: buttonPayload(run.id, step.id, i) })))
        : await this.graph.sendText(ctx.token, conv.psid, text);
      await this.recordOut(conv.id, res.message_id, text);
      return 'sent';
    } catch (err) {
      if (err instanceof GraphApiError) {
        if (err.isOutsideWindow) {
          await this.finish(run.id, 'expired', 'Quá 24 giờ kể từ tin cuối của khách');
          return 'stopped';
        }
        if (err.isTokenError) await this.pages.markTokenInvalid(conv.page_id);
      }
      await this.finish(run.id, 'failed', `Facebook không nhận tin: ${(err as Error).message}`);
      return 'stopped';
    }
  }

  /** Lưu tin Page vừa gửi vào hộp thư (echo của Meta tới sau sẽ bị bỏ qua vì trùng `mid`). */
  private async recordOut(conversationId: number, mid: string, text: string): Promise<void> {
    const now = new Date();
    try {
      await this.prisma.$transaction([
        this.prisma.facebookMessage.create({ data: { conversation_id: conversationId, mid, direction: 'out', text, sent_at: now } }),
        this.prisma.facebookConversation.update({ where: { id: conversationId }, data: { last_message_at: now, last_message_preview: text.slice(0, 200) } }),
      ]);
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err; // echo tới trước
      return;
    }
    const conv = await this.prisma.facebookConversation.findUnique({ where: { id: conversationId }, select: { id: true, page_id: true, contact_id: true } });
    if (conv) await publishMessengerEvent(this.prisma, conv, 'out', 'flow').catch((e) => this.logger.warn(`Sự kiện webhook tin kịch bản lỗi: ${(e as Error).message}`));
  }

  private async finish(runId: number, status: 'done' | 'stopped' | 'expired' | 'failed', note: string | null, flowId?: number): Promise<void> {
    await this.prisma.facebookFlowRun.update({ where: { id: runId }, data: { status, step_id: null, due_at: null, note: note?.slice(0, 300) ?? null } });
    if (status === 'done' && flowId) await this.prisma.facebookFlow.update({ where: { id: flowId }, data: { completes: { increment: 1 } } });
  }

  /** Ghi lịch sử khách (nếu hội thoại đã gắn khách). */
  private async note(conversationId: number, description: string, meta: Record<string, unknown>): Promise<void> {
    const conv = await this.prisma.facebookConversation.findUnique({ where: { id: conversationId }, select: { contact_id: true, page_id: true, psid: true } });
    if (!conv?.contact_id) return;
    await this.prisma.activity.create({
      data: {
        contact_id: conv.contact_id,
        action: 'note',
        details: { description: description.slice(0, 2000), source: 'facebook_messenger' },
        metadata: { facebook_page_id: conv.page_id, psid: conv.psid, ...meta } as Prisma.InputJsonObject,
        created_by: null,
      },
    });
  }
}
