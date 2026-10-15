import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Extension, type ExtensionVersion } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { extensionsEnabled } from './extension-flags';
import { ExtensionInputError } from './extension-errors';
import { toExtensionView, toVersionView, type ExtensionView, type VersionView } from './extension-view';
import { checkCode, parseManifest, validateKey, validateKind, type ExtManifest } from './manifest';
import { ExtensionsRuntime } from './extensions.runtime';
import { activeNo, findExt, lockExt, versionOf, type ExtRef } from './extension-queries';
export type { ExtRef } from './extension-queries';
import { NotificationsService } from '../notifications/notifications.service';

export const MAX_EXTENSIONS = 100;
/** Trần số phiên bản NHÁP chưa được duyệt/từ chối của một chương trình con — chặn agent đẩy nháp hàng loạt. */
export const MAX_OPEN_DRAFTS = 5;

export interface CreateInput { key: unknown; kind: unknown; name?: unknown; description?: unknown; code: unknown; manifest: unknown; note?: unknown }
export interface UpdateInput { code?: unknown; manifest?: unknown; name?: unknown; description?: unknown; note?: unknown }

const str = (v: unknown, max: number, what: string, req = false): string | null => {
  if (v === undefined || v === null || v === '') {
    if (req) throw new ExtensionInputError(`${what} không được rỗng.`);
    return null;
  }
  if (typeof v !== 'string') throw new ExtensionInputError(`${what} phải là chữ.`);
  return v.trim().slice(0, max);
};

/**
 * Kho chương trình con + luồng NHÁP → DUYỆT → deploy. Quy tắc bất biến:
 *  - mỗi lần sửa = MỘT dòng `extension_versions` mới (không ghi đè); mã/manifest của một phiên bản không bao giờ đổi;
 *  - `approve`/`reject` chỉ do NGƯỜI gọi qua web (controller `extensions.approve`); tool MCP không có đường duyệt;
 *  - deploy / quay lui chỉ tới được phiên bản ĐÃ được duyệt.
 */
@Injectable()
export class ExtensionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: ExtensionsRuntime,
    private readonly notifications: NotificationsService,
  ) {}

  /** Báo người có quyền duyệt khi có bản nháp mới (không chặn luồng chính nếu gửi lỗi). */
  private async notifyPending(name: string, id: number, version: number): Promise<void> {
    try {
      const ids = await this.notifications.findUserIdsWithPermission('extensions.approve');
      await this.notifications.createPendingLogs(ids, 'extension.pending', { title: `Trợ lý AI gửi chương trình con “${name}” (bản ${version}) chờ bạn duyệt`, body: 'Xem mã và quyền xin trước khi duyệt.', action_url: `/extensions?id=${id}` });
    } catch {
      /* thông báo là phụ — bản nháp đã lưu */
    }
  }

  /** Cờ tắt ⇒ coi như tính năng không tồn tại (controller trả 404, tool MCP bị ẩn). */
  assertEnabled(): void {
    if (!extensionsEnabled()) throw new NotFoundException();
  }

  async create(userId: number, input: CreateInput): Promise<{ extension: ExtensionView; version: VersionView }> {
    const key = validateKey(input.key);
    const kind = validateKind(input.kind);
    const code = checkCode(input.code);
    const manifest = parseManifest(kind, input.manifest);
    const name = str(input.name, 120, 'name') ?? key;
    const description = str(input.description, 1000, 'description') ?? '';
    const note = str(input.note, 500, 'note');
    try {
      return await this.prisma.$transaction(async (tx) => {
        if ((await tx.extension.count({ where: { deleted_at: null } })) >= MAX_EXTENSIONS) throw new ExtensionInputError(`Đã đạt tối đa ${MAX_EXTENSIONS} chương trình con.`);
        const e = await tx.extension.create({ data: { key, kind, name, description, created_by: userId, latest_version: 1 } });
        const v = await tx.extensionVersion.create({ data: { extension_id: e.id, version: 1, code, manifest: manifest as unknown as Prisma.InputJsonObject, note, created_by: userId } });
        void this.notifyPending(name, e.id, 1);
        return { extension: toExtensionView(e, null), version: toVersionView(v) };
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ExtensionInputError(`Mã "${key}" đã có chương trình con khác dùng.`);
      throw err;
    }
  }

  /** Tạo PHIÊN BẢN NHÁP mới (không đụng phiên bản đang chạy). Bỏ trống trường nào thì giữ nguyên của phiên bản mới nhất. */
  async update(userId: number, ref: ExtRef, input: UpdateInput): Promise<{ extension: ExtensionView; version: VersionView }> {
    return this.prisma.$transaction(async (tx) => {
      const e = await lockExt(tx, ref);
      const last = await tx.extensionVersion.findFirstOrThrow({ where: { extension_id: e.id }, orderBy: { version: 'desc' } });
      const open = await tx.extensionVersion.count({ where: { extension_id: e.id, review_status: 'draft' } });
      if (open >= MAX_OPEN_DRAFTS) throw new ExtensionInputError(`Đang có ${open} bản nháp chưa được duyệt (tối đa ${MAX_OPEN_DRAFTS}). Chờ người duyệt hoặc từ chối bớt rồi hãy gửi tiếp.`);
      const code = input.code === undefined ? last.code : checkCode(input.code);
      const manifest = input.manifest === undefined ? (last.manifest as unknown as ExtManifest) : parseManifest(e.kind as 'job', input.manifest);
      const next = e.latest_version + 1;
      const v = await tx.extensionVersion.create({ data: { extension_id: e.id, version: next, code, manifest: manifest as unknown as Prisma.InputJsonObject, note: str(input.note, 500, 'note'), created_by: userId } });
      const name = input.name === undefined ? e.name : (str(input.name, 120, 'name') ?? e.name);
      const description = input.description === undefined ? e.description : (str(input.description, 1000, 'description') ?? '');
      // Chưa chạy lần nào mà có bản nháp mới ⇒ quay về `draft` (bản đã duyệt không còn là bản mới nhất).
      const status = e.status === 'approved' ? 'draft' : e.status;
      const upd = await tx.extension.update({ where: { id: e.id }, data: { latest_version: next, name, description, status } });
      void this.notifyPending(name, e.id, next);
      return { extension: toExtensionView(upd, await activeNo(tx, upd)), version: toVersionView(v) };
    });
  }

  async list(filter: { status?: string; kind?: string } = {}): Promise<ExtensionView[]> {
    const rows = await this.prisma.extension.findMany({
      where: { deleted_at: null, ...(filter.status ? { status: filter.status } : {}), ...(filter.kind ? { kind: filter.kind } : {}) },
      orderBy: { id: 'desc' },
      take: MAX_EXTENSIONS,
    });
    const ids = rows.map((r) => r.active_version_id).filter((x): x is number => x !== null);
    const vs = ids.length ? await this.prisma.extensionVersion.findMany({ where: { id: { in: ids } }, select: { id: true, version: true } }) : [];
    const no = new Map(vs.map((v) => [v.id, v.version]));
    return rows.map((r) => toExtensionView(r, r.active_version_id === null ? null : (no.get(r.active_version_id) ?? null)));
  }

  async get(ref: ExtRef): Promise<{ extension: ExtensionView; versions: VersionView[] }> {
    const e = await findExt(this.prisma, ref);
    const vs = await this.prisma.extensionVersion.findMany({ where: { extension_id: e.id }, orderBy: { version: 'desc' }, take: 50 });
    return { extension: toExtensionView(e, await activeNo(this.prisma, e)), versions: vs.map((v) => toVersionView(v)) };
  }

  /** Một phiên bản kèm MÃ — để người duyệt đọc trước khi bấm Duyệt. */
  async getVersion(ref: ExtRef, version: number): Promise<{ extension: ExtensionView; version: VersionView }> {
    const e = await findExt(this.prisma, ref);
    const v = await versionOf(this.prisma, e.id, version);
    return { extension: toExtensionView(e, await activeNo(this.prisma, e)), version: toVersionView(v, true) };
  }

  /** Người DUYỆT một phiên bản (chỉ gọi từ route web của người có `extensions.approve`). */
  async approve(userId: number, ref: ExtRef, version: number): Promise<ExtensionView> {
    return this.review(userId, ref, version, 'approved', null);
  }

  async reject(userId: number, ref: ExtRef, version: number, note: string | null): Promise<ExtensionView> {
    return this.review(userId, ref, version, 'rejected', note?.trim().slice(0, 1000) || null);
  }

  /** Bật chạy một phiên bản ĐÃ DUYỆT (mặc định: bản duyệt mới nhất). Phiên bản chưa duyệt ⇒ từ chối. */
  async deploy(ref: ExtRef, version?: number): Promise<ExtensionView> {
    const e = await findExt(this.prisma, ref);
    const v = version === undefined ? await this.latestApproved(e.id) : await versionOf(this.prisma, e.id, version);
    if (v.review_status !== 'approved') throw new ExtensionInputError(`Phiên bản ${v.version} chưa được NGƯỜI duyệt (đang ${v.review_status === 'rejected' ? 'bị từ chối' : 'là bản nháp'}). Nhờ quản trị viên duyệt trong Trinity rồi hãy deploy.`);
    return this.switchTo(e, v, e.status !== 'disabled');
  }

  /** Quay lui về một phiên bản đã duyệt trước đó (không tạo mã mới — chỉ trỏ lại). */
  async rollback(ref: ExtRef, version: number): Promise<ExtensionView> {
    const e = await findExt(this.prisma, ref);
    if (e.active_version_id === null) throw new ExtensionInputError('Chương trình con chưa từng được deploy nên chưa có gì để quay lui.');
    const v = await versionOf(this.prisma, e.id, version);
    if (v.review_status !== 'approved') throw new ExtensionInputError(`Chỉ quay lui được về phiên bản đã được duyệt (phiên bản ${v.version} chưa duyệt).`);
    if (v.id === e.active_version_id && e.status === 'active') throw new ExtensionInputError(`Phiên bản ${v.version} đang chạy rồi.`);
    return this.switchTo(e, v, e.status !== 'disabled');
  }

  async disable(ref: ExtRef, reason: string): Promise<ExtensionView> {
    const e = await findExt(this.prisma, ref);
    await this.runtime.deactivate(e.id);
    const upd = await this.prisma.extension.update({ where: { id: e.id }, data: { status: 'disabled', disabled_reason: reason.trim().slice(0, 1000) || 'Đã tắt thủ công' } });
    return toExtensionView(upd, await activeNo(this.prisma, upd));
  }

  /** Bật lại chương trình con đã tắt (người duyệt) — chạy lại đúng phiên bản đang trỏ tới. */
  async enable(ref: ExtRef): Promise<ExtensionView> {
    const e = await findExt(this.prisma, ref);
    if (e.active_version_id === null) throw new ExtensionInputError('Chưa có phiên bản nào được deploy để bật lại.');
    const v = await this.prisma.extensionVersion.findUniqueOrThrow({ where: { id: e.active_version_id } });
    return this.switchTo(e, v, true);
  }

  async logs(ref: ExtRef, limit = 20, cursor?: number) {
    const e = await findExt(this.prisma, ref);
    const take = Math.min(Math.max(limit, 1), 50);
    const rows = await this.prisma.extensionRun.findMany({ where: { extension_id: e.id, ...(cursor ? { id: { lt: cursor } } : {}) }, orderBy: { id: 'desc' }, take: take + 1 });
    const page = rows.slice(0, take);
    return {
      runs: page.map((r) => ({ id: r.id, version_id: r.version_id, mode: r.mode, outcome: r.outcome, duration_ms: r.duration_ms, peak_rss_kb: r.peak_rss_kb, started_at: r.started_at.toISOString(), log: r.log, result: r.result })),
      next_cursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** Chạy thử MỘT phiên bản (mặc định mới nhất), KHÔNG ghi dữ liệu thật; kết quả + log được lưu vào nhật ký. */
  async dryRun(userId: number, ref: ExtRef, version: number | undefined, input: { params?: unknown; tool?: string; args?: unknown }) {
    const e = await findExt(this.prisma, ref);
    const v = await versionOf(this.prisma, e.id, version ?? e.latest_version);
    // 🔴 Bản CHƯA duyệt chạy được (để thử) nhưng không được vừa ĐỌC dữ liệu khách vừa có đường ra mạng: mã nháp của agent (có thể bị prompt-injection)
    // sẽ gửi dữ liệu tới host nó tự khai ngay trước khi người duyệt kịp đọc. Cần thử cả hai ⇒ nhờ người duyệt trước rồi chạy thử bản đã duyệt.
    if (v.review_status !== 'approved') {
      const m = v.manifest as unknown as ExtManifest;
      if (m.net.length > 0 && m.tables.read.length + m.tables.write.length > 0) {
        throw new ExtensionInputError('Bản chưa được người duyệt không được chạy thử khi vừa xin đọc/ghi bảng dữ liệu vừa xin gọi mạng ngoài (chống rò dữ liệu). Hãy chạy thử riêng từng phần (bản chỉ có net, hoặc bản chỉ có tables), hoặc nhờ người duyệt rồi chạy thử bản đã duyệt.');
      }
    }
    return { version: v.version, ...(await this.runtime.dryRun(e, v, input, userId)) };
  }

  private async review(userId: number, ref: ExtRef, version: number, to: 'approved' | 'rejected', note: string | null): Promise<ExtensionView> {
    return this.prisma.$transaction(async (tx) => {
      const e = await lockExt(tx, ref);
      const v = await versionOf(tx, e.id, version);
      if (v.review_status !== 'draft') throw new ExtensionInputError(`Phiên bản ${version} đã được xử lý (${v.review_status}).`);
      await tx.extensionVersion.update({ where: { id: v.id }, data: { review_status: to, review_note: note, reviewed_by: userId, reviewed_at: new Date() } });
      const status = to === 'approved' && e.status === 'draft' ? 'approved' : e.status;
      const upd = await tx.extension.update({ where: { id: e.id }, data: { status } });
      return toExtensionView(upd, await activeNo(tx, upd));
    });
  }

  /**
   * Trỏ `active_version_id` sang phiên bản `v`. Chương trình con đang TẮT (người tắt / cầu dao tự tắt) KHÔNG bị deploy/quay lui của agent
   * bật lại ngầm: chỉ đổi con trỏ, vẫn `disabled` — bật lại là việc của người (`enable`).
   */
  private async switchTo(e: Extension, v: ExtensionVersion, reactivate: boolean): Promise<ExtensionView> {
    if (!reactivate) {
      const upd = await this.prisma.extension.update({ where: { id: e.id }, data: { active_version_id: v.id } });
      return toExtensionView(upd, v.version);
    }
    await this.runtime.activate(e, v);
    const upd = await this.prisma.extension.update({ where: { id: e.id }, data: { status: 'active', active_version_id: v.id, consecutive_failures: 0, disabled_reason: null } });
    return toExtensionView(upd, v.version);
  }

  private async latestApproved(extId: number): Promise<ExtensionVersion> {
    const v = await this.prisma.extensionVersion.findFirst({ where: { extension_id: extId, review_status: 'approved' }, orderBy: { version: 'desc' } });
    if (!v) throw new ExtensionInputError('Chưa có phiên bản nào được NGƯỜI duyệt. Nhờ quản trị viên duyệt trong Trinity rồi hãy deploy.');
    return v;
  }
}
