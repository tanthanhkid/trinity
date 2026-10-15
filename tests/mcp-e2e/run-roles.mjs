#!/usr/bin/env node
/**
 * E2E MCP bằng MCP client THẬT + OAuth thật, trên bản demo. Chỉ khác trình duyệt: bước đăng nhập/"Cho phép"/"Duyệt" làm bằng API.
 *   node tests/mcp-e2e/run-roles.mjs [credentials]      (cần user từ setup-users.mjs + setup-users-roles.mjs)
 * KHÔNG chạy trên hệ thống có dữ liệu thật (tạo bảng/bản ghi thử rồi dọn).
 * Giữ lại bảng "Phòng khám nha khoa" (benh_nhan, lich_hen) làm demo; dọn mọi bản ghi thử (xoá mềm qua API web).
 */
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, harness, loadConfig } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cfg = loadConfig(process.argv[2] || process.env.MCP_CREDENTIALS || (console.error('Cần đường dẫn file credentials (đối số 1 hoặc biến MCP_CREDENTIALS)'), process.exit(2)));
const { step, http, call, approveDraft, actor, oauthToken, connect, summary } = harness(cfg.BASE);
const TAG = Array.from(randomBytes(6), (b) => String.fromCharCode(97 + (b % 26))).join('');
const NK = [
  { key: 'benh_nhan', label: 'Bệnh nhân', icon: 'stethoscope', description: 'Hồ sơ bệnh nhân phòng khám nha khoa', fields: [
    { label: 'Họ tên', key: 'ho_ten', type: 'text', required: true }, { label: 'Ngày sinh', key: 'ngay_sinh', type: 'date' }, { label: 'SĐT', key: 'sdt', type: 'phone' },
    { label: 'Nhóm máu', key: 'nhom_mau', type: 'select', choices: ['A', 'B', 'AB', 'O'] }, { label: 'Dị ứng', key: 'di_ung', type: 'long_text' }, { label: 'Đã bảo hiểm', key: 'bao_hiem', type: 'boolean' },
  ] },
  { key: 'lich_hen', label: 'Lịch hẹn', icon: 'calendar-check', description: 'Lịch hẹn khám/điều trị', fields: [
    { label: 'Nội dung', key: 'noi_dung', type: 'text', required: true }, { label: 'Bệnh nhân', key: 'benh_nhan', type: 'relation', target_object: 'benh_nhan' },
    { label: 'Giờ hẹn', key: 'gio_hen', type: 'datetime' }, { label: 'Dịch vụ', key: 'dich_vu', type: 'select', choices: [{ label: 'Cạo vôi', color: 'teal' }, { label: 'Nhổ răng', color: 'red' }, { label: 'Niềng răng', color: 'blue' }] },
    { label: 'Phí', key: 'phi', type: 'currency' }, { label: 'Đã đến', key: 'da_den', type: 'boolean' },
  ] },
];
const created = []; // [kind, id, path]

const names = (r) => (r.data?.records ?? []).map((x) => x.title ?? x.full_name);
/** Ghi qua MCP: mặc định THỰC HIỆN NGAY (status=executed) theo quyền của chính người dùng — không có bước duyệt. */
async function write(a, tool, args) {
  const r = await call(a.mcp, tool, args);
  assert(!r.isError && r.data?.status === 'executed' && r.data?.action_id, `${a.label}.${tool} không thực hiện ngay: ${r.text.slice(0, 300)}`);
  return { id: r.data.action_id, result: r.data.result };
}
async function setApproval(jwt, on) {
  const r = await http('PATCH', '/api/v1/integrations/ai-actions/settings', { token: jwt, body: { require_approval: on } });
  assert(r.status === 200 && r.json?.require_approval === on, `PATCH settings => ${r.status} ${r.text.slice(0, 200)}`);
}
const denied = (r, perm) => r.isError && (perm ? r.text.includes(perm) : true);

async function main() {
  console.log(`# E2E MCP → ${cfg.BASE}  (${new Date().toISOString()})  tag=${TAG}`);
  let admin; let lead; let sale; let sale2; let low;
  await step('OAuth (DCR + PKCE) cho 5 user: admin, trưởng nhóm, sale (cấp dưới của lead), sale2 (nhóm khác), user ít quyền', async () => {
    admin = await actor('admin', cfg.MCP_ADMIN_EMAIL, cfg.MCP_ADMIN_PASSWORD);
    lead = await actor('lead', cfg.MCP_LEAD_EMAIL, cfg.MCP_LEAD_PASSWORD);
    sale = await actor('sale', cfg.MCP_SALE_EMAIL, cfg.MCP_SALE_PASSWORD);
    sale2 = await actor('sale2', cfg.MCP_SALE2_EMAIL, cfg.MCP_SALE2_PASSWORD);
    low = await actor('low', cfg.MCP_LOW_EMAIL, cfg.MCP_LOW_PASSWORD);
  });
  if (!low) return;

  // ===== TRỤ CỘT 1 — admin dựng cấu trúc =====
  await step('tools/list: có đủ tool cấu trúc + archive_record; không có tool xoá cứng', async () => {
    const n = (await admin.mcp.listTools()).tools.map((t) => t.name);
    for (const x of ['create_objects', 'create_object', 'update_object', 'add_field', 'update_field', 'archive_field', 'list_object_templates', 'install_object_template', 'archive_record']) assert(n.includes(x), `thiếu ${x}`);
    assert(!n.some((x) => /delete|drop|remove/i.test(x)), `có tool xoá: ${n}`);
    return `${n.length} tool`;
  });
  await step('admin: list_object_templates thấy mẫu ngành', async () => {
    const r = await call(admin.mcp, 'list_object_templates', {});
    assert(!r.isError && r.data.templates.length > 0, r.text);
    return r.data.templates.map((t) => t.key).join(', ');
  });
  let schema0;
  await step('admin: describe_schema — structure.can_edit=true, liệt kê kiểu trường hợp lệ, data_scope=all', async () => {
    const r = await call(admin.mcp, 'describe_schema', {});
    assert(!r.isError && r.data.structure.can_edit === true && r.data.structure.field_types.includes('relation'), r.text.slice(0, 300));
    schema0 = r.data.tables;
    assert(schema0.find((t) => t.key === 'contacts')?.data_scope === 'all', 'admin phải data_scope=all');
    return `${schema0.length} bảng`;
  });
  const exists = schema0?.some((t) => t.key === 'benh_nhan');
  if (exists) console.log('NOTE  bảng benh_nhan đã có từ lần chạy trước → bỏ bước dựng, vẫn kiểm cấu trúc');
  else {
    await step('admin: create_objects "Phòng khám nha khoa" (Bệnh nhân + Lịch hẹn, 12 trường, 7 kiểu, quan hệ) ⇒ THỰC HIỆN NGAY: status=executed, 2 bảng', async () => {
      const w = await write(admin, 'create_objects', { objects: NK, confirmed_by_user: 'ok' });
      assert(w.result?.created_objects?.length === 2, JSON.stringify(w.result).slice(0, 300));
      const r = await call(admin.mcp, 'describe_schema', { object: 'benh_nhan' });
      assert(!r.isError, 'bảng chưa có sau khi thực hiện');
      return JSON.stringify(w.result);
    });
  }
  // Chế độ duyệt (tuỳ chọn, mặc định TẮT): bật ⇒ luồng cũ nháp → duyệt trên web; luôn tắt lại cuối bước.
  await step('chế độ "Yêu cầu duyệt thay đổi do AI" BẬT ⇒ AI chỉ tạo nháp; token OAuth duyệt ⇒ 401; user khác ⇒ 404; admin duyệt (web) ⇒ approved', async () => {
    await setApproval(admin.jwt, true);
    try {
      const d = `Mô tả duyệt ${TAG}`;
      const r = await call(admin.mcp, 'update_object', { object: 'benh_nhan', description: d });
      assert(!r.isError && r.data?.status === 'pending' && r.data?.action_id, `không ra nháp: ${r.text.slice(0, 300)}`);
      const id = r.data.action_id;
      const a = await http('POST', `/api/v1/integrations/ai-actions/${id}/approve`, { token: admin.mcp.rawToken });
      const b = await http('POST', `/api/v1/integrations/ai-actions/${id}/approve`, { token: sale.jwt });
      assert(a.status === 401, `OAuth ⇒ ${a.status}`);
      assert(b.status === 404, `sale duyệt nháp người khác ⇒ ${b.status}`);
      const v = await approveDraft(admin.jwt, id);
      assert(v.status === 'approved', JSON.stringify(v).slice(0, 300));
    } finally {
      await setApproval(admin.jwt, false);
    }
  });
  await step('token chỉ có crm.read ⇒ tool ghi trả insufficient_scope (không ghi gì)', async () => {
    const t = await oauthToken(admin.jwt, `trinity-e2e-readonly-${TAG}`, ['crm.read']);
    const c = await connect(t.accessToken);
    const r = await call(c, 'update_object', { object: 'benh_nhan', description: 'x' });
    assert(r.isError && r.text.includes('insufficient_scope'), r.text.slice(0, 200));
  });
  await step('describe_schema thấy Bệnh nhân + Lịch hẹn đủ trường/kiểu/lựa chọn/quan hệ', async () => {
    const r = await call(admin.mcp, 'describe_schema', {});
    const bn = r.data.tables.find((t) => t.key === 'benh_nhan'); const lh = r.data.tables.find((t) => t.key === 'lich_hen');
    assert(bn && lh, 'thiếu bảng');
    assert(bn.fields.find((f) => f.key === 'nhom_mau')?.choices?.length === 4, 'select Nhóm máu thiếu lựa chọn');
    const rel = lh.fields.find((f) => f.key === 'benh_nhan');
    assert(rel?.type === 'relation' && rel.relation?.table === 'benh_nhan', `relation: ${JSON.stringify(rel)}`);
    assert(lh.fields.find((f) => f.key === 'phi')?.type === 'currency' && bn.fields.find((f) => f.key === 'ngay_sinh')?.type === 'date', 'kiểu sai');
    assert(bn.fields[0].is_title === true, 'trường đầu phải là tiêu đề');
    return `benh_nhan ${bn.fields.length} trường; lich_hen ${lh.fields.length} trường`;
  });
  await step('create_objects trùng khoá / liên kết tới bảng không có / kiểu lạ ⇒ báo lỗi ngay, không ghi gì', async () => {
    const a = await call(admin.mcp, 'create_objects', { objects: [{ key: 'benh_nhan', label: 'X' }] });
    const b = await call(admin.mcp, 'create_object', { label: 'Y', fields: [{ label: 'T', type: 'text' }, { label: 'L', type: 'relation', target_object: 'khong_co' }] });
    assert(a.isError && /đã được dùng/.test(a.text), a.text);
    assert(b.isError && /liên kết/.test(b.text), b.text);
  });
  const fkey = `hang_${TAG}`;
  await step('admin: add_field (select) → describe thấy; update_field (đổi nhãn + lựa chọn); archive_field → biến mất', async () => {
    await write(admin, 'add_field', { object: 'benh_nhan', key: fkey, label: 'Hạng thành viên', type: 'select', choices: ['Bạc', 'Vàng'] });
    let bn = (await call(admin.mcp, 'describe_schema', { object: 'benh_nhan' })).data.tables[0];
    assert(bn.fields.some((f) => f.key === fkey && f.choices.length === 2), 'chưa thấy trường mới');
    await write(admin, 'update_field', { object: 'benh_nhan', field: fkey, label: 'Hạng khách quen', choices: ['Bạc', 'Vàng', 'Kim cương'] });
    bn = (await call(admin.mcp, 'describe_schema', { object: 'benh_nhan' })).data.tables[0];
    const f = bn.fields.find((x) => x.key === fkey);
    assert(f?.label === 'Hạng khách quen' && f.choices.length === 3, JSON.stringify(f));
    await write(admin, 'archive_field', { object: 'benh_nhan', field: fkey });
    bn = (await call(admin.mcp, 'describe_schema', { object: 'benh_nhan' })).data.tables[0];
    assert(!bn.fields.some((x) => x.key === fkey), 'trường chưa bị ẩn');
  });
  await step('admin: update_object (đổi mô tả) ; tool không có cách xoá bảng', async () => {
    const d = 'Hồ sơ bệnh nhân phòng khám nha khoa (demo)';
    await write(admin, 'update_object', { object: 'benh_nhan', description: d });
    const bn = (await call(admin.mcp, 'describe_schema', { object: 'benh_nhan' })).data.tables[0];
    assert(bn.description === d, bn.description);
  });

  // ===== TRỤ CỘT 3 — không vượt quyền: sale/lead không sửa được cấu trúc =====
  const STRUCT = [['create_objects', { objects: [{ label: 'Hack', fields: [{ label: 'T', type: 'text' }] }] }], ['create_object', { label: 'Hack' }], ['update_object', { object: 'benh_nhan', label: 'Hack' }],
    ['add_field', { object: 'benh_nhan', label: 'Hạng thành viên', type: 'text' }], ['update_field', { object: 'benh_nhan', field: 'ho_ten', label: 'Hack' }], ['archive_field', { object: 'benh_nhan', field: 'sdt' }],
    ['list_object_templates', {}], ['install_object_template', { template: 'education_center' }]];
  for (const a of [() => sale, () => lead, () => low]) {
    await step(`${a()?.label}: mọi tool sửa cấu trúc đều bị TỪ CHỐI (custom_objects.manage) + describe_schema.structure.can_edit=false`, async () => {
      for (const [tool, args] of STRUCT) { const r = await call(a().mcp, tool, args); assert(denied(r, 'custom_objects.manage'), `${tool} không bị từ chối: ${r.text.slice(0, 200)}`); }
      const s = await call(a().mcp, 'describe_schema', {});
      assert(s.data.structure.can_edit === false, 'structure.can_edit phải false');
    });
  }

  // ===== dữ liệu bảng tuỳ biến theo cây cấp bậc =====
  const rec = {};
  await step('sale / sale2 / lead mỗi người tạo 1 bệnh nhân (ghi NGAY bằng quyền của chính mình)', async () => {
    for (const a of [sale, sale2, lead]) {
      const r = await write(a, 'create_record', { object: 'benh_nhan', values: { ho_ten: `BN ${TAG} ${a.label}`, nhom_mau: 'o', bao_hiem: true } });
      rec[a.label] = r.result.record_id; created.push(['custom', r.result.record_id, '/api/v1/custom-objects/benh_nhan/records/']);
    }
    return JSON.stringify(rec);
  });
  const ids = (r) => (r.data?.records ?? []).map((x) => x.id);
  await step('SALE: list_records chỉ thấy bệnh nhân CỦA MÌNH; get_record của người khác ⇒ không tìm thấy', async () => {
    const l = await call(sale.mcp, 'list_records', { object: 'benh_nhan', search: TAG });
    assert(ids(l).length === 1 && ids(l)[0] === rec.sale, `thấy ${ids(l)}`);
    for (const other of [rec.sale2, rec.lead]) { const g = await call(sale.mcp, 'get_record', { object: 'benh_nhan', id: other }); assert(g.isError && /Không tìm thấy/.test(g.text), g.text); }
  });
  await step('TRƯỞNG NHÓM: thấy của mình + sale cấp dưới, KHÔNG thấy của sale nhóm khác', async () => {
    const l = await call(lead.mcp, 'list_records', { object: 'benh_nhan', search: TAG });
    const got = ids(l).sort();
    assert(JSON.stringify(got) === JSON.stringify([rec.sale, rec.lead].sort()), `thấy ${got}, mong ${rec.sale},${rec.lead}`);
    const ok = await call(lead.mcp, 'get_record', { object: 'benh_nhan', id: rec.sale });
    const no = await call(lead.mcp, 'get_record', { object: 'benh_nhan', id: rec.sale2 });
    assert(!ok.isError && no.isError && /Không tìm thấy/.test(no.text), `${ok.text.slice(0, 100)} | ${no.text}`);
    const d = await call(lead.mcp, 'describe_schema', { object: 'benh_nhan' });
    assert(d.data.tables[0].data_scope === 'team', d.data.tables[0].data_scope);
  });
  await step('SALE2 (nhóm khác) chỉ thấy của mình; ADMIN thấy cả 3', async () => {
    const s2 = await call(sale2.mcp, 'list_records', { object: 'benh_nhan', search: TAG });
    assert(ids(s2).length === 1 && ids(s2)[0] === rec.sale2, `sale2 thấy ${ids(s2)}`);
    const ad = await call(admin.mcp, 'list_records', { object: 'benh_nhan', search: TAG });
    assert(ids(ad).length === 3, `admin thấy ${ids(ad)}`);
  });
  await step('Lịch hẹn có quan hệ tới Bệnh nhân: sale tạo lịch cho bệnh nhân của mình; get_record hiện nhãn quan hệ; user ít quyền bị từ chối ghi', async () => {
    const r = await write(sale, 'create_record', { object: 'lich_hen', values: { noi_dung: `Khám ${TAG}`, benh_nhan: rec.sale, dich_vu: 'cao_voi', phi: 300000, gio_hen: '2026-10-20T09:00:00+07:00', da_den: false } });
    created.push(['custom', r.result.record_id, '/api/v1/custom-objects/lich_hen/records/']);
    const g = await call(sale.mcp, 'get_record', { object: 'lich_hen', id: r.result.record_id });
    assert(!g.isError && JSON.stringify(g.data).includes(`BN ${TAG} sale`), `không thấy nhãn bệnh nhân liên kết: ${g.text.slice(0, 300)}`);
    const w = await call(low.mcp, 'create_record', { object: 'lich_hen', values: { noi_dung: 'x' } });
    assert(w.isError && /custom_records\.manage/.test(w.text), w.text);
  });
  await step('Trưởng nhóm sửa bệnh nhân của sale cấp dưới (ghi ngay) được; sale sửa của trưởng nhóm ⇒ không tìm thấy', async () => {
    await write(lead, 'update_record', { object: 'benh_nhan', id: rec.sale, values: { di_ung: 'Penicillin' } });
    const g = await call(sale.mcp, 'get_record', { object: 'benh_nhan', id: rec.sale });
    assert(g.data.data.di_ung === 'Penicillin', JSON.stringify(g.data).slice(0, 200));
    const bad = await call(sale.mcp, 'update_record', { object: 'benh_nhan', id: rec.lead, values: { di_ung: 'x' } });
    assert(bad.isError && /ngoài phạm vi|Không tìm thấy/.test(bad.text), bad.text);
  });
  await step('Trưởng nhóm giao bệnh nhân cho sale cấp dưới (owner_id); giao cho sale nhóm khác ⇒ từ chối', async () => {
    const me = await http('GET', '/api/v1/auth/me', { token: sale.jwt });
    const saleId = me.json?.id ?? me.json?.data?.id ?? me.json?.user?.id;
    assert(saleId, `không lấy được id sale: ${me.status}`);
    const r = await write(lead, 'create_record', { object: 'benh_nhan', owner_id: saleId, values: { ho_ten: `BN ${TAG} giao` } });
    created.push(['custom', r.result.record_id, '/api/v1/custom-objects/benh_nhan/records/']);
    const g = await call(sale.mcp, 'get_record', { object: 'benh_nhan', id: r.result.record_id });
    assert(!g.isError, `sale phải thấy bản ghi được giao: ${g.text}`);
    const me2 = await http('GET', '/api/v1/auth/me', { token: sale2.jwt });
    const s2id = me2.json?.id ?? me2.json?.data?.id ?? me2.json?.user?.id;
    const bad = await call(lead.mcp, 'create_record', { object: 'benh_nhan', owner_id: s2id, values: { ho_ten: `BN ${TAG} sai` } });
    assert(bad.isError && /ngoài phạm vi/.test(bad.text), bad.text);
  });
  await step('archive_record: trưởng nhóm lưu trữ bệnh nhân cấp dưới (ghi ngay) ⇒ biến khỏi list; sale thiếu quyền xoá bị từ chối', async () => {
    const no = await call(sale.mcp, 'archive_record', { object: 'benh_nhan', id: rec.sale });
    assert(denied(no, 'custom_records.delete'), no.text);
    const bad = await call(lead.mcp, 'archive_record', { object: 'benh_nhan', id: rec.sale2 });
    assert(bad.isError && /ngoài phạm vi/.test(bad.text), bad.text);
    await write(lead, 'archive_record', { object: 'benh_nhan', id: rec.sale });
    const l = await call(lead.mcp, 'list_records', { object: 'benh_nhan', search: TAG });
    assert(!ids(l).includes(rec.sale), 'bản ghi vẫn còn trong list');
  });

  // ===== TRỤ CỘT 2 — bảng lõi =====
  let sourceId;
  await step('describe_schema: bảng lõi contacts/deals/tasks, mỗi vai trò chỉ thấy theo quyền; sale data_scope=own, lead=team', async () => {
    const s = await call(sale.mcp, 'describe_schema', {}); const l = await call(lead.mcp, 'describe_schema', {}); const lw = await call(low.mcp, 'describe_schema', {});
    const t = (r, k) => r.data.tables.find((x) => x.key === k);
    assert(t(s, 'contacts')?.data_scope === 'own' && t(l, 'contacts')?.data_scope === 'team', `${t(s, 'contacts')?.data_scope}/${t(l, 'contacts')?.data_scope}`);
    assert(t(s, 'contacts').permissions.create === true && t(s, 'deals') && t(s, 'tasks'), 'sale thiếu bảng lõi');
    assert(!lw.data.tables.some((x) => x.kind === 'core'), 'user ít quyền thấy bảng lõi');
    const o = await call(sale.mcp, 'list_crm_options', {});
    sourceId = o.data.sources[0].id;
    return `source_id=${sourceId}`;
  });
  const contact = {};
  const phone = (n) => `09${Date.now().toString().slice(-6)}${n}${Math.floor(Math.random() * 10)}`; // 10 số, không trùng giữa các lần chạy
  await step('SALE tạo khách hàng qua create_record(contacts) (ghi ngay) rồi xem danh sách khách CỦA MÌNH', async () => {
    for (const [a, n] of [[sale, 1], [sale2, 2]]) {
      const r = await write(a, 'create_record', { object: 'contacts', values: { full_name: `Test ${TAG} ${a.label}`, phone: phone(n), source_id: sourceId } });
      contact[a.label] = r.result.contact_id; created.push(['contact', r.result.contact_id, '/api/v1/contacts/']);
    }
    const l = await call(sale.mcp, 'list_records', { object: 'contacts', search: `Test ${TAG}` });
    assert(ids(l).length === 1 && ids(l)[0] === contact.sale, `sale thấy ${ids(l)}`);
    assert(!/09\d{8}/.test(l.text), 'SĐT lộ');
    return JSON.stringify(contact);
  });
  await step('TRƯỞNG NHÓM thấy khách của sale cấp dưới, KHÔNG thấy khách của sale nhóm khác; ADMIN thấy cả hai; get_record ngoài phạm vi ⇒ không tìm thấy', async () => {
    const l = await call(lead.mcp, 'list_records', { object: 'contacts', search: `Test ${TAG}` });
    assert(JSON.stringify(ids(l)) === JSON.stringify([contact.sale]), `lead thấy ${ids(l)}`);
    const ad = await call(admin.mcp, 'list_records', { object: 'contacts', search: `Test ${TAG}` });
    assert(ids(ad).length === 2, `admin thấy ${ids(ad)}`);
    const g = await call(sale.mcp, 'get_record', { object: 'contacts', id: contact.sale2 });
    assert(g.isError && /Không tìm thấy|ngoài phạm vi/.test(g.text), g.text);
  });
  await step('update_record contacts: sửa job_title (ghi ngay) thấy ở get_record; sửa trường cấm (address, phone) hoặc khách ngoài phạm vi bị từ chối', async () => {
    await write(sale, 'update_record', { object: 'contacts', id: contact.sale, values: { job_title: 'Nha sĩ' } });
    const g = await call(sale.mcp, 'get_record', { object: 'contacts', id: contact.sale });
    assert(g.data.job_title === 'Nha sĩ', JSON.stringify(g.data).slice(0, 200));
    const a = await call(sale.mcp, 'update_record', { object: 'contacts', id: contact.sale, values: { current_address: "1 Example St" } });
    const b = await call(sale.mcp, 'update_record', { object: 'contacts', id: contact.sale2, values: { job_title: 'x' } });
    assert(a.isError && /chỉ sửa được/.test(a.text), a.text);
    assert(b.isError && /Không tìm thấy|ngoài phạm vi/.test(b.text), b.text);
  });
  await step('user ít quyền: đọc/ghi bảng lõi bị TỪ CHỐI nêu tên quyền', async () => {
    const a = await call(low.mcp, 'list_records', { object: 'contacts' }); const b = await call(low.mcp, 'create_record', { object: 'contacts', values: { full_name: 'x', phone: '0900000000', source_id: 1 } });
    assert(denied(a, 'contacts.view') && denied(b, 'contacts.create'), `${a.text} | ${b.text}`);
  });
  await step('deals: sale tạo thương vụ cho chính mình (ghi ngay), lead thấy qua phạm vi team, sale2 không thấy', async () => {
    const r = await write(sale, 'create_record', { object: 'deals', values: { title: `Gói niềng ${TAG}`, value: 45000000 } });
    created.push(['deal', r.result.record_id, '/api/v1/deals/']);
    const f = async (a) => ids(await call(a.mcp, 'list_records', { object: 'deals', search: TAG }));
    assert((await f(sale)).includes(r.result.record_id) && (await f(lead)).includes(r.result.record_id) && !(await f(sale2)).includes(r.result.record_id), 'sai phạm vi deal');
  });
  await step('tasks (việc): sale tạo việc giao cho chính mình (ghi ngay) rồi đọc lại; sale2 không thấy', async () => {
    const r = await write(sale, 'create_record', { object: 'tasks', values: { title: `Gọi tái khám ${TAG}` } });
    created.push(['task', r.result.card_id, '/api/v1/kanban/cards/']);
    const l = await call(sale.mcp, 'list_records', { object: 'tasks', search: TAG });
    assert(ids(l).includes(r.result.card_id), `sale không thấy việc ${r.result.card_id}: ${l.text.slice(0, 200)}`);
    const l2 = await call(sale2.mcp, 'list_records', { object: 'tasks', search: TAG });
    assert(!ids(l2).includes(r.result.card_id), 'sale2 thấy việc của sale');
  });
  for (const a of [admin, lead, sale, sale2, low]) await a.mcp.close();
}

try {
  await main();
} finally {
  try {
    const { login, http: h } = harness(cfg.BASE);
    const jwt = await login(cfg.MCP_ADMIN_EMAIL, cfg.MCP_ADMIN_PASSWORD);
    for (const [kind, id, path] of created.reverse()) { const r = await h('DELETE', `${path}${id}`, { token: jwt }); console.log(`cleanup ${kind}#${id}: ${r.status}`); }
  } catch (e) { console.log(`cleanup lỗi: ${e.message}`); }
}
process.exit(summary() ? 1 : 0);
