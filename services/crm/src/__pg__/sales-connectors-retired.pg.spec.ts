import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaService } from '@trinity/prisma';
import { describePg, pgClient, resetTables } from './pg-harness';

/**
 * Migrations 0023 (G06 — gỡ kết nối phần mềm bán hàng và sàn TMĐT) trên và 0025 (G07b — gỡ cổng thanh toán) trên Postgres THẬT: kết nối cũ của nhà cung cấp đã gỡ
 * thành `disconnected`, khoá đã lưu bị xoá trắng; cổng thanh toán không bị đụng; bản ghi đã đồng bộ và sự kiện giữ
 * nguyên làm lưu trữ. Chạy SQL hai lần phải cho cùng kết quả. Tên nhà cung cấp cũ không xuất hiện trong mã: dùng tên giả.
 */
const TABLES = ['connector_accounts', 'connector_records', 'connector_events', 'payment_intents', 'webhook_endpoints'];
const MIGRATION = join(__dirname, '../../../../packages/prisma/prisma/migrations/0023_go_ket_noi_ban_hang/migration.sql');
const MIGRATION_PAY = join(__dirname, '../../../../packages/prisma/prisma/migrations/0025_go_cong_thanh_toan/migration.sql');
const RETIRED = 'ban_hang_cu';

function statements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

describePg('Migration 0023 + 0025 — gỡ kết nối (Postgres thật)', () => {
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
  });

  it('migration 0025 (G07b): cổng thanh toán ⇒ disconnected + xoá khoá; yêu cầu thanh toán, sự kiện giữ nguyên; chạy lại không đổi; không đè lời nhắn của 0023', async () => {
    await db.connectorAccount.create({ data: { provider: RETIRED, status: 'disconnected', credentials_enc: '', last_error: 'giu-nguyen', connected_by: 1 } });
    for (const p of ['sepay', 'vnpay', 'momo']) await db.connectorAccount.create({ data: { provider: p, status: 'active', credentials_enc: `khoa-${p}`, settings: { tmn_code: 'X' }, connected_by: 1 } });
    await db.$executeRawUnsafe("INSERT INTO payment_intents (code, amount, status, source_type, created_by, updated_at) VALUES ('TRNAAAAAA', 1000, 'pending', 'manual', 1, now())");
    await db.connectorEvent.create({ data: { provider: 'sepay', external_id: 'e2', kind: 'payment', status: 'matched' } });
    await db.webhookEndpoint.create({ data: { name: 'w', url: 'https://example.com/h', secret_enc: 'x', events: ['contact.created', 'payment.received'], created_by: 1 } });

    const sql = statements(readFileSync(MIGRATION_PAY, 'utf8'));
    for (let run = 0; run < 2; run++) for (const s of sql) await db.$executeRawUnsafe(s);

    for (const p of ['sepay', 'vnpay', 'momo']) {
      const a = await db.connectorAccount.findUniqueOrThrow({ where: { provider: p } });
      expect(a).toMatchObject({ status: 'disconnected', credentials_enc: '', settings: { tmn_code: 'X' } });
      expect(a.last_error).toMatch(/ngừng hỗ trợ/);
    }
    expect((await db.connectorAccount.findUniqueOrThrow({ where: { provider: RETIRED } })).last_error).toBe('giu-nguyen');
    expect(await db.$queryRawUnsafe<Array<{ n: bigint }>>("SELECT count(*) AS n FROM payment_intents WHERE status = 'pending'")).toEqual([{ n: 1n }]);
    expect(await db.connectorEvent.count()).toBe(1);
    expect((await db.webhookEndpoint.findFirstOrThrow()).events).toEqual(['contact.created']);
  });
});
