import { NotFoundException } from '@nestjs/common';
import { DATA_NOTICE } from '../ai-output';
import { ExtensionInputError } from '../../../extensions/extension-errors';
import { extensionsEnabled } from '../../../extensions/extension-flags';
import type { CreateInput } from '../../../extensions/extensions.service';
import { ToolUserError, type ToolContext, type ToolDef, type ToolOutput, type Z } from './tool-types';
import { EXTENSION_GUIDE } from './extension-guide';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;
const KEY = (z: Z) => z.string().min(1).max(40).describe('Mã chương trình con: a-z, 0-9, gạch ngang (vd dong-bo-sheet) / Extension key');
const MANIFEST = (z: Z) => z.record(z.string(), z.unknown()).describe('{net, tables:{read,write}, schedule?, input_schema?, limits?} — xem hướng dẫn / Manifest');
const OUT = (z: Z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) });
const ver = (z: Z) => z.number().int().min(1).max(2_147_483_647).optional().describe('Số phiên bản / Version number');

/** Trả dữ liệu cho agent. KHÔNG qua `wrapData`: bộ lọc đó cắt chuỗi 500 ký tự, làm hỏng mã nguồn/nhật ký; log đã che SĐT lúc lưu. */
const out = (data: Record<string, unknown>): ToolOutput => {
  const o = { notice: DATA_NOTICE, data };
  return { structured: o, text: JSON.stringify(o) };
};

/** Cờ tắt ⇒ lỗi rõ ràng; lỗi đầu vào/không tìm thấy của chương trình con ⇒ trả nguyên văn cho agent sửa. */
async function guard(ctx: ToolContext, fn: () => Promise<ToolOutput>): Promise<ToolOutput> {
  if (!extensionsEnabled() || !ctx.deps.extensions) throw new ToolUserError('Tính năng chương trình con chưa được bật trên hệ thống này.');
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ExtensionInputError || err instanceof NotFoundException) throw new ToolUserError(err.message);
    throw err;
  }
}

const keyOf = (args: Record<string, unknown>): string => {
  if (typeof args.key !== 'string' || !args.key) throw new ToolUserError('Thiếu key');
  return args.key;
};
const verOf = (args: Record<string, unknown>): number | undefined => (typeof args.version === 'number' ? args.version : undefined);
const ex = (ctx: ToolContext) => ctx.deps.extensions!;

export const createExtensionTool: ToolDef = {
  name: 'create_extension',
  title: 'Tạo chương trình con (bản nháp) / Create extension',
  description: `Tạo một chương trình con MỚI ở trạng thái NHÁP (chưa chạy gì). ${EXTENSION_GUIDE} / Creates a DRAFT sandboxed extension (job/tool); a human must approve it before it can run.`,
  permissions: ['extensions.draft'],
  scope: 'crm.write',
  annotations: WRITE,
  input: (z) => ({
    key: KEY(z),
    kind: z.enum(['job', 'tool', 'api']).describe('job = chạy theo lịch · tool = công cụ MCP mới · api = chưa hỗ trợ chạy'),
    name: z.string().max(120).optional().describe('Tên hiển thị tiếng Việt cho người duyệt / Display name'),
    description: z.string().max(1000).optional().describe('Việc này làm gì, vì sao cần — người duyệt đọc dòng này đầu tiên / What it does'),
    code: z.string().min(1).max(262_144).describe('Mã TypeScript (tối đa 256 KB) / TypeScript source'),
    manifest: MANIFEST(z),
    note: z.string().max(500).optional().describe('Ghi chú phiên bản / Version note'),
  }),
  output: OUT,
  run: (args, ctx) =>
    guard(ctx, async () => {
      const r = await ex(ctx).create(ctx.principal.userId, args as unknown as CreateInput);
      return out({ ...r, next_step: 'Gọi dry_run_extension để thử, rồi báo người dùng vào Trinity (Chương trình con) duyệt bản này. Chưa duyệt thì deploy_extension sẽ bị từ chối.' });
    }),
};

export const updateExtensionTool: ToolDef = {
  name: 'update_extension',
  title: 'Sửa chương trình con (phiên bản nháp mới) / Update extension',
  description:
    'Tạo PHIÊN BẢN NHÁP mới của chương trình con đã có (không đụng phiên bản đang chạy; mỗi bản phải được người duyệt lại). Bỏ trống trường nào thì giữ như bản mới nhất. ' +
    'Tối đa 5 bản nháp chưa duyệt cùng lúc. / Creates a new DRAFT version; the running version is untouched.',
  permissions: ['extensions.draft'],
  scope: 'crm.write',
  annotations: WRITE,
  input: (z) => ({
    key: KEY(z),
    code: z.string().min(1).max(262_144).optional(),
    manifest: MANIFEST(z).optional(),
    name: z.string().max(120).optional(),
    description: z.string().max(1000).optional(),
    note: z.string().max(500).optional().describe('Đã đổi gì so với bản trước / What changed'),
  }),
  output: OUT,
  run: (args, ctx) => guard(ctx, async () => out({ ...(await ex(ctx).update(ctx.principal.userId, keyOf(args), args)), next_step: 'Chạy thử rồi nhờ người duyệt bản mới.' })),
};

export const dryRunExtensionTool: ToolDef = {
  name: 'dry_run_extension',
  title: 'Chạy thử chương trình con / Dry-run extension',
  description:
    'Chạy thử một phiên bản (mặc định bản mới nhất) trong sandbox giống hệt khi chạy thật nhưng KHÔNG GHI dữ liệu thật: ctx.records.create chỉ đếm (would_write); đọc dữ liệu vẫn đúng quyền của bạn. ' +
    'Trả log + kết quả + số dòng sẽ ghi. Tối đa 30 giây. job: truyền params; tool: truyền tool (nếu nhiều tool) + args. / Sandboxed run with no real writes; returns log and result.',
  permissions: ['extensions.draft'],
  scope: 'crm.write',
  annotations: WRITE,
  input: (z) => ({
    key: KEY(z),
    version: ver(z),
    params: z.unknown().optional().describe('job: giá trị ctx.params / job params'),
    tool: z.string().max(60).optional().describe('tool: tên tool khi mã khai nhiều tool (mặc định "run")'),
    args: z.unknown().optional().describe('tool: tham số gọi thử / tool arguments'),
  }),
  output: OUT,
  run: (args, ctx) => guard(ctx, async () => out({ ...(await ex(ctx).dryRun(ctx.principal.userId, keyOf(args), verOf(args), { params: args.params, tool: args.tool as string | undefined, args: args.args })) })),
};

export const deployExtensionTool: ToolDef = {
  name: 'deploy_extension',
  title: 'Chạy chương trình con (đã được duyệt) / Deploy extension',
  description:
    'Bật chạy một phiên bản ĐÃ ĐƯỢC NGƯỜI DUYỆT (mặc định bản duyệt mới nhất): job bắt đầu chạy theo lịch, tool xuất hiện trong danh sách công cụ. Phiên bản chưa duyệt ⇒ bị từ chối — bạn không thể tự duyệt. ' +
    'Chương trình con đang bị TẮT thì deploy chỉ đổi phiên bản, người dùng phải bật lại. / Activates a human-approved version only.',
  permissions: ['extensions.draft'],
  scope: 'crm.write',
  annotations: WRITE,
  input: (z) => ({ key: KEY(z), version: ver(z) }),
  output: OUT,
  run: (args, ctx) =>
    guard(ctx, async () => {
      const e = await ex(ctx).deploy(keyOf(args), verOf(args));
      return out({ extension: e, message: e.status === 'active' ? 'Đã bật chạy.' : 'Đã chọn phiên bản nhưng chương trình con đang TẮT — người dùng cần bật lại trong Trinity.' });
    }),
};

export const logsExtensionTool: ToolDef = {
  name: 'logs_extension',
  title: 'Nhật ký chạy chương trình con / Extension logs',
  description: 'Xem nhật ký các lần chạy (chạy thử, theo lịch, gọi tool) mới nhất trước: kết quả ok/error/timeout/oom/permission_denied, thời gian, log. Dùng để sửa lỗi. Chỉ đọc. / Run logs, newest first.',
  permissions: ['extensions.view'],
  input: (z) => ({ key: KEY(z), limit: z.number().int().min(1).max(50).optional(), cursor: z.number().int().min(1).max(2_147_483_647).optional() }),
  output: OUT,
  run: (args, ctx) => guard(ctx, async () => out({ ...(await ex(ctx).logs(keyOf(args), typeof args.limit === 'number' ? args.limit : 20, typeof args.cursor === 'number' ? args.cursor : undefined)) })),
};

export const disableExtensionTool: ToolDef = {
  name: 'disable_extension',
  title: 'Tắt chương trình con / Disable extension',
  description: 'TẮT chương trình con ngay (job ngừng chạy theo lịch, tool biến khỏi danh sách). Chỉ NGƯỜI mới bật lại được (trong Trinity). / Disables an extension immediately; only a human can re-enable.',
  permissions: ['extensions.draft'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({ key: KEY(z), reason: z.string().max(500).optional().describe('Lý do tắt / Reason') }),
  output: OUT,
  run: (args, ctx) => guard(ctx, async () => out({ extension: await ex(ctx).disable(keyOf(args), typeof args.reason === 'string' && args.reason ? `AI tắt: ${args.reason}` : 'AI tắt') })),
};

export const rollbackExtensionTool: ToolDef = {
  name: 'rollback_extension',
  title: 'Quay lui chương trình con / Rollback extension',
  description: 'Quay lui về một phiên bản ĐÃ ĐƯỢC DUYỆT trước đó (không cần duyệt lại vì mã không đổi). Dùng khi bản mới chạy lỗi. Đang bị tắt thì chỉ đổi phiên bản, vẫn tắt. / Roll back to a previously approved version.',
  permissions: ['extensions.draft'],
  scope: 'crm.write',
  annotations: WRITE,
  input: (z) => ({ key: KEY(z), version: z.number().int().min(1).max(2_147_483_647).describe('Phiên bản đã duyệt muốn quay về / Target approved version') }),
  output: OUT,
  run: (args, ctx) => guard(ctx, async () => out({ extension: await ex(ctx).rollback(keyOf(args), verOf(args) as number) })),
};

export const listExtensionsTool: ToolDef = {
  name: 'list_extensions',
  title: 'Danh sách chương trình con / List extensions',
  description:
    'Liệt kê chương trình con (trạng thái draft/approved/active/disabled, phiên bản đang chạy). Truyền key để xem các phiên bản và lý do bị từ chối; thêm version để đọc MÃ NGUỒN của phiên bản đó. Chỉ đọc. / Lists extensions; pass key for versions, key+version for source code.',
  permissions: ['extensions.view'],
  input: (z) => ({ status: z.enum(['draft', 'approved', 'active', 'disabled']).optional(), kind: z.enum(['job', 'tool', 'api']).optional(), key: KEY(z).optional(), version: ver(z) }),
  output: OUT,
  run: (args, ctx) =>
    guard(ctx, async () => {
      if (typeof args.key === 'string' && args.key) return out(verOf(args) ? { ...(await ex(ctx).getVersion(args.key, verOf(args) as number)) } : { ...(await ex(ctx).get(args.key)) });
      return out({ extensions: await ex(ctx).list({ status: args.status as string | undefined, kind: args.kind as string | undefined }) });
    }),
};

export const EXTENSION_TOOLS: readonly ToolDef[] = [listExtensionsTool, createExtensionTool, updateExtensionTool, dryRunExtensionTool, deployExtensionTool, logsExtensionTool, disableExtensionTool, rollbackExtensionTool];
export const EXTENSION_TOOL_NAMES: ReadonlySet<string> = new Set(EXTENSION_TOOLS.map((t) => t.name));
