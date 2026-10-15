import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Extension, ExtensionVersion } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { cronMatches, parseCron } from './cron';
import { ExtensionInputError } from './extension-errors';
import { denoBin, extensionsEnabled } from './extension-flags';
import { ExtensionRunLog, renderLog, type RunMode } from './extension-run-log';
import { ExtensionsDataPort } from './extensions-data.port';
import { limitsOf, type ExtManifest } from './manifest';
import { ExtHost } from './runner/ext-host';
import { InternalGateway } from './runner/gateway';
import { runJob } from './runner/job-runner';
import type { CallResult, JobResult, ToolMeta } from './runner/types';

/** Chạy thử tối đa 30 giây dù manifest cho phép dài hơn — người/agent đang chờ kết quả. */
const DRY_RUN_MAX_MS = 30_000;
const TICK_MS = 30_000;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,19}$/;
const MAX_TOOLS = 10;
const COUNTED = new Set(['tool_error', 'timeout', 'host_crashed']);

export interface ActiveTool { extId: number; key: string; tools: ToolMeta[] }
export interface DryRunOutput { run_id: number; outcome: string; duration_ms: number; log: string; result: unknown; would_write: number; data_requests: number; denied_requests: number }

/**
 * Phần CHẠY của chương trình con trong monolith: một cổng nội bộ + một ext-host (tool) + bộ hẹn giờ (job) + chạy thử. Mọi mã khách chạy ở
 * tiến trình Deno khác; mọi lỗi của chúng chỉ là một giá trị trả về ở đây, không bao giờ ném lên lõi. Cờ tắt ⇒ KHÔNG timer, KHÔNG tiến trình.
 */
@Injectable()
export class ExtensionsRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExtensionsRuntime.name);
  private readonly gateway: InternalGateway;
  private host?: ExtHost;
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, ActiveTool & { token?: string }>();
  private readonly lastMinute = new Map<number, number>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    port: ExtensionsDataPort,
    private readonly runLog: ExtensionRunLog,
  ) {
    this.gateway = new InternalGateway(port);
  }

  onModuleInit(): void {
    if (!extensionsEnabled()) return;
    // Lỗi tạm thời (DB, runLog) không được thành unhandled rejection làm sập tiến trình CRM.
    void this.restoreTools().catch((err) => this.logger.error(`restoreTools: ${(err as Error)?.message ?? err}`));
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.logger.error(`tick: ${(err as Error)?.message ?? err}`));
    }, TICK_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.host?.stop();
    await this.gateway.stop();
  }

  listActiveTools(): ActiveTool[] {
    return extensionsEnabled() ? [...this.active.values()].map(({ extId, key, tools }) => ({ extId, key, tools })) : [];
  }

  /** Bật chạy một phiên bản (đã duyệt). `job` do bộ hẹn giờ nhặt từ DB; `tool` nạp vào ext-host ngay. */
  async activate(e: Extension, v: ExtensionVersion): Promise<void> {
    if (!extensionsEnabled()) throw new ExtensionInputError('Tính năng chương trình con đang tắt trên hệ thống này.');
    if (e.kind === 'api') throw new ExtensionInputError('Loại "api" chưa chạy được ở bản này — hãy dùng "job" hoặc "tool".');
    if (e.kind === 'tool') await this.loadTool(e, v);
  }

  async deactivate(extId: number): Promise<void> {
    for (const [key, t] of this.active) {
      if (t.extId !== extId) continue;
      this.active.delete(key);
      if (t.token) this.gateway.revoke(t.token);
      await this.host?.unload(key).catch(() => undefined);
    }
  }

  /** Chạy thử: tiến trình Deno RIÊNG, cùng khoá quyền như thật, ghi dữ liệu chỉ ĐẾM (không ghi), đọc theo quyền người thử. */
  async dryRun(e: Extension, v: ExtensionVersion, input: { params?: unknown; tool?: string; args?: unknown }, asUserId: number): Promise<DryRunOutput> {
    if (!extensionsEnabled()) throw new ExtensionInputError('Tính năng chương trình con đang tắt trên hệ thống này.');
    const m = v.manifest as unknown as ExtManifest;
    return this.serial(async () => {
      await this.gateway.start();
      const token = this.gateway.issueToken({ extId: e.id, asUserId, read: m.tables.read, write: m.tables.write, dryRun: true });
      const r = await this.execute(e, v, m, token, { ...input, dryRun: true, timeoutCap: DRY_RUN_MAX_MS });
      const stats = this.gateway.revoke(token);
      const log = renderLog(r);
      const run_id = await this.runLog.record(e.id, v.id, 'dry_run', r.outcome, { durationMs: r.durationMs, peakRssKb: r.peakRssKb, log, result: r.result });
      return { run_id, outcome: r.outcome, duration_ms: Math.round(r.durationMs), log, result: r.result, would_write: stats?.wouldWrite ?? 0, data_requests: stats?.calls ?? 0, denied_requests: stats?.denied ?? 0 };
    });
  }

  /** Bộ hẹn giờ: mỗi phút nhặt job `active` khớp lịch, chạy TUẦN TỰ. Công khai để test gọi trực tiếp. */
  async tick(now = new Date()): Promise<number> {
    if (!extensionsEnabled()) return 0;
    const minute = Math.floor(now.getTime() / 60_000);
    const rows = await this.prisma.extension.findMany({ where: { kind: 'job', status: 'active', deleted_at: null, active_version_id: { not: null } }, take: 100 });
    let ran = 0;
    for (const e of rows) {
      const v = await this.prisma.extensionVersion.findUnique({ where: { id: e.active_version_id as number } });
      const sched = (v?.manifest as unknown as ExtManifest | undefined)?.schedule;
      if (!v || !sched || this.lastMinute.get(e.id) === minute || !cronMatches(parseCron(sched), now)) continue;
      this.lastMinute.set(e.id, minute);
      ran++;
      await this.runScheduled(e, v);
    }
    return ran;
  }

  async callTool(key: string, tool: string, args: unknown): Promise<CallResult> {
    const t = this.active.get(key);
    const e = t && (await this.prisma.extension.findUnique({ where: { id: t.extId } }));
    if (!t || !e || e.status !== 'active' || !this.host) return { ok: false, kind: 'unknown_tool', message: `${key}/${tool}` };
    const m = (await this.activeManifest(e)) as ExtManifest;
    const t0 = performance.now();
    const r = await this.host.call(key, tool, args, limitsOf(m).timeoutMs);
    const msg = r.ok ? '' : `${r.kind}: ${r.message}`;
    await this.runLog.record(e.id, e.active_version_id, 'tool_call', r.ok ? 'ok' : r.kind === 'timeout' ? 'timeout' : 'error', { durationMs: performance.now() - t0, log: msg || `tool ${tool} ok` });
    if (r.ok || COUNTED.has(r.kind)) {
      if (await this.runLog.noteOutcome(e.id, r.ok, msg)) await this.deactivate(e.id);
    }
    return r;
  }

  private async runScheduled(e: Extension, v: ExtensionVersion): Promise<void> {
    const m = v.manifest as unknown as ExtManifest;
    await this.serial(async () => {
      await this.gateway.start();
      const token = this.gateway.issueToken({ extId: e.id, read: m.tables.read, write: m.tables.write, dryRun: false });
      const r = await this.execute(e, v, m, token, {});
      const stats = this.gateway.revoke(token);
      const log = renderLog(r) + (stats ? `\n[ghi ${stats.written} dòng, ${stats.calls} lời gọi dữ liệu, ${stats.denied} bị từ chối]` : '');
      await this.runLog.record(e.id, v.id, 'schedule' as RunMode, r.outcome, { durationMs: r.durationMs, peakRssKb: r.peakRssKb, log, result: r.result });
      await this.runLog.noteOutcome(e.id, r.outcome === 'ok', `${r.outcome}: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}`);
    });
  }

  private execute(e: Extension, v: ExtensionVersion, m: ExtManifest, token: string, o: { params?: unknown; tool?: string; args?: unknown; dryRun?: boolean; timeoutCap?: number }): Promise<JobResult> {
    const limits = limitsOf(m);
    const hasData = m.tables.read.length + m.tables.write.length > 0;
    return runJob({
      denoBin: denoBin(),
      kind: e.kind as 'job' | 'tool',
      code: v.code,
      net: [...m.net, ...(hasData ? [this.gateway.hostPort] : [])],
      limits: { ...limits, timeoutMs: Math.min(limits.timeoutMs, o.timeoutCap ?? limits.timeoutMs) },
      params: o.params,
      tool: o.tool,
      args: o.args,
      inputSchema: m.input_schema,
      dryRun: o.dryRun,
      gateway: hasData ? { url: this.gateway.url, token } : undefined,
    });
  }

  private async loadTool(e: Extension, v: ExtensionVersion, restoring = false): Promise<void> {
    const m = v.manifest as unknown as ExtManifest;
    await this.gateway.start();
    this.host ??= new ExtHost({ denoBin: denoBin(), memoryMb: 128, onCrash: ({ stderrTail }) => this.logger.warn(`ext-host chết: ${stderrTail.slice(-200)}`) });
    // Admin bật lại tool = "thử lại": host đã bỏ cuộc (failed) thì dựng lại, không kẹt tới khi restart cả dịch vụ.
    if (this.host.isFailed) await this.host.reset().catch(() => undefined);
    await this.deactivate(e.id);
    const hasData = m.tables.read.length + m.tables.write.length > 0;
    const token = hasData ? this.gateway.issueToken({ extId: e.id, read: m.tables.read, write: m.tables.write, dryRun: false }) : undefined;
    try {
      const tools = await this.host.load({
        ext: e.key, code: v.code, net: [...m.net, ...(hasData ? [this.gateway.hostPort] : [])],
        gateway: token ? { url: this.gateway.url, token } : undefined, inputSchema: m.input_schema, description: e.description || e.name,
      });
      const bad = tools.find((t) => !TOOL_NAME_RE.test(t.name));
      if (bad || tools.length === 0 || tools.length > MAX_TOOLS) throw new Error(bad ? `tên tool "${bad.name}" không hợp lệ (a-z, 0-9, _; tối đa 20 ký tự)` : `cần 1–${MAX_TOOLS} tool`);
      this.active.set(e.key, { extId: e.id, key: e.key, tools, token });
    } catch (err) {
      if (token) this.gateway.revoke(token);
      await this.host.unload(e.key).catch(() => undefined);
      // Bản mới lỗi mà bản cũ đã bị gỡ ở trên → DB vẫn trỏ bản cũ 'active' nhưng không còn gì chạy. Nạp lại bản cũ.
      if (!restoring && e.active_version_id != null && e.active_version_id !== v.id && e.status === 'active') {
        const prev = await this.prisma.extensionVersion.findUnique({ where: { id: e.active_version_id } }).catch(() => null);
        if (prev) await this.loadTool(e, prev, true).catch((re: Error) => this.logger.error(`Không khôi phục được tool ${e.key} bản cũ: ${re.message}`));
      }
      throw new ExtensionInputError(`Không nạp được tool: ${(err as Error).message.slice(0, 300)}`);
    }
  }

  private async restoreTools(): Promise<void> {
    const rows = await this.prisma.extension.findMany({ where: { kind: 'tool', status: 'active', deleted_at: null, active_version_id: { not: null } }, take: 100 });
    for (const e of rows) {
      const v = await this.prisma.extensionVersion.findUnique({ where: { id: e.active_version_id as number } });
      if (!v) continue;
      await this.loadTool(e, v).catch(async (err: Error) => {
        this.logger.error(`Không nạp lại tool ${e.key}: ${err.message}`);
        await this.runLog.noteOutcome(e.id, false, err.message);
      });
    }
  }

  private activeManifest(e: Extension): Promise<unknown> {
    return this.prisma.extensionVersion.findUnique({ where: { id: e.active_version_id as number } }).then((v) => v?.manifest);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
