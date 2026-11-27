#!/usr/bin/env node
/**
 * Tạo 2 user thử cho e2e MCP trên DB demo (Neon) — KHÔNG chạy trên DB có dữ liệu thật.
 *   mcp-test@example.com  → vai trò "Quản trị" (is_system)
 *   mcp-low@example.com   → vai trò "MCP e2e - chỉ xem": integrations.ai_connect + custom_records.view (own)
 * Ghi mật khẩu vào file credentials (KHÔNG commit). Idempotent: chạy lại = đặt lại mật khẩu mới.
 *
 *   DEMO_DATABASE_URL=<neon url> node tests/mcp-e2e/setup-users.mjs [đường-dẫn-credentials]
 * (hoặc DEMO_ENV_FILE=<file .env có DATABASE_URL_UNPOOLED/DATABASE_URL>)
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const req = createRequire(resolve(root, 'tests/contract/package.json'));
const pg = req('pg');
const bcrypt = req('bcryptjs');

function dbUrl() {
  if (process.env.DEMO_DATABASE_URL) return process.env.DEMO_DATABASE_URL;
  const file = process.env.DEMO_ENV_FILE;
  if (!file) throw new Error('Cần DEMO_DATABASE_URL hoặc DEMO_ENV_FILE');
  const env = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
  return env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
}

const url = dbUrl();
const host = new URL(url).hostname;
// Chốt an toàn: chỉ chạy trên DB demo (host Neon) hoặc máy cục bộ. Từ chối mọi host khác.
if (!/neon\.tech$/.test(host) && !['localhost', '127.0.0.1'].includes(host)) throw new Error(`Từ chối: ${host} không phải DB demo/cục bộ`);

const db = new pg.Client({ connectionString: url });
await db.connect();
const pw = () => randomBytes(12).toString('base64url');

async function upsertUser(email, fullName, password, roleId) {
  const password_hash = await bcrypt.hash(password, 10);
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())
     ON CONFLICT (email) DO UPDATE SET password_hash = $2, status = 'active', deleted_at = NULL, full_name = $3, updated_at = now()
     RETURNING id`, [email, password_hash, fullName]);
  const id = rows[0].id;
  await db.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
  await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [id, roleId]);
  return { id };
}

try {
  const adminRole = (await db.query('SELECT id FROM roles WHERE is_system = true ORDER BY id LIMIT 1')).rows[0];
  if (!adminRole) throw new Error('Không có vai trò hệ thống "Quản trị"');
  const lowRole = (await db.query(
    `INSERT INTO roles (name, description, updated_at) VALUES ('MCP e2e - chỉ xem', 'Vai trò thử cho e2e MCP', now())
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`)).rows[0];
  await db.query('DELETE FROM role_permissions WHERE role_id = $1', [lowRole.id]);
  await db.query(`INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1, 'integrations.ai_connect', NULL), ($1, 'custom_records.view', 'own')`, [lowRole.id]);
  const adminPw = pw(); const lowPw = pw();
  const a = await upsertUser('mcp-test@example.com', 'MCP Test (admin)', adminPw, adminRole.id);
  const l = await upsertUser('mcp-low@example.com', 'MCP Test (ít quyền)', lowPw, lowRole.id);
  const out = process.argv[2] || process.env.MCP_CREDENTIALS || (console.error('Cần đường dẫn file credentials (đối số 1 hoặc biến MCP_CREDENTIALS)'), process.exit(2));
  writeFileSync(out, [
    '# Tài khoản thử e2e MCP — instance tự dựng. KHÔNG commit.',
    'MCP_BASE=http://localhost:4000',
    'MCP_ADMIN_EMAIL=mcp-test@example.com', `MCP_ADMIN_PASSWORD=${adminPw}`,
    'MCP_LOW_EMAIL=mcp-low@example.com', `MCP_LOW_PASSWORD=${lowPw}`, '',
  ].join('\n'));
  chmodSync(out, 0o600);
  console.log(`OK: admin id=${a.id}, low id=${l.id}; credentials -> ${out}`);
} finally {
  await db.end();
}
