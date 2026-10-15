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
const req = createRequire(resolve(root, 'packages/prisma/package.json'));
const { PrismaClient } = req('@prisma/client');
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
// Chốt an toàn: chỉ chạy trên DB demo (host Neon). Từ chối mọi host khác.
if (!/neon\.tech$/.test(host)) throw new Error(`Từ chối: ${host} không phải DB demo (Neon)`);

const prisma = new PrismaClient({ datasources: { db: { url } } });
const pw = () => randomBytes(12).toString('base64url');

async function upsertUser(email, fullName, password, roleId) {
  const password_hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { password_hash, status: 'active', deleted_at: null, full_name: fullName },
    create: { email, password_hash, full_name: fullName, status: 'active' },
  });
  await prisma.userRole.deleteMany({ where: { user_id: user.id } });
  await prisma.userRole.create({ data: { user_id: user.id, role_id: roleId } });
  return user;
}

try {
  const adminRole = await prisma.role.findFirst({ where: { is_system: true } });
  if (!adminRole) throw new Error('Không có vai trò hệ thống "Quản trị"');
  const lowRole = await prisma.role.upsert({ where: { name: 'MCP e2e - chỉ xem' }, update: {}, create: { name: 'MCP e2e - chỉ xem', description: 'Vai trò thử cho e2e MCP' } });
  await prisma.rolePermission.deleteMany({ where: { role_id: lowRole.id } });
  await prisma.rolePermission.createMany({ data: [
    { role_id: lowRole.id, permission: 'integrations.ai_connect', scope: null },
    { role_id: lowRole.id, permission: 'custom_records.view', scope: 'own' },
  ] });
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
  await prisma.$disconnect();
}
