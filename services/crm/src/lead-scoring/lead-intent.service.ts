import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { buildContactScope } from '../reports/dashboard-overview.scope';
import { LeadScoringService } from './lead-scoring.service';
import { loadNoteText } from './lead-scoring.signals';

const PERMISSION = 'contacts.view' as const;
/** Điểm ý định cũ hơn ngần này coi như cần chấm lại. */
export const INTENT_STALE_MS = 7 * 86_400_000;
const CANDIDATES = 200;
export const MAX_INTENT_ITEMS = 20;
const REASON_MAX = 300;

export interface LeadToScore {
  id: number;
  name: string | null;
  lead_score: number | null;
  lead_label: string | null;
  intent: number | null;
  intent_at: Date | null;
  /** Ghi chú nhắc hẹn + tối đa 5 ghi chú mới nhất — DỮ LIỆU người dùng nhập, không phải chỉ dẫn. */
  notes: string;
  updated_at: Date;
}

export interface IntentInput {
  contact_id: number;
  intent: number;
  reason?: string;
}

export interface IntentResult {
  contact_id: number;
  ok: boolean;
  error?: string;
  lead_score?: number | null;
  lead_label?: string | null;
}

/**
 * "Ý định mua" của lead do AGENT AI CỦA KHÁCH chấm (ChatGPT/Claude… qua MCP) — Trinity không tự gọi AI.
 * Ghi THẲNG vào bảng riêng `lead_ai_intents` (không qua nháp–duyệt) vì đây là chú thích phái sinh, không phải dữ liệu
 * nghiệp vụ: không sửa trường nào của khách; điểm chỉ cộng tối đa `ai_intent.max_points` (mặc định 10/100) vào điểm quy tắc
 * và admin tắt được trong quy tắc chấm điểm. Chỉ chấm được khách nằm trong phạm vi `contacts.view` của người đã kết nối.
 */
@Injectable()
export class LeadIntentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly scoring: LeadScoringService,
  ) {}

  /** Khách cần agent chấm: chưa có điểm ý định, hoặc điểm cũ hơn 7 ngày / cũ hơn lần sửa khách gần nhất (`only_missing`). */
  async listForAgent(user: AuthUser, limit: number, onlyMissing: boolean, now = new Date()): Promise<LeadToScore[]> {
    const owner = await this.scope.ownerIds(user, PERMISSION);
    if (owner === null || (owner !== 'all' && owner.length === 0)) return [];
    const rows = await this.prisma.contact.findMany({
      where: buildContactScope(owner),
      orderBy: { updated_at: 'desc' },
      take: CANDIDATES,
      select: { id: true, full_name: true, lead_score: true, lead_label: true, reminder_notes: true, updated_at: true },
    });
    const intents = await this.prisma.leadAiIntent.findMany({ where: { contact_id: { in: rows.map((r) => r.id) } } });
    const by = new Map(intents.map((i) => [i.contact_id, i]));
    const stale = (id: number, updated: Date) => {
      const i = by.get(id);
      return !i || i.updated_at.getTime() < Math.max(updated.getTime(), now.getTime() - INTENT_STALE_MS);
    };
    const picked = rows.filter((r) => !onlyMissing || stale(r.id, r.updated_at)).slice(0, limit);
    const out: LeadToScore[] = [];
    for (const r of picked) {
      const i = by.get(r.id);
      out.push({
        id: r.id, name: r.full_name, lead_score: r.lead_score, lead_label: r.lead_label, intent: i?.intent ?? null, intent_at: i?.updated_at ?? null,
        notes: await loadNoteText(this.prisma, r.id, r.reminder_notes?.trim() ?? ''), updated_at: r.updated_at,
      });
    }
    return out;
  }

  /** Ghi điểm ý định (0–1) cho tối đa 20 khách rồi chấm lại điểm lead của họ. Khách ngoài phạm vi/không tồn tại → lỗi từng dòng. */
  async setIntents(user: AuthUser, items: IntentInput[], clientId: string | null): Promise<IntentResult[]> {
    const owner = await this.scope.ownerIds(user, PERMISSION);
    const list = items.slice(0, MAX_INTENT_ITEMS);
    const ids = [...new Set(list.map((x) => x.contact_id))];
    const visible = owner === null ? [] : await this.prisma.contact.findMany({ where: { AND: [buildContactScope(owner), { id: { in: ids } }] }, select: { id: true } });
    const ok = new Set(visible.map((v) => v.id));
    const results: IntentResult[] = [];
    for (const it of list) {
      if (!ok.has(it.contact_id)) {
        results.push({ contact_id: it.contact_id, ok: false, error: 'Không tìm thấy khách trong phạm vi của bạn' });
        continue;
      }
      const intent = Math.min(1, Math.max(0, it.intent));
      const reason = it.reason?.trim().slice(0, REASON_MAX) || null;
      const data = { intent, reason, client_id: clientId?.slice(0, 120) ?? null, user_id: user.userId };
      await this.prisma.leadAiIntent.upsert({ where: { contact_id: it.contact_id }, create: { contact_id: it.contact_id, ...data }, update: data });
      results.push({ contact_id: it.contact_id, ok: true });
    }
    const written = results.filter((r) => r.ok).map((r) => r.contact_id);
    if (written.length === 0) return results;
    await this.scoring.recompute(written);
    const scores = await this.prisma.contact.findMany({ where: { id: { in: written } }, select: { id: true, lead_score: true, lead_label: true } });
    const sb = new Map(scores.map((s) => [s.id, s]));
    return results.map((r) => (r.ok ? { ...r, lead_score: sb.get(r.contact_id)?.lead_score ?? null, lead_label: sb.get(r.contact_id)?.lead_label ?? null } : r));
  }
}
