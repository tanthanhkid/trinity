#!/usr/bin/env node
/**
 * Quét toàn bộ tool MCP (không cần model): tools/list phải khớp server/contracts/mcp/tools.json (tên + số lượng), rồi gọi MỖI tool
 * một lần với đối số tối thiểu dựng từ inputSchema (chỉ trường bắt buộc) bằng token OAuth của admin.
 * Đỏ khi: số/tên tool lệch hợp đồng, tool trả "chưa sẵn sàng" (chưa đăng ký trên server), JSON-RPC lỗi giao thức trên đối số đúng schema,
 * hoặc lỗi nội bộ (500/"Internal"/panic). Lỗi nghiệp vụ (không thấy bản ghi, thiếu cấu hình kênh...) là bình thường và chỉ được đếm.
 *   node tests/mcp-e2e/tools-sweep.mjs <credentials>      CHỈ chạy trên DB thử: có tool ghi (dữ liệu thử được tạo).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, harness, loadConfig } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(process.argv[2] || process.env.MCP_CREDENTIALS || (console.error('Cần đường dẫn file credentials'), process.exit(2)));
const { step, login, oauthToken, connect, summary } = harness(cfg.BASE);
const contract = JSON.parse(readFileSync(resolve(here, '../../server/contracts/mcp/tools.json'), 'utf8'));
const contractTools = Array.isArray(contract) ? contract : contract.tools;

/** Giá trị mẫu theo schema; chỉ dùng cho trường bắt buộc. */
function sample(s, key = '') {
  if (!s || typeof s !== 'object') return 'x';
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  const u = s.anyOf ?? s.oneOf;
  if (u?.length) return sample(u[0], key);
  if (Array.isArray(s.type)) return sample({ ...s, type: s.type.find((t) => t !== 'null') ?? 'string' }, key);
  switch (s.type) {
    case 'integer': return Math.max(s.minimum ?? 1, 1);
    case 'number': return Math.max(s.minimum ?? 1, 1);
    case 'boolean': return true;
    case 'array': { const n = Math.max(s.minItems ?? 0, 0); return Array.from({ length: n }, () => sample(s.items, key)); }
    case 'object': return build(s);
    default: {
      if (s.format === 'date-time') return '2030-01-01T09:00:00.000Z';
      if (s.format === 'date') return '2030-01-01';
      if (s.format === 'uri' || s.format === 'url') return 'https://example.com/a.png';
      if (s.format === 'email') return 'e2e@example.com';
      const min = s.minLength ?? 1;
      return 'e2e'.padEnd(min, 'x').slice(0, s.maxLength ?? 200);
    }
  }
}
function build(schema) {
  const out = {};
  for (const k of schema.required ?? []) out[k] = sample(schema.properties?.[k], k);
  return out;
}

// Tool trong hợp đồng mà Rust CHƯA đăng ký (đã biết, ghi ở docs/rust/X04.md): báo thành "đã biết" thay vì đỏ để các lỗi MỚI vẫn lộ.
// Đặt E2E_STRICT=1 để coi chúng là đỏ.
const KNOWN_UNPORTED = new Set(process.env.E2E_STRICT === '1' ? [] : ['link_records']);
const BAD = /chưa sẵn sàng|not available on this server yet|internal server error|internal error|panicked|lỗi nội bộ/i;
let admin; let tools = [];
const jwt = await login(cfg.MCP_ADMIN_EMAIL, cfg.MCP_ADMIN_PASSWORD);

await step('OAuth admin + tools/list khớp hợp đồng đóng băng (số lượng + tên)', async () => {
  admin = await connect((await oauthToken(jwt, 'trinity-e2e-sweep')).accessToken);
  tools = (await admin.listTools()).tools;
  const got = new Set(tools.map((t) => t.name)); const want = new Set(contractTools.map((t) => t.name));
  assert(got.size === tools.length, 'tên tool trùng');
  const thieu = [...want].filter((n) => !got.has(n)); const thua = [...got].filter((n) => !want.has(n));
  assert(!thieu.length && !thua.length, `lệch hợp đồng: thiếu [${thieu}] thừa [${thua}]`);
  return `${tools.length} tool`;
});
if (!admin) { summary(); process.exit(1); }

const stat = { read: { ok: 0, nghiepvu: 0 }, write: { ok: 0, nghiepvu: 0 } };
const order = [...tools.filter((t) => t.annotations?.readOnlyHint), ...tools.filter((t) => !t.annotations?.readOnlyHint)];
const bad = []; const known = [];
for (const t of order) {
  const kind = t.annotations?.readOnlyHint ? 'read' : 'write';
  let args = {};
  try { args = build(t.inputSchema ?? {}); } catch { /* đối số rỗng */ }
  if ('confirmed_by_user' in (t.inputSchema?.properties ?? {})) args.confirmed_by_user = true;
  try {
    // Trần 60 lời gọi/phút/người (đúng thiết kế): gặp thì chờ đủ số giây máy chủ báo rồi gọi lại, không tính là lỗi.
    let r;
    for (let i = 0; i < 4; i += 1) {
      r = await admin.callTool({ name: t.name, arguments: args });
      const m = /Quá giới hạn \d+ lời gọi\/phút\. Thử lại sau (\d+) giây/.exec(r.content?.[0]?.text ?? '');
      if (!m) break;
      await new Promise((ok) => setTimeout(ok, (Number(m[1]) + 1) * 1000));
    }
    const text = r.content?.[0]?.text ?? '';
    if (KNOWN_UNPORTED.has(t.name) && BAD.test(text)) known.push(t.name);
    else if (BAD.test(text)) bad.push(`${t.name}: ${text.slice(0, 160)}`);
    else if (/Quá giới hạn/.test(text)) bad.push(`${t.name}: vẫn bị giới hạn tốc độ sau 4 lần chờ`);
    else if (r.isError) stat[kind].nghiepvu += 1; else stat[kind].ok += 1;
  } catch (e) {
    // Lỗi giao thức trên đối số dựng đúng schema = lỗi của server hoặc của bộ dựng đối số; liệt kê để phân biệt.
    bad.push(`${t.name}: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}
await step(`gọi từng tool (${order.length}): không "chưa sẵn sàng", không lỗi nội bộ/giao thức`, async () => {
  assert(!bad.length, `${bad.length} tool lỗi:\n  ${bad.join('\n  ')}`);
  return `đọc ${stat.read.ok} ok + ${stat.read.nghiepvu} lỗi nghiệp vụ; ghi ${stat.write.ok} ok + ${stat.write.nghiepvu} lỗi nghiệp vụ; chưa port (đã biết): ${known.join(',') || 'không'}`;
});
process.exit(summary() ? 1 : 0);
