/**
 * Đổi gói dịch vụ từ máy chủ: `pnpm --filter @trinity/crm plan:set <ket_noi|tro_ly_giam_doc|tro_ly_kinh_doanh|tro_ly_van_hanh|custom>`
 * Chạy ở server có DATABASE_URL; ghi nhật ký audit_logs (user_id rỗng, source=cli).
 */
import { PrismaClient } from '@prisma/client';
import { PLAN_KEYS, isPlanKey } from '@trinity/rbac';

const KEY = 'org_plan';

async function main() {
  const plan = process.argv[2];
  if (!isPlanKey(plan)) {
    console.error(`Gói không hợp lệ: ${plan ?? '(trống)'}. Chọn một trong: ${PLAN_KEYS.join(', ')}`);
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const old = await prisma.setting.findUnique({ where: { key: KEY }, select: { value: true } });
    const from = old?.value?.trim() || 'custom';
    await prisma.$transaction([
      prisma.setting.upsert({
        where: { key: KEY },
        update: { value: plan, updated_by: null },
        create: { key: KEY, value: plan, updated_by: null },
      }),
      prisma.auditLog.create({
        data: { action: 'update', resource: 'org_plan', metadata: { from, to: plan, source: 'cli' } },
      }),
    ]);
    console.log(`Đã đổi gói: ${from} -> ${plan}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
