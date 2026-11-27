/**
 * Hợp đồng đóng băng MCP (C03, docs/rust/PLAN.md mục 4.8 và 6.1): `server/contracts/mcp/`.
 *  - `tools.json`: kết quả `tools/list` thật của máy chủ MCP (tên, mô tả, inputSchema, outputSchema, annotations).
 *  - `instructions.txt`: `instructions` trả về ở `initialize`.
 *  - `transport/*.json`: phản hồi vận chuyển thật (thương lượng protocolVersion, header Mcp-Protocol-Version, 406/415,
 *    resources/list, prompts/list, đối số sai, gọi tool với khoá thừa).
 * Tool chỉ có ở bản Rust (RUST_ONLY_TOOLS, khai báo tường minh): Node không có; tools.json giữ nguyên mô tả của chúng.
 * Spec chỉ cho phép đúng các tên đó vắng ở Node; mọi tool khác vẫn phải khớp từng byte với Node.
 * Spec dựng máy chủ HTTP thật (McpServer + StreamableHTTPServerTransport như `McpServerService.handle`) rồi so TỪNG BYTE
 * với tệp đã commit. Sinh lại sau khi đổi tool/SDK: `UPDATE_MCP_CONTRACT=1 npx jest mcp-contract` (trong services/crm).
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { McpServerService } from '../mcp-server.service';
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOLS } from '../mcp-tools.registry';
import type { McpPrincipal } from '../mcp-auth.service';

const DIR = path.resolve(__dirname, '../../../../../../server/contracts/mcp');
const UPDATE = process.env.UPDATE_MCP_CONTRACT === '1';
const PRINCIPAL = { userId: 1, email: 'a@x.vn', clientId: 'c', scopes: ['crm.read', 'crm.write'], tokenId: BigInt(1), user: { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } } as unknown as McpPrincipal;

/**
 * Tool do bản Rust thêm (M31c, phiếu lương), Node không có và không bổ sung (Node đã gỡ khỏi đường chạy, #264).
 * Thêm tên vào đây là quyết định có chủ đích; tool Node có mà lệch tools.json vẫn đỏ.
 */
const RUST_ONLY_TOOLS = new Set([
  'export_payslip_excel',
  'export_payslip_pdf',
  'export_payslips_excel',
  'get_payslip_import_template',
  'preview_payslip_import',
  'apply_payslip_import',
]);

interface ToolEntry { name: string }

/** Ghép danh sách tool của Node với các tool chỉ-Rust lấy từ tệp đóng băng, theo đúng thứ tự trong tệp. */
function withRustOnly(nodeTools: ToolEntry[]): ToolEntry[] {
  const frozen = (JSON.parse(fs.readFileSync(path.join(DIR, 'tools.json'), 'utf8')) as { tools: ToolEntry[] }).tools;
  const nodeNames = new Set(nodeTools.map((t) => t.name));
  for (const n of RUST_ONLY_TOOLS) {
    expect(nodeNames.has(n)).toBe(false); // đã có ở Node thì bỏ khỏi RUST_ONLY_TOOLS
    expect(frozen.some((t) => t.name === n)).toBe(true);
  }
  const byName = new Map(nodeTools.map((t) => [t.name, t]));
  return frozen.map((t) => (RUST_ONLY_TOOLS.has(t.name) ? t : (byName.get(t.name) ?? t)));
}

/** Tham số tool thật nhận được sau khi SDK (zod) đã kiểm/bỏ khoá lạ. */
const seenArgs: Record<string, unknown>[] = [];

let server: http.Server;
let base: string;

beforeAll(async () => {
  const svc = Object.create(McpServerService.prototype) as McpServerService;
  (svc as unknown as { execute: unknown }).execute = async (_tool: unknown, args: Record<string, unknown>) => {
    seenArgs.push(args);
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: { notice: '', data: {} } };
  };
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      (req as unknown as { body: unknown }).body = body;
      svc.handle(req as never, Object.assign(res, { status: (c: number) => { res.statusCode = c; return res; }, json: (b: unknown) => res.end(JSON.stringify(b)) }) as never, PRINCIPAL).catch((e: Error) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

interface Reply { status: number; headers: Record<string, string>; body: unknown }

async function post(body: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Reply> {
  const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: raw ?? JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* thân không phải JSON: giữ chuỗi */
  }
  const keep = ['content-type', 'allow'];
  const hs: Record<string, string> = {};
  for (const k of keep) if (res.headers.get(k)) hs[k] = res.headers.get(k) as string;
  return { status: res.status, headers: hs, body: parsed };
}

const init = (protocolVersion: string) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'contract', version: '0' } } });
const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 2, method, ...(params === undefined ? {} : { params }) });
const OK_TOOL = 'get_setup_guide';

function check(file: string, content: string): void {
  const p = path.join(DIR, file);
  if (UPDATE) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return;
  }
  expect(fs.existsSync(p)).toBe(true);
  expect(content).toBe(fs.readFileSync(p, 'utf8'));
}
const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

describe('hợp đồng MCP đóng băng', () => {
  it('tools.json: số tool bằng MCP_TOOLS và khớp từng byte', async () => {
    const r = await post(rpc('tools/list'));
    const tools = (r.body as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools).toHaveLength(MCP_TOOLS.length);
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    // Tool Node có mà tệp không có (hoặc ngược lại ngoài RUST_ONLY_TOOLS) ⇒ danh sách tên lệch ⇒ đỏ.
    const merged = withRustOnly(tools);
    expect(merged.filter((t) => !RUST_ONLY_TOOLS.has(t.name)).map((t) => t.name)).toEqual(tools.map((t) => t.name));
    check('tools.json', json({ tool_count: merged.length, tools: merged }));
  });

  it('instructions.txt khớp từng byte với initialize', async () => {
    const r = await post(init('2025-06-18'));
    const ins = (r.body as { result: { instructions: string } }).result.instructions;
    expect(ins).toBe(MCP_SERVER_INSTRUCTIONS);
    check('instructions.txt', ins);
  });

  const cases: Record<string, () => Promise<Reply>> = {
    'initialize-2025-06-18': () => post(init('2025-06-18')),
    'initialize-2025-03-26': () => post(init('2025-03-26')),
    'initialize-2024-11-05': () => post(init('2024-11-05')),
    'initialize-version-la': () => post(init('1999-01-01')),
    'header-protocol-version-hop-le': () => post(rpc('tools/list'), { 'mcp-protocol-version': '2025-06-18' }),
    'header-protocol-version-la': () => post(rpc('tools/list'), { 'mcp-protocol-version': '1999-01-01' }),
    'accept-thieu-406': () => post(rpc('tools/list'), { accept: 'application/json' }),
    'content-type-sai-415': () => post(rpc('tools/list'), { 'content-type': 'text/plain' }),
    'json-hong': () => post(undefined, {}, '{khong-phai-json'),
    'resources-list': () => post(rpc('resources/list')),
    'prompts-list': () => post(rpc('prompts/list')),
    'phuong-thuc-la': () => post(rpc('khong/ton-tai')),
    'tool-la': () => post(rpc('tools/call', { name: 'khong_co_tool', arguments: {} })),
    'doi-so-sai-kieu': () => post(rpc('tools/call', { name: 'get_record', arguments: { id: 123 } })),
    'doi-so-thieu': () => post(rpc('tools/call', { name: 'get_record', arguments: {} })),
    'tool-khoa-thua': () => post(rpc('tools/call', { name: OK_TOOL, arguments: { khoa_la: 'x', khac: 1 } })),
  };
  for (const [name, run] of Object.entries(cases)) {
    it(`transport/${name}.json`, async () => {
      const r = await run();
      const result = (r.body as { result?: { tools?: ToolEntry[] } } | undefined)?.result;
      if (result?.tools) result.tools = withRustOnly(result.tools);
      check(`transport/${name}.json`, json(r));
    });
  }

  it('tool bỏ khoá lạ (zod strip), không từ chối', async () => {
    seenArgs.length = 0;
    const r = await post(rpc('tools/call', { name: OK_TOOL, arguments: { khoa_la: 'x' } }));
    expect((r.body as { result?: { isError?: boolean } }).result?.isError).toBeFalsy();
    expect(seenArgs).toHaveLength(1);
    expect(seenArgs[0]).not.toHaveProperty('khoa_la');
  });
});
