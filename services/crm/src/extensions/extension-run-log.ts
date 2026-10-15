import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { maskPhonesInText } from '../integrations/mcp/ai-output';
import { NotificationsService } from '../notifications/notifications.service';
import { maxConsecutiveFailures } from './extension-flags';
import type { JobResult } from './runner/types';

export type RunMode = 'dry_run' | 'schedule' | 'manual' | 'tool_call';
const MAX_LOG = 16 * 1024;
const KEEP_RUNS = 200;
export const NOTIFY_AUTO_DISABLED = 'extension.auto_disabled';

/** Gộp stdout + stderr, che SĐT (log là dữ liệu do mã khách in ra), cắt độ dài. */
export function renderLog(r: Pick<JobResult, 'stdout' | 'stderr'>): string {
  const out = r.stdout.replace(/^__EXT_(READY__|RESULT__ .*)$/gm, '').trim();
  const err = r.stderr.trim();
  const text = [out, err && `--- stderr ---\n${err}`].filter(Boolean).join('\n');
  const masked = maskPhonesInText(text);
  return masked.length > MAX_LOG ? `${masked.slice(0, MAX_LOG / 2)}\n…[đã cắt]…\n${masked.slice(-MAX_LOG / 2)}` : masked;
}

/** Nhật ký chạy + cầu dao: lỗi LIÊN TIẾP đủ ngưỡng thì tự tắt chương trình con và báo người có quyền duyệt. */
@Injectable()
export class ExtensionRunLog {
  private readonly logger = new Logger(ExtensionRunLog.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async record(extId: number, versionId: number | null, mode: RunMode, outcome: string, r: { durationMs: number; peakRssKb?: number | null; log: string; result?: unknown }): Promise<number> {
    const row = await this.prisma.extensionRun.create({
      data: { extension_id: extId, version_id: versionId, mode, outcome, duration_ms: Math.round(r.durationMs), peak_rss_kb: r.peakRssKb ?? null, log: r.log.slice(0, MAX_LOG + 64), result: (r.result ?? undefined) as Prisma.InputJsonValue | undefined },
      select: { id: true },
    });
    if (row.id % 20 === 0) void this.prune(extId);
    return row.id;
  }

  /** Ghi kết quả thật (không phải chạy thử) vào cầu dao. Trả true nếu LẦN NÀY làm cầu dao ngắt (đã chuyển `disabled`). */
  async noteOutcome(extId: number, ok: boolean, error: string): Promise<boolean> {
    if (ok) {
      await this.prisma.extension.updateMany({ where: { id: extId, consecutive_failures: { gt: 0 } }, data: { consecutive_failures: 0 } });
      return false;
    }
    const e = await this.prisma.extension.update({ where: { id: extId }, data: { consecutive_failures: { increment: 1 } }, select: { consecutive_failures: true, status: true, name: true, key: true } });
    if (e.status !== 'active' || e.consecutive_failures < maxConsecutiveFailures()) return false;
    const reason = `Tự tắt sau ${e.consecutive_failures} lần lỗi liên tiếp. Lỗi cuối: ${error}`.slice(0, 1000);
    const { count } = await this.prisma.extension.updateMany({ where: { id: extId, status: 'active' }, data: { status: 'disabled', disabled_reason: reason } });
    if (count === 0) return false;
    this.logger.warn(`Chương trình con ${e.key} tự tắt: ${reason}`);
    void this.notifyAdmins(e.name, extId);
    return true;
  }

  private async notifyAdmins(name: string, id: number): Promise<void> {
    try {
      const ids = await this.notifications.findUserIdsWithPermission('extensions.approve');
      await this.notifications.createPendingLogs(ids, NOTIFY_AUTO_DISABLED, { title: `Chương trình con “${name}” đã tự tắt vì lỗi liên tục`, body: 'Xem nhật ký chạy để biết nguyên nhân, sửa rồi bật lại.', action_url: `/extensions?id=${id}` });
    } catch (err) {
      this.logger.error(`Không gửi được thông báo tự tắt #${id}: ${(err as Error)?.message}`);
    }
  }

  private async prune(extId: number): Promise<void> {
    try {
      const keep = await this.prisma.extensionRun.findMany({ where: { extension_id: extId }, orderBy: { id: 'desc' }, take: 1, skip: KEEP_RUNS, select: { id: true } });
      if (keep[0]) await this.prisma.extensionRun.deleteMany({ where: { extension_id: extId, id: { lte: keep[0].id } } });
    } catch (err) {
      this.logger.warn(`Dọn nhật ký chạy lỗi: ${(err as Error)?.message}`);
    }
  }
}
