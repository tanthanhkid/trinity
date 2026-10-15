import { Injectable } from '@nestjs/common';
import type { GoogleSheetSync, Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { GoogleSheetsApi } from './google-sheets-api';
import { IMPORT_ORIGIN } from './sheet-import-contacts';
import { columnIndex, type ColumnMap } from './sheet-mapping';
import type { RunStats } from './sync-types';

const BATCH = 500;
const MAX_BATCHES = 4;
const BACKFILL_LIMIT = 5000;
const IMPORT_GRACE_MS = 2000;

type Row = Record<string, unknown>;

/**
 * Xuất khách / bản ghi tuỳ biến MỚI ra Sheet theo outbox `integration_events` (con trỏ riêng `export_cursor`,
 * KHÔNG đụng `dispatched_at` của webhook). Chỉ thêm dòng (append). Không xuất lại dòng do chính việc nhập từ Sheet tạo ra.
 */
@Injectable()
export class SheetExportService {
  constructor(private readonly prisma: PrismaService, private readonly api: GoogleSheetsApi) {}

  /** Con trỏ khởi tạo = id sự kiện mới nhất hiện tại ⇒ chỉ xuất dữ liệu phát sinh SAU khi bật. */
  async currentCursor(): Promise<bigint> {
    const last = await this.prisma.integrationEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    return last?.id ?? 0n;
  }

  async run(sync: GoogleSheetSync, token: string, stats: RunStats, opts: { backfill?: boolean } = {}): Promise<void> {
    const map = sync.column_map as ColumnMap;
    const keys = Object.keys(map);
    const header = await this.ensureHeader(sync, token, Object.values(map));
    const toRow = (v: Row): string[] => header.map((h) => {
      const k = keys.find((x) => map[x].trim().toLowerCase() === h.trim().toLowerCase());
      return k ? cell(v[k]) : '';
    });
    if (opts.backfill) {
      const upto = await this.currentCursor();
      const rows = await this.backfillRows(sync, keys);
      await this.api.append(token, sync.spreadsheet_id, sync.sheet_title, rows.map(toRow));
      stats.created += rows.length;
      stats.read += rows.length;
      await this.advance(sync.id, upto);
      return;
    }
    let cursor = sync.export_cursor;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const events = await this.events(sync, cursor);
      if (events.length === 0) break;
      stats.read += events.length;
      const values = await this.valuesOf(sync, keys, events);
      await this.api.append(token, sync.spreadsheet_id, sync.sheet_title, values.map(toRow));
      stats.created += values.length;
      cursor = events[events.length - 1].id;
      await this.advance(sync.id, cursor);
      if (events.length < BATCH) break;
    }
  }

  /** Dòng tiêu đề của tab; tab trống thì ghi tiêu đề theo ánh xạ. Cột ánh xạ không có trong tiêu đề có sẵn ⇒ lỗi rõ. */
  private async ensureHeader(sync: GoogleSheetSync, token: string, columns: string[]): Promise<string[]> {
    const first = (await this.api.values(token, sync.spreadsheet_id, sync.sheet_title, 1))[0] ?? [];
    if (first.every((c) => c.trim() === '')) {
      await this.api.append(token, sync.spreadsheet_id, sync.sheet_title, [columns]);
      return columns;
    }
    const missing = columns.filter((c) => columnIndex(first, c) < 0);
    if (missing.length > 0) throw new Error(`Tab thiếu cột đã ánh xạ: ${missing.join(', ')}`);
    return first;
  }

  private advance(id: number, cursor: bigint): Promise<unknown> {
    return this.prisma.googleSheetSync.update({ where: { id }, data: { export_cursor: cursor }, select: { id: true } });
  }

  private events(sync: GoogleSheetSync, cursor: bigint) {
    const custom = sync.target_kind === 'custom_object';
    const where: Prisma.IntegrationEventWhereInput = {
      id: { gt: cursor },
      event_type: custom ? 'custom_record.created' : 'contact.created',
      ...(custom ? { payload: { path: ['object', 'key'], equals: sync.target_object_key ?? '' } } : {}),
    };
    return this.prisma.integrationEvent.findMany({ where, orderBy: { id: 'asc' }, take: BATCH, select: { id: true, resource_id: true, payload: true, actor_user_id: true, created_at: true } });
  }

  private async valuesOf(sync: GoogleSheetSync, keys: string[], events: Awaited<ReturnType<SheetExportService['events']>>): Promise<Row[]> {
    if (sync.target_kind === 'custom_object') return this.customValues(sync, events);
    const wanted = events.filter((e) => (e.payload as { origin?: string } | null)?.origin !== IMPORT_ORIGIN);
    const ids = wanted.map((e) => Number(e.resource_id));
    const rows = await this.prisma.contact.findMany({ where: { id: { in: ids }, deleted_at: null }, select: selectOf(keys) });
    const byId = new Map(rows.map((r) => [r.id as number, r as Row]));
    return ids.map((id) => byId.get(id)).filter((r): r is Row => !!r);
  }

  /** Bản ghi tuỳ biến: bỏ sự kiện sinh ra trong cửa sổ một lần NHẬP của cùng bảng (cùng tác nhân) — tránh vòng lặp hai chiều. */
  private async customValues(sync: GoogleSheetSync, events: Awaited<ReturnType<SheetExportService['events']>>): Promise<Row[]> {
    const runs = await this.prisma.googleSheetSyncRun.findMany({
      where: { sync: { direction: 'import', target_kind: 'custom_object', target_object_key: sync.target_object_key }, started_at: { gte: events[0].created_at } },
      select: { started_at: true, finished_at: true, sync: { select: { actor_user_id: true } } },
    });
    const fromImport = (e: (typeof events)[number]): boolean =>
      runs.some((r) => r.sync.actor_user_id === e.actor_user_id && e.created_at >= r.started_at && e.created_at.getTime() <= (r.finished_at ?? new Date()).getTime() + IMPORT_GRACE_MS);
    return events.filter((e) => !fromImport(e)).map((e) => ((e.payload as { record?: { data?: Row } })?.record?.data ?? {}) as Row);
  }

  private async backfillRows(sync: GoogleSheetSync, keys: string[]): Promise<Row[]> {
    if (sync.target_kind === 'custom_object') {
      const obj = await this.prisma.customObject.findFirst({ where: { key: sync.target_object_key as string, deleted_at: null }, select: { id: true } });
      if (!obj) return [];
      const recs = await this.prisma.customRecord.findMany({ where: { object_id: obj.id, deleted_at: null }, orderBy: { id: 'asc' }, take: BACKFILL_LIMIT, select: { data: true } });
      return recs.map((r) => (r.data ?? {}) as Row);
    }
    const rows = await this.prisma.contact.findMany({ where: { deleted_at: null }, orderBy: { id: 'asc' }, take: BACKFILL_LIMIT, select: selectOf(keys) });
    return rows as Row[];
  }
}

function selectOf(keys: string[]): Prisma.ContactSelect {
  return { id: true, ...Object.fromEntries(keys.map((k) => [k, true])) } as Prisma.ContactSelect;
}

function cell(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Có' : 'Không';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
