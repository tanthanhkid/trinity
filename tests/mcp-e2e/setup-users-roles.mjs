#!/usr/bin/env node
/**
 * Tạo thêm 3 user thử cho e2e MCP trên DB demo (Neon) — KHÔNG chạy trên DB có dữ liệu thật:
 *   mcp-lead@…   Trưởng nhóm  (vai trò "MCP e2e - Trưởng nhóm": sao chép quyền "Trưởng nhóm" thật + ai_connect + custom_records.* phạm vi team)
 *   mcp-sale@…   Sale cấp dưới trực tiếp của mcp-lead (vai trò "MCP e2e - Sale": sao chép "Nhân viên kinh doanh" + ai_connect + custom_records.view/manage own)
 *   mcp-sale2@…  Sale ở NHÓM KHÁC (manager = user admin thử mcp-test)
 * Ghi mật khẩu vào file credentials (KHÔNG commit), nối vào các khoá MCP_ADMIN và MCP_LOW đã có. Idempotent: chạy lại = đặt lại mật khẩu.
 *
 *   DEMO_ENV_FILE=<.env có DATABASE_URL_UNPOOLED> node tests/mcp-e2e/setup-users-roles.mjs <credentials-sẵn-có> [credentials-ra]
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(resolve(root, 'packages/prisma/package.json'));
const { PrismaClient } = req('@prisma/client');
const bcrypt = req('bcryptjs');

const readEnv = (f) => Object.fromEntries(readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const env = process.env.DEMO_DATABASE_URL ? { DATABASE_URL_UNPOOLED: process.env.DEMO_DATABASE_URL } : readEnv(process.env.DEMO_ENV_FILE ?? '');
const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
if (!url || !/neon\.tech$/.test(new URL(url).hostname)) throw new Error('Từ chối: chỉ chạy trên DB demo (Neon)');
const prisma = new PrismaClient({ datasources: { db: { url } } });
const pw = () => randomBytes(12).toString('base64url');

async function cloneRole(name, source, extra) {
  const src = await prisma.role.findFirst({ where: { name: source } });
  const base = src ? await prisma.rolePermission.findMany({ where: { role_id: src.id } }) : [];
  const role = await prisma.role.upsert({ where: { name }, update: {}, create: { name, description: `Vai trò thử e2e MCP (sao chép "${source}")` } });
  const merged = new Map(base.map((p) => [p.permission, p.scope]));
  for (const [k, v] of Object.entries(extra)) merged.set(k, v);
  await prisma.rolePermission.deleteMany({ where: { role_id: role.id } });
  await prisma.rolePermission.createMany({ data: [...merged].map(([permission, scope]) => ({ role_id: role.id, permission, scope })) });
  return role;
}

async function upsertUser(email, fullName, password, roleId, managerId) {
  const password_hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { password_hash, status: 'active', deleted_at: null, full_name: fullName, manager_id: managerId },
    create: { email, password_hash, full_name: fullName, status: 'active', manager_id: managerId },
  });
  await prisma.userRole.deleteMany({ where: { user_id: user.id } });
  await prisma.userRole.create({ data: { user_id: user.id, role_id: roleId } });
  return user;
}

try {
  const admin = await prisma.user.findUnique({ where: { email: 'mcp-test@example.com' } });
  if (!admin) throw new Error('Chưa có mcp-test (chạy setup-users.mjs trước)');
  const leadRole = await cloneRole('MCP e2e - Trưởng nhóm', 'Trưởng nhóm', { 'integrations.ai_connect': null, 'contacts.create': null, 'custom_records.view': 'team', 'custom_records.manage': 'team', 'custom_records.delete': 'team' });
  const saleRole = await cloneRole('MCP e2e - Sale', 'Nhân viên kinh doanh', { 'integrations.ai_connect': null, 'contacts.create': null, 'custom_records.view': 'own', 'custom_records.manage': 'own' });
  const [a, b, c] = [pw(), pw(), pw()];
  const lead = await upsertUser('mcp-lead@example.com', 'MCP Test (trưởng nhóm)', a, leadRole.id, null);
  const sale = await upsertUser('mcp-sale@example.com', 'MCP Test (sale cấp dưới)', b, saleRole.id, lead.id);
  const sale2 = await upsertUser('mcp-sale2@example.com', 'MCP Test (sale nhóm khác)', c, saleRole.id, admin.id);
  const inFile = process.argv[2];
  const keep = inFile ? readFileSync(inFile, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l) && !/^MCP_(LEAD|SALE|SALE2)_/.test(l)) : [];
  const out = process.argv[3] || inFile;
  writeFileSync(out, [...keep, `MCP_LEAD_EMAIL=${lead.email}`, `MCP_LEAD_PASSWORD=${a}`, `MCP_SALE_EMAIL=${sale.email}`, `MCP_SALE_PASSWORD=${b}`, `MCP_SALE2_EMAIL=${sale2.email}`, `MCP_SALE2_PASSWORD=${c}`, ''].join('\n'));
  chmodSync(out, 0o600);
  console.log(`OK: lead id=${lead.id}, sale id=${sale.id} (manager ${sale.manager_id}), sale2 id=${sale2.id} (manager ${sale2.manager_id}); credentials -> ${out}`);
} finally {
  await prisma.$disconnect();
}
