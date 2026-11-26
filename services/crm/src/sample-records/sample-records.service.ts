import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis.provider';

/** 1 dòng `settings.sample_records` (JSON) giữ id các bản ghi MẪU còn lại — không cần migration, xoá xong thì xoá dòng này. */
export const SAMPLE_RECORDS_KEY = 'sample_records';

export interface SampleIds {
  contacts: number[];
  records: number[];
}

type Db = Pick<Prisma.TransactionClient, 'setting' | 'contact' | 'customRecord' | '$executeRaw'>;

/** Sửa sau lúc tạo quá ngần này ⇒ coi là người dùng đã chỉnh (mẫu tạo cùng lúc, lệch vài ms). */
const EDITED_AFTER_MS = 2000;
const LOCK_NS = 7375;

const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);

export function parseSampleIds(raw: string | null | undefined): SampleIds | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SampleIds>;
    return { contacts: ids(v?.contacts), records: ids(v?.records) };
  } catch {
    return null;
  }
}

/**
 * Bản ghi MẪU của hệ thống mới dựng (dữ liệu giả để xem thử). Khi có bản ghi THẬT đầu tiên — khách hàng hoặc bản ghi tuỳ biến,
 * tạo bằng giao diện, API hay AI — mẫu tự xoá (xoá mềm) và dòng theo dõi biến mất.
 *
 * Gọi `purgeIfReal()` ở các chỗ TẠO bản ghi (không bao giờ ném lỗi: việc dọn mẫu không được làm hỏng việc tạo), và ở các màn
 * hay được gọi (trạng thái dựng, wizard) làm lưới an toàn cho đường tạo không đi qua các chỗ trên (nhập file, webhook, kênh chat…).
 */
@Injectable()
export class SampleRecordsService {
  private readonly logger = new Logger(SampleRecordsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  async read(db: Pick<Prisma.TransactionClient, 'setting'> = this.prisma): Promise<SampleIds | null> {
    const row = await db.setting.findUnique({ where: { key: SAMPLE_RECORDS_KEY }, select: { value: true } });
    return parseSampleIds(row?.value);
  }

  /** Khoá giao dịch cho mọi đọc-sửa-ghi danh sách mẫu (2 lần dựng đồng thời không ghi đè nhau). Tự nhả khi transaction kết thúc. */
  async lock(db: Pick<Prisma.TransactionClient, '$executeRaw'>): Promise<void> {
    await db.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, 1)`);
  }

  /** Ghi thêm id mẫu (gộp với phần đã có). Gọi CÙNG transaction với lúc tạo mẫu. */
  async register(db: Db, add: Partial<SampleIds>, userId: number | null): Promise<void> {
    await this.lock(db);
    const cur = (await this.read(db)) ?? { contacts: [], records: [] };
    const next: SampleIds = { contacts: [...cur.contacts, ...(add.contacts ?? [])], records: [...cur.records, ...(add.records ?? [])] };
    const value = JSON.stringify(next);
    await db.setting.upsert({ where: { key: SAMPLE_RECORDS_KEY }, update: { value, updated_by: userId }, create: { key: SAMPLE_RECORDS_KEY, value, updated_by: userId } });
  }

  /** Có bản ghi thật (không nằm trong danh sách mẫu, chưa xoá) chưa. */
  async hasReal(sample: SampleIds | null = null, db: Pick<Prisma.TransactionClient, 'contact' | 'customRecord'> = this.prisma): Promise<boolean> {
    const [c, r] = await Promise.all([
      db.contact.findFirst({ where: { deleted_at: null, ...(sample?.contacts.length ? { id: { notIn: sample.contacts } } : {}) }, select: { id: true } }),
      db.customRecord.findFirst({ where: { deleted_at: null, ...(sample?.records.length ? { id: { notIn: sample.records } } : {}) }, select: { id: true } }),
    ]);
    return c != null || r != null;
  }

  /** Còn mẫu chưa bị dọn không (cho giao diện hiện nhãn "dữ liệu mẫu"). */
  async remaining(): Promise<SampleIds | null> {
    try {
      return await this.read();
    } catch {
      return null;
    }
  }

  /** Có bản ghi thật ⇒ xoá mẫu. Trả true nếu vừa xoá. Không bao giờ ném lỗi. */
  async purgeIfReal(): Promise<boolean> {
    try {
      const sample = await this.read();
      if (!sample) return false;
      if (!(await this.hasReal(sample))) return false;
      const now = new Date();
      let removed = { contacts: 0, records: 0 };
      await this.prisma.$transaction(async (tx) => {
        await this.lock(tx);
        // Chỉ xoá mẫu còn NGUYÊN: mẫu người dùng đã sửa hoặc đã có bản ghi thật liên kết tới được giữ lại (thành dữ liệu thật).
        const drop = await this.untouched(tx, sample);
        if (drop.contacts.length) await tx.contact.updateMany({ where: { id: { in: drop.contacts }, deleted_at: null }, data: { deleted_at: now } });
        if (drop.records.length) await tx.customRecord.updateMany({ where: { id: { in: drop.records }, deleted_at: null }, data: { deleted_at: now } });
        removed = { contacts: drop.contacts.length, records: drop.records.length };
        await tx.setting.deleteMany({ where: { key: SAMPLE_RECORDS_KEY } });
      });
      if (removed.contacts) await this.dropContactCountCache();
      this.logger.log(`đã xoá bản ghi mẫu (khách ${removed.contacts}, bản ghi ${removed.records}) vì có bản ghi thật đầu tiên`);
      return true;
    } catch (err) {
      this.logger.warn(`dọn bản ghi mẫu lỗi (bỏ qua): ${(err as Error)?.message}`);
      return false;
    }
  }

  /** Mẫu còn nguyên: chưa bị sửa và không bị bản ghi nào khác liên kết tới. */
  private async untouched(tx: Prisma.TransactionClient, sample: SampleIds): Promise<SampleIds> {
    const [contacts, records] = await Promise.all([
      sample.contacts.length ? tx.contact.findMany({ where: { id: { in: sample.contacts }, deleted_at: null }, select: { id: true, created_at: true, updated_at: true } }) : [],
      sample.records.length ? tx.customRecord.findMany({ where: { id: { in: sample.records }, deleted_at: null }, select: { id: true, created_at: true, updated_at: true } }) : [],
    ]);
    const intact = (r: { created_at: Date; updated_at: Date }) => r.updated_at.getTime() - r.created_at.getTime() <= EDITED_AFTER_MS;
    const cIds = contacts.filter(intact).map((r) => r.id);
    const rIds = records.filter(intact).map((r) => r.id);
    const cRef = new Set<number>();
    const rRef = new Set<number>();
    if (cIds.length) {
      const where = { contact_id: { in: cIds } };
      const hits = await Promise.all([
        tx.deal.findMany({ where, select: { contact_id: true } }),
        tx.activity.findMany({ where, select: { contact_id: true } }),
        tx.kanbanCard.findMany({ where, select: { contact_id: true } }),
        tx.zaloOaThread.findMany({ where, select: { contact_id: true } }),
        tx.facebookConversation.findMany({ where, select: { contact_id: true } }),
        tx.paymentIntent.findMany({ where, select: { contact_id: true } }),
        tx.storeOrder.findMany({ where, select: { contact_id: true } }),
      ]);
      for (const list of hits) for (const h of list) if (h.contact_id != null) cRef.add(h.contact_id);
    }
    const links = await tx.recordLink.findMany({
      where: { OR: [...(cIds.length ? [{ target_type: 'contact', target_id: { in: cIds } }] : []), ...(rIds.length ? [{ target_type: 'record', target_id: { in: rIds } }] : [])] },
      select: { source_type: true, source_id: true, target_type: true, target_id: true },
    });
    for (const l of links) {
      // Liên kết giữa chính các bản ghi mẫu với nhau không tính.
      if (l.source_type === 'record' && sample.records.includes(l.source_id)) continue;
      (l.target_type === 'contact' ? cRef : rRef).add(l.target_id);
    }
    // Trường "relation" lưu id ngay trong JSON của bản ghi (không qua record_links): bản ghi thật khác trỏ tới mẫu cũng tính.
    const relFields = await tx.customField.findMany({ where: { type: 'relation' }, select: { key: true, object_id: true, options: true } });
    for (const f of relFields) {
      const o = (f.options ?? {}) as { target?: string; target_object_id?: number };
      const toContact = o.target === 'contact';
      if (!toContact && !rIds.length) continue;
      if (toContact && !cIds.length) continue;
      const holders = await tx.customRecord.findMany({ where: { object_id: f.object_id, deleted_at: null, id: { notIn: sample.records } }, select: { data: true } });
      for (const h of holders) {
        const v = (h.data as Record<string, unknown> | null)?.[f.key];
        for (const id of Array.isArray(v) ? v : [v]) if (typeof id === 'number') (toContact ? cRef : rRef).add(id);
      }
    }
    return { contacts: cIds.filter((id) => !cRef.has(id)), records: rIds.filter((id) => !rRef.has(id)) };
  }

  /** Danh sách khách lưu tổng số trong Redis 60 giây; xoá khách mẫu thì bỏ cache để tổng số không còn đếm cả mẫu. Lỗi Redis bỏ qua. */
  async dropContactCountCache(): Promise<void> {
    try {
      if (!this.redis || typeof this.redis.scan !== 'function') return;
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', '*crm:contacts:count:*', 'COUNT', 200);
        if (keys.length) await this.redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn(`xoá cache tổng số khách lỗi (bỏ qua): ${(err as Error)?.message}`);
    }
  }

  /** 3 khách MẪU cho hệ thống "Khác" (CRM cơ bản). Dữ liệu giả, tên ghi rõ "(mẫu)". Trả id đã tạo + đã ghi theo dõi. */
  async seedContacts(db: Db & Pick<Prisma.TransactionClient, 'settingOption'>, userId: number): Promise<number[]> {
    const stage = await db.settingOption.findFirst({ where: { group_key: 'contact_stage', value: 'new' }, select: { id: true } });
    const rows = [
      { full_name: 'Nguyễn Văn An (mẫu)', phone: '0900000001', company_name: 'Công ty ABC (mẫu)', email: 'an.mau@example.com' },
      { full_name: 'Trần Thị Bình (mẫu)', phone: '0900000002', company_name: 'Cửa hàng Hoa Nắng (mẫu)', email: 'binh.mau@example.com' },
      { full_name: 'Lê Hoàng Cường (mẫu)', phone: '0900000003', company_name: null, email: null },
    ];
    const out: number[] = [];
    for (const r of rows) {
      const c = await db.contact.create({
        data: { ...r, stage_id: stage?.id ?? null, assigned_to: userId, created_by_id: userId, current_address: null },
        select: { id: true },
      });
      out.push(c.id);
    }
    await this.register(db, { contacts: out }, userId);
    return out;
  }
}
