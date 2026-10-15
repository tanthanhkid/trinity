#!/usr/bin/env node
/**
 * Hậu kiểm MCP — CHỈ ĐỌC, không ghi gì lên hệ thống.
 *
 *   MCP_URL=https://crm.example.com/api/v1/mcp MCP_TOKEN=trn_at_... node scripts/ops/mcp-smoke.mjs
 *
 * Env:
 *   MCP_URL     (bắt buộc) URL MCP đầy đủ, vd https://crm.example.com/api/v1/mcp
 *   MCP_TOKEN   (khuyến nghị) access token OAuth của 1 người dùng có integrations.ai_connect. Thiếu ⇒ chỉ chạy bước 1-2 (khám phá/401).
 *   MCP_QUERY   từ khoá cho tool search (mặc định "an", ≥ 2 ký tự — tên khách, KHÔNG phải SĐT)
 *   MCP_ORIGIN  (tuỳ chọn) gửi kèm header Origin để kiểm danh sách cho phép
 *   MCP_SKIP_WELLKNOWN=1  bỏ các bước /.well-known (chỉ dùng khi gọi THẲNG monolith, không qua Next — khi đi qua Next thì KHÔNG đặt)
 *
 * Token KHÔNG bao giờ được in ra. Chỉ in số lượng + id bản ghi (không in tên/SĐT/nội dung).
 * Mã thoát: 0 = mọi bước đạt; 1 = có bước hỏng; 2 = thiếu cấu hình.
 */
const MCP_URL = (process.env.MCP_URL ?? '').trim();
const TOKEN = (process.env.MCP_TOKEN ?? '').trim();
const QUERY = (process.env.MCP_QUERY ?? 'an').trim();
const ORIGIN = (process.env.MCP_ORIGIN ?? '').trim();
const SKIP_WELLKNOWN = process.env.MCP_SKIP_WELLKNOWN === '1';

if (!MCP_URL) {
  console.error('Thiếu MCP_URL (vd https://crm.example.com/api/v1/mcp)');
  process.exit(2);
}

const url = new URL(MCP_URL);
let failed = 0;
const pass = (m) => console.log(`PASS  ${m}`);
const fail = (m) => {
  failed += 1;
  console.log(`FAIL  ${m}`);
};
const check = (ok, m) => (ok ? pass(m) : fail(m));

const baseHeaders = (token) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(ORIGIN ? { Origin: ORIGIN } : {}),
});

let seq = 0;
async function rpc(token, method, params, notification = false) {
  const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: (seq += 1), method, params };
  const res = await fetch(MCP_URL, { method: 'POST', headers: baseHeaders(token), body: JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    // Streamable HTTP có thể trả JSON thẳng hoặc SSE (`data: {...}`).
    const data = text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) : text;
    json = data ? JSON.parse(data) : null;
  } catch {
    json = null;
  }
  return { res, json };
}

async function getJson(u) {
  const res = await fetch(u, { redirect: 'manual', headers: { Accept: 'application/json' } });
  const text = await res.text();
  try {
    return { res, json: JSON.parse(text) };
  } catch {
    return { res, json: null };
  }
}

async function main() {
  console.log(`MCP smoke → ${MCP_URL}${TOKEN ? '' : '  (không có MCP_TOKEN: bỏ qua bước có xác thực)'}\n`);

  // 1. Chưa xác thực ⇒ 401 + resource_metadata (cờ bật + INTEGRATIONS_PUBLIC_BASE_URL đúng).
  const anon = await rpc('', 'tools/list', {});
  check(anon.res.status === 401, `chưa có token ⇒ 401 (nhận ${anon.res.status}${anon.res.status === 404 ? ' — cờ INTEGRATIONS_MCP_ENABLED hoặc INTEGRATIONS_PUBLIC_BASE_URL chưa bật' : ''})`);
  const challenge = anon.res.headers.get('www-authenticate') ?? '';
  const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  check(Boolean(prmUrl), 'WWW-Authenticate có resource_metadata');

  // 2. Khám phá: PRM (từ header + 2 dạng well-known qua Next rewrite) và AS metadata.
  let issuer = null;
  if (prmUrl) {
    const prm = await getJson(prmUrl);
    check(prm.res.status === 200 && prm.json?.resource === MCP_URL, `PRM ở header: resource khớp MCP_URL (${prm.res.status})`);
    issuer = prm.json?.authorization_servers?.[0] ?? null;
  }
  const origin = `${url.protocol}//${url.host}`;
  if (!SKIP_WELLKNOWN) {
    const wk = await getJson(`${origin}/.well-known/oauth-protected-resource${url.pathname}`);
    check(wk.res.status === 200 && wk.json?.resource === MCP_URL, `well-known PRM (RFC 9728, qua rewrite của Next) khớp (${wk.res.status})`);
    const wkRoot = await getJson(`${origin}/.well-known/oauth-protected-resource`);
    check(wkRoot.res.status === 200 && wkRoot.json?.resource === MCP_URL, `well-known PRM gốc khớp (${wkRoot.res.status})`);
  }
  if (issuer) {
    const issUrl = new URL(issuer);
    const as = SKIP_WELLKNOWN ? { res: { status: 200 }, json: null } : await getJson(`${issUrl.origin}/.well-known/oauth-authorization-server${issUrl.pathname}`);
    if (!SKIP_WELLKNOWN) check(as.res.status === 200 && as.json?.issuer === issuer, `well-known AS (RFC 8414, path insertion) có issuer khớp (${as.res.status})`);
    const direct = await getJson(`${issuer}/.well-known/oauth-authorization-server`);
    check(direct.res.status === 200 && direct.json?.issuer === issuer, `AS metadata trực tiếp qua /api/v1 khớp (${direct.res.status})`);
    const m = as.json ?? direct.json ?? {};
    check(Array.isArray(m.code_challenge_methods_supported) && m.code_challenge_methods_supported.length === 1 && m.code_challenge_methods_supported[0] === 'S256', 'chỉ hỗ trợ PKCE S256');
    check(m.client_id_metadata_document_supported === true && Boolean(m.registration_endpoint), 'có CIMD + DCR');
    check(m.authorization_response_iss_parameter_supported === true, 'có iss (RFC 9207)');
    check(typeof m.authorization_endpoint === 'string' && m.authorization_endpoint.startsWith(`${issUrl.protocol}//${issUrl.host}/oauth/authorize`), `authorization_endpoint là trang đồng ý của hệ thống (${m.authorization_endpoint})`);
  }
  const get = await fetch(MCP_URL, { method: 'GET', redirect: 'manual' });
  check(get.status === 405 || get.status === 401, `GET ${url.pathname} không phục vụ luồng SSE (nhận ${get.status})`);
  const evil = await fetch(MCP_URL, { method: 'POST', headers: { ...baseHeaders(TOKEN), Origin: 'https://evil.example.com' }, body: '{}', redirect: 'manual' });
  check(evil.status === 403, `Origin lạ bị chặn 403 (nhận ${evil.status})`);

  if (!TOKEN) {
    console.log(failed ? `\n${failed} bước HỎNG` : '\nBỏ qua bước có xác thực (thiếu MCP_TOKEN).');
    return;
  }

  // 3. Có token: initialize → tools/list → search.
  const init = await rpc(TOKEN, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '1.0.0' } });
  check(init.res.status === 200 && Boolean(init.json?.result?.serverInfo?.name), `initialize ⇒ ${init.json?.result?.serverInfo?.name ?? init.res.status} (protocol ${init.json?.result?.protocolVersion ?? '?'})`);
  await rpc(TOKEN, 'notifications/initialized', {}, true);

  const list = await rpc(TOKEN, 'tools/list', {});
  const tools = list.json?.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  check(names.includes('search') && names.includes('fetch'), `tools/list có search + fetch (${names.length} tool: ${names.join(', ')})`);
  // tool ghi chỉ TẠO ĐỀ XUẤT (readOnlyHint=false) — ngoài allowlist này mọi tool phải chỉ đọc; tuyệt đối không có tool xoá/xuất/duyệt.
  const PROPOSE = new Set(['add_contact_note', 'add_field', 'archive_field', 'archive_record', 'assign_contact', 'complete_setup', 'create_contact', 'create_object', 'create_objects', 'create_record', 'create_task', 'create_view', 'import_records', 'install_object_template', 'link_records', 'propose_workspace', 'restore_structure_version', 'save_briefing', 'set_lead_intent', 'set_menu', 'update_contact_stage', 'update_field', 'update_object', 'update_record', 'update_view']);
  check(tools.length > 0 && tools.every((t) => t.annotations?.readOnlyHint === !PROPOSE.has(t.name)), 'tool đọc đều readOnlyHint=true; chỉ các tool đề xuất là readOnlyHint=false');
  check(!names.some((n) => /delete|remove|export|download|approve|role|password/i.test(n)), 'không có tool xoá/xuất/duyệt/quản trị');

  const sr = await rpc(TOKEN, 'tools/call', { name: 'search', arguments: { query: QUERY } });
  const result = sr.json?.result;
  if (result?.isError) {
    console.log(`INFO  search trả lỗi tool (có thể do người dùng thiếu quyền xem): ${String(result.content?.[0]?.text ?? '').slice(0, 120)}`);
    check(true, 'search chạy được (lỗi tool có kiểm soát)');
  } else {
    const results = result?.structuredContent?.results;
    check(Array.isArray(results), `search ⇒ ${Array.isArray(results) ? results.length : '?'} kết quả (ids: ${(results ?? []).slice(0, 5).map((r) => r.id).join(', ') || '—'})`);
    const bad = (results ?? []).find((r) => !r.id || !r.title || !r.url);
    check(!bad, 'mỗi kết quả có id + title + url');
    const first = results?.[0]?.id;
    if (first) {
      const fr = await rpc(TOKEN, 'tools/call', { name: 'fetch', arguments: { id: first } });
      const doc = fr.json?.result?.structuredContent;
      check(Boolean(doc?.id === first && typeof doc?.text === 'string'), `fetch ${first} ⇒ ${doc?.text ? `${doc.text.length} ký tự` : 'lỗi'}`);
      check(!/(?<![\d.,])(?:\+?84|0)(?:[\s.\-]?\d){8,9}(?!\d)/.test(doc?.text ?? ''), 'nội dung fetch KHÔNG chứa SĐT đầy đủ');
    }
  }
  const bogus = await rpc('trn_at_sai-token', 'tools/list', {});
  check(bogus.res.status === 401, `token sai ⇒ 401 (nhận ${bogus.res.status})`);

  console.log(failed ? `\n${failed} bước HỎNG` : '\nTất cả bước đạt.');
}

main().catch((err) => {
  console.error(`Lỗi không mong đợi: ${err?.message ?? err}`);
  process.exit(1);
}).finally(() => {
  process.exitCode = process.exitCode || (failed ? 1 : 0);
});
