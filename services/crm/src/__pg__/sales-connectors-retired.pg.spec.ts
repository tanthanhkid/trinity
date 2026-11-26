import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaService } from '@trinity/prisma';
import { describePg, pgClient, resetTables } from './pg-harness';
import { ConnectorsService } from '../connectors/connectors.service';

/**
 * Migration 0023 (G06 — gỡ kết nối phần mềm bán hàng và sàn TMĐT) trên Postgres THẬT: kết nối cũ của nhà cung cấp đã gỡ
 * thành `disconnected`, khoá đã lưu bị xoá trắng; cổng thanh toán không bị đụng; bản ghi đã đồng bộ và sự kiện giữ
 * nguyên làm lưu trữ. Chạy SQL hai lần phải cho cùng kết quả. Tên nhà cung cấp cũ không xuất hiện trong mã: dùng tên giả.
 */
const TABLES = ['connector_accounts', 'connector_records', 'connector_events'];
const MIGRATION = join(__dirname, '../../../../packages/prisma/prisma/migrations/0023_go_ket_noi_ban_hang/migration.sql');
const RETIRED = 'ban_hang_cu';

function statements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

describePg('Migration 0023 — gỡ kết nối bán hàng/sàn (Postgres thật)', () => {
  let db: PrismaService;
  beforeAll(() => {
    db = pgClient();
  });
  afterAll(() => db.$disconnect());
  beforeEach(() => resetTables(db, TABLES));

  it('kết nối đã gỡ ⇒ disconnected + xoá khoá; cổng thanh toán giữ nguyên; dữ liệu đồng bộ còn; chạy lại không đổi', async () => {
    await db.connectorAccount.create({ data: { provider: RETIRED, status: 'active', credentials_enc: 'khoa-da-ma-hoa', settings: { retailer: 'cua-hang' }, connected_by: 1 } });
    await db.connectorAccount.create({ data: { provider: 'sepay', status: 'active', credentials_enc: 'khoa-sepay', settings: { account_number: '0123' }, connected_by: 1 } });
    await db.connectorRecord.create({ data: { provider: RETIRED, kind: 'order', external_id: '77', amount: 350000n } });
    await db.connectorEvent.create({ data: { provider: RETIRED, external_id: 'e1', kind: 'order', status: 'ignored' } });

    const sql = statements(readFileSync(MIGRATION, 'utf8'));
    for (let run = 0; run < 2; run++) for (const s of sql) await db.$executeRawUnsafe(s);

    const retired = await db.connectorAccount.findUniqueOrThrow({ where: { provider: RETIRED } });
    expect(retired).toMatchObject({ status: 'disconnected', credentials_enc: '', settings: { retailer: 'cua-hang' } });
    expect(retired.last_error).toMatch(/ngừng hỗ trợ/);
    expect(await db.connectorAccount.findUniqueOrThrow({ where: { provider: 'sepay' } })).toMatchObject({ status: 'active', credentials_enc: 'khoa-sepay', last_error: null });
    expect(await db.connectorRecord.count()).toBe(1);
    expect(await db.connectorEvent.count()).toBe(1);

    // Trang Kết nối chỉ còn cổng thanh toán.
    const list = await new ConnectorsService(db).list();
    expect(list.map((c) => c.provider)).toEqual(['sepay', 'vnpay', 'momo']);
  });
});
