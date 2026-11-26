import * as fs from 'fs';
import * as path from 'path';
import type { PrismaService } from '@trinity/prisma';
import { describePg, isLocalDbUrl, pgClient, PG_URL } from './pg-harness';

/**
 * Bảng ca serializer JSON dùng chung TS ↔ Rust (K10, PLAN 4.4): `server/contracts/cases/serializer.json`.
 * Bản Node là chuẩn: đọc giá trị bằng Prisma (câu `SELECT <giá trị>` cho từng kiểu cột, và đọc cả dòng của model có
 * cột `timestamp` không múi giờ) rồi `JSON.stringify` như API (BigInt qua `toJSON = Number(this)`, như
 * `apps/monolith/src/bootstrap-app.ts`). Rust đọc cùng giá trị vào struct sinh tự động và so từng byte
 * (`server/crates/trinity-db/tests/serializer_pg.rs`). Sinh lại cột `out`: `UPDATE_SERIALIZER_CASES=1`.
 */
const FILE = path.resolve(__dirname, '../../../../server/contracts/cases/serializer.json');

type Scalar = { sql: string; rust: string; out?: string };
type ModelCase = { model: string; delegate: string; table: string; insert: string; out?: string };
type Table = { _doc: string; scalar: Scalar[]; model: ModelCase[] };

const bigintProto = BigInt.prototype as unknown as { toJSON?: () => number };

describePg('bảng ca serializer JSON (server/contracts/cases/serializer.json)', () => {
  let db: PrismaService;
  const table = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Table;
  const fresh: Table = { ...table, scalar: [], model: [] };
  const saved = bigintProto.toJSON;

  beforeAll(async () => {
    if (!isLocalDbUrl(PG_URL)) throw new Error('TEST_DATABASE_URL phải trỏ vào Postgres cục bộ/CI');
    bigintProto.toJSON = function (this: bigint) {
      return Number(this);
    };
    db = pgClient();
    for (const c of table.scalar) {
      const rows = await db.$queryRawUnsafe<{ v: unknown }[]>(`SELECT ${c.sql} AS v`).catch((e: Error) => {
        throw new Error(`${c.sql}: ${e.message}`);
      });
      fresh.scalar.push({ sql: c.sql, rust: c.rust, out: JSON.stringify(rows[0].v) });
    }
    for (const c of table.model) {
      await db.$executeRawUnsafe(`TRUNCATE "${c.table}" RESTART IDENTITY CASCADE`);
      await db.$executeRawUnsafe(c.insert).catch((e: Error) => {
        throw new Error(`${c.model}: ${e.message}`);
      });
      const delegate = (db as unknown as Record<string, { findFirst: () => Promise<unknown> }>)[c.delegate];
      const row = await delegate.findFirst();
      fresh.model.push({ ...c, out: JSON.stringify(row) });
      await db.$executeRawUnsafe(`TRUNCATE "${c.table}" RESTART IDENTITY CASCADE`);
    }
    if (process.env.UPDATE_SERIALIZER_CASES === '1') fs.writeFileSync(FILE, `${JSON.stringify(fresh, null, 1)}\n`);
  });

  afterAll(async () => {
    bigintProto.toJSON = saved;
    await db?.$disconnect();
  });

  it('có ít nhất 40 ca', () => {
    expect(table.scalar.length + table.model.length).toBeGreaterThanOrEqual(40);
  });

  it('kết quả Node khớp cột out', () => {
    const update = process.env.UPDATE_SERIALIZER_CASES === '1';
    expect(fresh).toEqual(update ? fresh : table);
  });
});
