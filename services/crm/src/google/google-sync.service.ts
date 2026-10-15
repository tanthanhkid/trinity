import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { GoogleConnection, GoogleSheetSync, Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { PermissionService } from '@trinity/rbac-nest';
import type { CreateSyncDto, UpdateSyncDto } from './dto/google-sync.dto';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleSheetsApi, parseSpreadsheetId } from './google-sheets-api';
import { SheetExportService } from './sheet-export.service';
import { SheetImportContacts } from './sheet-import-contacts';
import { SheetImportCustom } from './sheet-import-custom';
import { CONTACT_FIELD_KEYS, dropDuplicateRows, mapRows, type ColumnMap } from './sheet-mapping';
import { emptyStats, type RunStats } from './sync-types';
import { assertTargetPermission, validateColumnMap, validateDedupe } from './sync-validation';

export type RunTrigger = 'manual' | 'schedule';
const STALE_RUNNING_MS = 10 * 60_000;

/** Cấu hình + chạy đồng bộ Google Sheet (nhập / xuất). Mỗi lần chạy ghi 1 dòng `google_sheet_sync_runs`. */
@Injectable()
export class GoogleSyncService {
  private readonly logger = new Logger(GoogleSyncService.name);
  private readonly running = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: GoogleOAuthService,
    private readonly api: GoogleSheetsApi,
    private readonly importContacts: SheetImportContacts,
    private readonly importCustom: SheetImportCustom,
    private readonly exporter: SheetExportService,
    private readonly permissions: PermissionService,
  ) {}

  list(): Promise<GoogleSheetSync[]> {
    return this.prisma.googleSheetSync.findMany({ where: { deleted_at: null }, orderBy: { id: 'desc' }, take: 200 });
  }

  async get(id: number): Promise<GoogleSheetSync> {
    const s = await this.prisma.googleSheetSync.findFirst({ where: { id, deleted_at: null } });
    if (!s) throw new NotFoundException('Không tìm thấy cấu hình đồng bộ');
    return s;
  }

  async runs(id: number) {
    await this.get(id);
    return this.prisma.googleSheetSyncRun.findMany({ where: { sync_id: id }, orderBy: { started_at: 'desc' }, take: 30 });
  }

  /** Tab + dòng tiêu đề của một Sheet (để người dùng ánh xạ cột). */
  async inspect(spreadsheet: string, tab?: string) {
    const id = parseSpreadsheetId(spreadsheet);
    if (!id) throw new BadRequestException('Không nhận ra URL/ID Google Sheet');
    const conn = await this.oauth.requireCurrent();
    const token = await this.oauth.accessToken(conn);
    const meta = await this.api.meta(token, id);
    let headers: string[] = [];
    if (tab && meta.tabs.includes(tab)) headers = ((await this.api.values(token, id, tab, 1))[0] ?? []).map((h) => h.trim()).filter(Boolean);
    return { spreadsheet_id: id, title: meta.title, tabs: meta.tabs, headers };
  }

  /** Nguồn khách phải thuộc nhóm `contact_source` và đang bật (cùng luật với trang Facebook). */
  private async assertContactSource(sourceId: number | null | undefined): Promise<void> {
    if (sourceId == null) return;
    const o = await this.prisma.settingOption.findUnique({ where: { id: sourceId }, select: { group_key: true, is_active: true } });
    if (!o || o.group_key !== 'contact_source' || !o.is_active) throw new BadRequestException('Nguồn khách không hợp lệ hoặc đang tắt');
  }

  /** Chạy tay: người chạy phải có đúng quyền với đích của cấu hình (xuất cả công ty ra ngoài cần phạm vi `all`). */
  async runAs(id: number, user: AuthUser, opts: { backfill?: boolean } = {}): Promise<RunStats> {
    const sync = await this.get(id);
    assertTargetPermission(user, sync.target_kind as 'contact' | 'custom_object', sync.direction as 'import' | 'export');
    return this.execute(id, 'manual', opts);
  }

  async create(dto: CreateSyncDto, user: AuthUser): Promise<GoogleSheetSync> {
    assertTargetPermission(user, dto.target_kind, dto.direction);
    await this.assertContactSource(dto.contact_source_id);
    const allowed = await this.allowedFields(dto.target_kind, dto.target_object_key);
    const map = validateColumnMap(dto.column_map, allowed);
    const dedupe = validateDedupe(dto.target_kind, dto.dedupe_key, map, dto.direction);
    const conn = await this.oauth.requireCurrent();
    const spreadsheetId = await this.resolveSpreadsheet(dto, conn);
    const actor = dto.direction === 'import' ? (dto.actor_user_id ?? user.userId) : user.userId;
    const cursor = dto.direction === 'export' ? await this.exporter.currentCursor() : 0n;
    return this.prisma.googleSheetSync.create({
      data: {
        name: dto.name.trim(), direction: dto.direction, connection_id: conn.id, spreadsheet_id: spreadsheetId,
        sheet_title: dto.sheet_title.trim(), target_kind: dto.target_kind,
        target_object_key: dto.target_kind === 'custom_object' ? dto.target_object_key : null,
        column_map: map as Prisma.InputJsonValue, dedupe_key: dedupe, actor_user_id: actor,
        contact_source_id: dto.contact_source_id ?? null, schedule_minutes: dto.schedule_minutes ?? null,
        export_cursor: cursor, created_by: user.userId,
      },
    });
  }

  async update(id: number, dto: UpdateSyncDto, user: AuthUser): Promise<GoogleSheetSync> {
    const cur = await this.get(id);
    assertTargetPermission(user, cur.target_kind as 'contact' | 'custom_object', cur.direction as 'import' | 'export');
    const data: Prisma.GoogleSheetSyncUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.is_active !== undefined) data.is_active = dto.is_active;
    if (dto.schedule_minutes !== undefined) data.schedule_minutes = dto.schedule_minutes;
    if (dto.contact_source_id !== undefined) {
      await this.assertContactSource(dto.contact_source_id);
      data.contact_source_id = dto.contact_source_id;
    }
    if (dto.column_map) {
      const map = validateColumnMap(dto.column_map, await this.allowedFields(cur.target_kind as 'contact' | 'custom_object', cur.target_object_key ?? undefined));
      data.column_map = map as Prisma.InputJsonValue;
      data.dedupe_key = validateDedupe(cur.target_kind as 'contact' | 'custom_object', dto.dedupe_key ?? cur.dedupe_key, map, cur.direction as 'import' | 'export');
    }
    return this.prisma.googleSheetSync.update({ where: { id }, data });
  }

  async remove(id: number, user: AuthUser): Promise<void> {
    const cur = await this.get(id);
    assertTargetPermission(user, cur.target_kind as 'contact' | 'custom_object', cur.direction as 'import' | 'export');
    await this.prisma.googleSheetSync.update({ where: { id }, data: { deleted_at: new Date(), is_active: false } });
  }

  /** Trường cho phép ánh xạ theo đích (khách: danh sách cố định; tuỳ biến: trường sống, không công thức). */
  async allowedFields(kind: 'contact' | 'custom_object', objectKey?: string): Promise<string[]> {
    if (kind === 'contact') return [...CONTACT_FIELD_KEYS];
    if (!objectKey) throw new BadRequestException('Thiếu target_object_key');
    const obj = await this.prisma.customObject.findFirst({ where: { key: objectKey, deleted_at: null }, include: { fields: { where: { deleted_at: null } } } });
    if (!obj) throw new BadRequestException(`Bảng tuỳ biến "${objectKey}" không tồn tại`);
    return obj.fields.filter((f) => f.type !== 'formula').map((f) => f.key);
  }

  private async resolveSpreadsheet(dto: CreateSyncDto, conn: GoogleConnection): Promise<string> {
    if (dto.create_sheet) {
      if (dto.direction !== 'export') throw new BadRequestException('Chỉ tạo Sheet mới cho cấu hình xuất');
      const token = await this.oauth.accessToken(conn);
      return (await this.api.create(token, dto.name.trim(), dto.sheet_title.trim())).id;
    }
    const id = parseSpreadsheetId(dto.spreadsheet ?? '');
    if (!id) throw new BadRequestException('Không nhận ra URL/ID Google Sheet');
    const token = await this.oauth.accessToken(conn);
    const meta = await this.api.meta(token, id);
    if (!meta.tabs.includes(dto.sheet_title)) throw new BadRequestException(`Sheet không có tab "${dto.sheet_title}"`);
    return id;
  }

  /** Chạy một cấu hình. Không chạy chồng (cùng cấu hình); lỗi được ghi vào run + sync, không ném ra caller định kỳ. */
  async execute(id: number, trigger: RunTrigger, opts: { backfill?: boolean } = {}): Promise<RunStats> {
    // Giữ chỗ ĐỒNG BỘ ngay sau kiểm tra (trước mọi await) — hai lần gọi đồng thời không cùng lọt qua được.
    if (this.running.has(id)) throw new ConflictException('Cấu hình này đang chạy');
    this.running.add(id);
    let sync: GoogleSheetSync;
    let run: { id: bigint };
    try {
      sync = await this.get(id);
      const stale = new Date(Date.now() - STALE_RUNNING_MS);
      const busy = await this.prisma.googleSheetSyncRun.findFirst({ where: { sync_id: id, status: 'running', started_at: { gt: stale } }, select: { id: true } });
      if (busy) throw new ConflictException('Cấu hình này đang chạy');
      run = await this.prisma.googleSheetSyncRun.create({ data: { sync_id: id, trigger }, select: { id: true } });
    } catch (e) {
      this.running.delete(id);
      throw e;
    }
    const stats = emptyStats();
    let error: string | null = null;
    try {
      if (trigger === 'schedule') await this.assertActorStillAllowed(sync);
      await this.runBody(sync, stats, opts);
    } catch (e) {
      error = ((e as Error)?.message ?? 'lỗi không rõ').slice(0, 500);
      this.logger.warn(`Đồng bộ Google Sheet sync=${id} lỗi: ${error}`);
    } finally {
      this.running.delete(id);
    }
    const status = error ? 'error' : stats.errors > 0 ? 'partial' : 'ok';
    const now = new Date();
    await this.prisma.googleSheetSyncRun.update({ where: { id: run.id }, data: { finished_at: now, status, stats: stats as unknown as Prisma.InputJsonValue, error } });
    await this.prisma.googleSheetSync.update({ where: { id }, data: { last_run_at: now, last_status: status, last_error: error } });
    if (error && trigger === 'manual') throw new BadRequestException(error);
    return stats;
  }

  /** Lịch tự chạy phải kiểm lại người thiết lập: còn hoạt động và còn đúng quyền; không thì tắt cấu hình. */
  private async assertActorStillAllowed(sync: GoogleSheetSync): Promise<void> {
    const u = await this.prisma.user.findUnique({ where: { id: sync.created_by }, select: { id: true, email: true, status: true, deleted_at: true } });
    let reason: string | null = null;
    if (!u || u.status !== 'active' || u.deleted_at) reason = 'Người thiết lập cấu hình không còn hoạt động';
    else {
      const { grants, isAdmin } = await this.permissions.grantsFor(u.id);
      try {
        assertTargetPermission({ userId: u.id, email: u.email, isAdmin, grants }, sync.target_kind as 'contact' | 'custom_object', sync.direction as 'import' | 'export');
      } catch (e) {
        reason = `Người thiết lập không còn quyền: ${(e as Error).message}`;
      }
    }
    if (reason) {
      await this.prisma.googleSheetSync.update({ where: { id: sync.id }, data: { is_active: false } });
      throw new Error(reason);
    }
  }

  private async runBody(sync: GoogleSheetSync, stats: RunStats, opts: { backfill?: boolean }): Promise<void> {
    const conn = await this.oauth.requireCurrent();
    const token = await this.oauth.accessToken(conn);
    if (sync.direction === 'export') return this.exporter.run(sync, token, stats, opts);
    const values = await this.api.values(token, sync.spreadsheet_id, sync.sheet_title);
    const { rows, missingColumns } = mapRows(values, sync.column_map as ColumnMap);
    if (missingColumns.length > 0) throw new Error(`Sheet thiếu cột đã ánh xạ: ${missingColumns.join(', ')}`);
    const { kept, duplicates, invalid } = dropDuplicateRows(rows, sync.dedupe_key);
    stats.read = rows.length;
    stats.duplicates_in_sheet = duplicates;
    stats.invalid = invalid.length;
    if (sync.target_kind === 'contact') await this.importContacts.run(sync, kept, stats);
    else await this.importCustom.run(sync, kept, stats);
  }

  /** Cấu hình đến hạn tự chạy. */
  async due(now = new Date()): Promise<number[]> {
    const all = await this.prisma.googleSheetSync.findMany({ where: { is_active: true, deleted_at: null, schedule_minutes: { not: null } }, select: { id: true, schedule_minutes: true, last_run_at: true } });
    return all.filter((s) => !s.last_run_at || now.getTime() - s.last_run_at.getTime() >= (s.schedule_minutes as number) * 60_000).map((s) => s.id);
  }
}
