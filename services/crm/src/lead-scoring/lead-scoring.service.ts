import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { OrgFeaturesService } from '../settings/org-features.service';
import { loadSignals } from './lead-scoring.signals';
import { normalizeRules, scoreLead, type LeadScoringRules } from './lead-scoring.rules';
import { Prisma } from '@prisma/client';

const RULES_KEY = 'lead_scoring_rules';
const CURSOR_KEY = 'lead_scoring_outbox_cursor';
const RESCORE_AFTER_MS = 12 * 3_600_000;
const CHUNK = 200;

export interface RunSummary {
  outbox_events: number;
  rescored: number;
}

@Injectable()
export class LeadScoringService {
  private readonly logger = new Logger(LeadScoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgFeatures: OrgFeaturesService,
  ) {}

  /** Cờ tính năng `lead_scoring` (công tắc tổ chức + gói). */
  featureOn(): Promise<boolean> {
    return this.orgFeatures.isEnabled('lead_scoring');
  }

  async getRules(): Promise<LeadScoringRules> {
    const row = await this.prisma.setting.findUnique({ where: { key: RULES_KEY }, select: { value: true } });
    if (!row?.value) return normalizeRules(undefined);
    try {
      return normalizeRules(JSON.parse(row.value));
    } catch {
      return normalizeRules(undefined);
    }
  }

  /** Lưu quy tắc đã chuẩn hoá (rác rơi về mặc định) rồi trả bản hiệu lực. */
  async saveRules(raw: unknown, userId: number): Promise<LeadScoringRules> {
    const rules = normalizeRules(raw);
    const value = JSON.stringify(rules);
    await this.prisma.setting.upsert({
      where: { key: RULES_KEY },
      update: { value, updated_by: userId },
      create: { key: RULES_KEY, value, updated_by: userId },
    });
    return rules;
  }

  /** Chấm lại một danh sách khách theo quy tắc (không AI); điểm "ý định" do agent của khách ghi sẵn ở `lead_ai_intents`. Trả số khách được ghi. */
  async recompute(ids: number[], now: Date = new Date()): Promise<number> {
    const rules = await this.getRules();
    let written = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const map = await loadSignals(this.prisma, ids.slice(i, i + CHUNK), rules, now);
      for (const [id, row] of map) {
        const r = scoreLead(row.signals, rules, now);
        await this.write(id, r.score, r.label, r.reasons, now);
        written += 1;
      }
    }
    return written;
  }

  /** Raw SQL có chủ đích: `update` của Prisma sẽ nhảy `updated_at` của khách chỉ vì chấm điểm. */
  private async write(id: number, score: number, label: string, reasons: unknown, now: Date): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`UPDATE contacts SET lead_score = ${score}, lead_label = ${label},
        lead_score_reasons = ${JSON.stringify(reasons)}::jsonb, lead_scored_at = ${now} WHERE id = ${id}`,
    );
  }

  /** Đọc sự kiện outbox của contact và deal mới (con trỏ riêng, KHÔNG đụng `dispatched_at` của webhook) → chấm lại khách liên quan. */
  async consumeOutbox(limit = 500): Promise<number> {
    const cursorRow = await this.prisma.setting.findUnique({ where: { key: CURSOR_KEY }, select: { value: true } });
    if (!cursorRow) {
      const max = await this.prisma.integrationEvent.aggregate({ _max: { id: true } });
      await this.saveCursor(max._max.id ?? BigInt(0));
      return 0;
    }
    const events = await this.prisma.integrationEvent.findMany({
      where: { id: { gt: BigInt(cursorRow.value) }, resource: { in: ['contact', 'deal'] } },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, resource: true, resource_id: true, event_type: true, payload: true },
    });
    if (events.length === 0) return 0;
    const ids = new Set<number>();
    for (const e of events) {
      if (e.event_type === 'contact.deleted') continue;
      const id = e.resource === 'contact' ? Number(e.resource_id) : Number((e.payload as { contact_id?: number } | null)?.contact_id);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
    await this.recompute([...ids]);
    await this.saveCursor(events[events.length - 1].id);
    return events.length;
  }

  private async saveCursor(id: bigint): Promise<void> {
    await this.prisma.setting.upsert({ where: { key: CURSOR_KEY }, update: { value: id.toString() }, create: { key: CURSOR_KEY, value: id.toString() } });
  }

  /** Khách chưa chấm hoặc điểm cũ >12h (độ mới phải giảm theo thời gian). */
  async rescoreStale(limit = 500, now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.contact.findMany({
      where: { deleted_at: null, OR: [{ lead_scored_at: null }, { lead_scored_at: { lt: new Date(now.getTime() - RESCORE_AFTER_MS) } }] },
      orderBy: { lead_scored_at: { sort: 'asc', nulls: 'first' } },
      take: limit,
      select: { id: true },
    });
    return this.recompute(rows.map((r) => r.id), now);
  }

  async runOnce(): Promise<RunSummary | { skipped: string }> {
    if (!(await this.orgFeatures.isEnabled('lead_scoring'))) return { skipped: 'org-flag-off' };
    try {
      const outbox_events = await this.consumeOutbox();
      const rescored = await this.rescoreStale();
      if (outbox_events + rescored > 0) this.logger.log(`Chấm điểm lead: ${outbox_events} sự kiện, ${rescored} khách chấm lại`);
      return { outbox_events, rescored };
    } catch (err) {
      this.logger.error(`Chấm điểm lead lỗi: ${(err as Error)?.message}`);
      return { outbox_events: 0, rescored: 0 };
    }
  }
}
