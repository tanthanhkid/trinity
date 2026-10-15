#!/usr/bin/env node
/**
 * Thử MCP bằng CLAUDE CODE THẬT (`claude -p` headless + --mcp-config trỏ tới /api/v1/mcp với token OAuth của user thử).
 * Token chỉ nằm trong file cấu hình tạm (mode 600, xoá ngay sau khi chạy, KHÔNG commit) và bị lọc khỏi log.
 *   node tests/mcp-e2e/claude-code-roles.mjs [credentials] [thư-mục-log]
 * KHÔNG chạy trên hệ thống có dữ liệu thật: script XOÁ các bảng tuỳ biến `lich_kham`/`thu_cung` và tạo bảng/bản ghi thử (chỉ dùng trên bản demo hoặc instance tự dựng).
 * Mặc định AI ghi thẳng theo quyền người dùng; nếu bật chế độ duyệt thì bước "Duyệt" làm bằng API web (JWT) giữa các lượt.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, loadConfig } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cfg = loadConfig(process.argv[2] || process.env.MCP_CREDENTIALS || (console.error('Cần đường dẫn file credentials (đối số 1 hoặc biến MCP_CREDENTIALS)'), process.exit(2)));
const logDir = resolve(process.argv[3] || process.env.MCP_LOG_DIR || join(tmpdir(), 'mcp-e2e-logs'));
mkdirSync(logDir, { recursive: true });
console.warn(`[mcp-e2e] Script này xoá/tạo dữ liệu thử trên ${cfg.BASE} — chỉ dùng với demo hoặc instance tự dựng.`);
const { http, actor } = harness(cfg.BASE);
const work = mkdtempSync(join(process.env.CC_TMP || tmpdir(), 'cc-mcp-')); // cwd trống: không nạp cấu hình/hook của dự án khác
const files = [];

function runClaude(a, label, prompt) {
  const conf = join(work, `mcp-${a.label}.json`);
  writeFileSync(conf, JSON.stringify({ mcpServers: { trinity: { type: 'http', url: `${cfg.BASE}/api/v1/mcp`, headers: { Authorization: `Bearer ${a.mcp.rawToken}` } } } }));
  chmodSync(conf, 0o600); files.push(conf);
  const t0 = Date.now();
  const r = spawnSync('claude', ['-p', '--mcp-config', conf, '--strict-mcp-config', '--allowedTools', 'mcp__trinity__*', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', prompt], { cwd: work, encoding: 'utf8', timeout: 480_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
  const raw = (r.stdout ?? '').split('\n').filter(Boolean);
  const events = raw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const calls = []; let answer = '';
  for (const e of events) {
    for (const c of e.message?.content ?? []) {
      if (c.type === 'tool_use') calls.push({ id: c.id, name: String(c.name).replace('mcp__trinity__', ''), input: c.input });
      if (c.type === 'tool_result') { const x = calls.find((k) => k.id === c.tool_use_id); if (x) x.result = (Array.isArray(c.content) ? c.content.map((y) => y.text ?? '').join('') : String(c.content)).slice(0, 400); }
    }
    if (e.type === 'result') answer = e.result ?? '';
  }
  const redact = (s) => s.split(a.mcp.rawToken).join('<token>');
  const report = [`## ${label}`, `Người dùng: ${a.label} | model: sonnet | ${Math.round((Date.now() - t0) / 1000)}s | exit=${r.status}${r.error ? ` | lỗi: ${r.error.message}` : ''}`, `Yêu cầu: ${prompt}`, '', 'Tool Claude Code đã gọi:', ...calls.map((c) => `  - ${c.name}(${JSON.stringify(c.input).slice(0, 300)})${c.result ? `\n      → ${c.result.replace(/\s+/g, ' ').slice(0, 220)}` : ''}`), '', 'Câu trả lời cuối của Claude Code:', answer || `(trống) stderr: ${(r.stderr ?? '').slice(0, 500)}`, ''].join('\n');
  const text = redact(report);
  console.log(text);
  writeFileSync(join(logDir, `claude-code-${label.split(' ')[0]}.log`), text);
  return { calls, answer };
}

const T0 = Date.now();
const list = async (a, q = '') => (await http('GET', `/api/v1/integrations/ai-actions?limit=50${q}`, { token: a.jwt })).json?.data ?? [];
/** Mặc định AI ghi thẳng (executed). Nếu workspace bật chế độ duyệt thì vẫn duyệt nốt các nháp chờ. Trả các thao tác AI đã thực hiện từ đầu lượt chạy. */
async function settle(a) {
  for (const d of (await list(a, '&status=pending')).reverse()) {
    const r = await http('POST', `/api/v1/integrations/ai-actions/${d.id}/approve`, { token: a.jwt });
    console.log(`>> ${a.label} DUYỆT #${d.id} (${d.tool}): ${d.summary.slice(0, 100)} ⇒ ${r.status} ${r.json?.status ?? ''}`);
  }
  const done = (await list(a)).filter((d) => ['executed', 'approved'].includes(d.status) && Date.parse(d.created_at) >= T0);
  for (const d of done) console.log(`>> ${a.label} AI ĐÃ THỰC HIỆN #${d.id} (${d.tool}): ${d.summary.slice(0, 100)} ⇒ ${d.status} ${JSON.stringify(d.result ?? {})}`);
  return done;
}

const tableKeys = async (a) => ((await a.mcp.callTool({ name: 'describe_schema', arguments: {} })).structuredContent?.data?.tables ?? []).map((t) => t.key);
let admin; let sale; let before = [];
try {
  console.log(`# Claude Code thật → ${cfg.BASE} (${new Date().toISOString()}); claude ${spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim()}`);
  admin = await actor('cc-admin', cfg.MCP_ADMIN_EMAIL, cfg.MCP_ADMIN_PASSWORD);
  sale = await actor('cc-sale', cfg.MCP_SALE_EMAIL, cfg.MCP_SALE_PASSWORD);
  for (const k of ['lich_kham', 'thu_cung']) await http('DELETE', `/api/v1/custom-objects/${k}`, { token: admin.jwt }); // làm sạch lần chạy trước (xoá mềm)
  before = await tableKeys(admin);
  runClaude(admin, 'a-admin-dung-bang', 'Dựng cho tôi CRM phòng khám thú y: bảng Thú cưng và Lịch khám');
  await settle(admin);
  runClaude(admin, 'b-admin-liet-ke', 'Liệt kê các bảng tôi có');
  runClaude(sale, 'c-sale-them-khach', 'Thêm khách hàng Nguyễn Văn Test, rồi cho tôi xem danh sách khách của tôi');
  await settle(sale);
  // Lượt (c) Claude hỏi lại SĐT + nguồn (đúng — tool bắt buộc). Lượt c3: người dùng cung cấp đủ → Claude ghi thẳng → xem lại.
  const phone = `09${Date.now().toString().slice(-8)}`;
  runClaude(sale, 'c3-sale-them-khach-du-thong-tin', `Thêm khách hàng Nguyễn Văn Test, SĐT ${phone}, nguồn KH GT, rồi cho tôi xem danh sách khách của tôi`);
  runClaude(sale, 'c4-sale-xem-lai', 'Cho tôi xem danh sách khách hàng của tôi (tìm theo tên "Nguyễn Văn Test")');
  runClaude(sale, 'd-sale-sua-cau-truc', "Tạo thêm trường 'Hạng thành viên' cho bảng khách hàng");
  console.log(`\n# Sale: ${(await list(sale, '&status=pending')).length} nháp còn chờ sau lượt d (kỳ vọng 0)`);
  const saleDone = await settle(sale);
  // Dọn: xoá mềm khách thử; ẩn các bảng do Claude Code dựng (is_active=false) — GIỮ bảng demo.
  for (const d of saleDone) if (d?.result?.contact_id) console.log(`cleanup contact#${d.result.contact_id}: ${(await http('DELETE', `/api/v1/contacts/${d.result.contact_id}`, { token: admin.jwt })).status}`);
  for (const k of (await tableKeys(admin)).filter((x) => !before.includes(x))) console.log(`ẩn bảng ${k} (do Claude Code dựng): ${(await http('PATCH', `/api/v1/custom-objects/${k}`, { token: admin.jwt, body: { is_active: false } })).status}`);
} finally {
  for (const f of files) rmSync(f, { force: true });
  rmSync(work, { recursive: true, force: true });
  console.log('Đã xoá file mcp config tạm.');
  for (const a of [admin, sale]) await a?.mcp.close().catch(() => undefined);
}
