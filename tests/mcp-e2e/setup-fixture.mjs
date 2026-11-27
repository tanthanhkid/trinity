#!/usr/bin/env node
/**
 * Dựng bảng tuỳ biến "Học sinh" (hoc_sinh) mà run.mjs cần, trên DB thử trống (chế độ Rust của run-rust.sh).
 * Bản demo Neon có sẵn bảng này; DB `seed --sample` thì không. Idempotent: bảng đã có thì bỏ qua.
 *   node tests/mcp-e2e/setup-fixture.mjs <credentials>      (cần setup-users.mjs trước)
 */
import { assert, harness, loadConfig } from './lib.mjs';

const cfg = loadConfig(process.argv[2] || process.env.MCP_CREDENTIALS || (console.error('Cần đường dẫn file credentials'), process.exit(2)));
const { actor, call } = harness(cfg.BASE);
const admin = await actor('fixture', cfg.MCP_ADMIN_EMAIL, cfg.MCP_ADMIN_PASSWORD);
try {
  const s = await call(admin.mcp, 'describe_schema', {});
  assert(!s.isError, s.text);
  if (s.data.tables.some((t) => t.key === 'hoc_sinh')) { console.log('hoc_sinh đã có'); } else {
    const r = await call(admin.mcp, 'create_objects', { confirmed_by_user: 'ok', objects: [{ key: 'hoc_sinh', label: 'Học sinh', fields: [
      { label: 'Họ tên', key: 'ho_ten', type: 'text', required: true },
      { label: 'Tuổi', key: 'tuoi', type: 'number' },
      { label: 'Tình trạng học', key: 'tinh_trang_hoc', type: 'select', choices: ['Đang học', 'Bảo lưu', 'Đã nghỉ'] },
    ] }] });
    assert(!r.isError && r.data?.status === 'executed', r.text.slice(0, 300));
    console.log('đã tạo hoc_sinh');
  }
} finally { await admin.mcp.close(); }
