import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';

/** 1 dòng `settings.sample_records` (JSON) giữ id các bản ghi MẪU còn lại — không cần migration, xoá xong thì xoá dòng này. */
export const SAMPLE_RECORDS_KEY = 'sample_records';

export interface SampleIds {
  contacts: number[];
  records: number[];
}

type Db = Pick<Prisma.TransactionClient, 'setting' | 'contact' | 'customRecord'>;

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

  constructor(private readonly prisma: PrismaService) {}

  async read(db: Pick<Prisma.TransactionClient, 'setting'> = this.prisma): Promise<SampleIds | null> {
    const row = await db.setting.findUnique({ where: { key: SAMPLE_RECORDS_KEY }, select: { value: true } });
    return parseSampleIds(row?.value);
  }

  /** Ghi thêm id mẫu (gộp với phần đã có). Gọi CÙNG transaction với lúc tạo mẫu. */
  async register(db: Db, add: Partial<SampleIds>, userId: number | null): Promise<void> {
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
      await this.prisma.$transaction(async (tx) => {
        if (sample.contacts.length) await tx.contact.updateMany({ where: { id: { in: sample.contacts }, deleted_at: null }, data: { deleted_at: now } });
        if (sample.records.length) await tx.customRecord.updateMany({ where: { id: { in: sample.records }, deleted_at: null }, data: { deleted_at: now } });
        await tx.setting.deleteMany({ where: { key: SAMPLE_RECORDS_KEY } });
      });
      this.logger.log(`đã xoá bản ghi mẫu (khách ${sample.contacts.length}, bản ghi ${sample.records.length}) vì có bản ghi thật đầu tiên`);
      return true;
    } catch (err) {
      this.logger.warn(`dọn bản ghi mẫu lỗi (bỏ qua): ${(err as Error)?.message}`);
      return false;
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
