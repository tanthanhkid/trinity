import { PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { seedSettingOptions } from './seed/setting-options.seed'
import { seedDefaultKanbanBoard } from './seed/kanban-default.seed'

const prisma = new PrismaClient()

// RBAC "quyền + phạm vi": chỉ còn ĐÚNG 1 vai trò hệ thống "Quản trị" (is_system=true,
// mọi quyền scope `all` — PermissionService.grantsFor tự suy, KHÔNG cần insert
// role_permissions). Vai trò khác do admin tạo ở Cài đặt > Vai trò.
const ADMIN_ROLE_NAME = 'Quản trị'

/**
 * Mật khẩu admin lần đầu:
 *  - `SEED_ADMIN_PASSWORD` (env) nếu được đặt;
 *  - nếu không: sinh ngẫu nhiên và IN RA MỘT LẦN trong log (chỉ khi tạo user mới).
 * Không bao giờ có mật khẩu mặc định cố định trong mã nguồn. Re-seed KHÔNG ghi đè
 * mật khẩu của user đã tồn tại.
 */
function resolveAdminPassword(): { password: string; generated: boolean } {
  const fromEnv = process.env.SEED_ADMIN_PASSWORD?.trim()
  if (fromEnv) return { password: fromEnv, generated: false }
  return { password: randomBytes(12).toString('base64url'), generated: true }
}

async function seedDemoData(adminId: number): Promise<void> {
  const teams = ['Team A', 'Team B']
  for (const name of teams) {
    await prisma.team.upsert({ where: { name }, update: {}, create: { name } })
  }
  const source = await prisma.settingOption.findUnique({
    where: { group_key_value: { group_key: 'contact_source', value: 'website' } },
    select: { id: true },
  })
  const names = ['Nguyễn Văn A', 'Trần Thị B', 'Lê Văn C', 'Phạm Thị D', 'Hoàng Văn E']
  let created = 0
  for (let i = 0; i < names.length; i++) {
    const full_name = names[i]
    const phone = `090000000${i + 1}`
    const exists = await prisma.contact.findFirst({ where: { phone }, select: { id: true } })
    if (exists) continue
    await prisma.contact.create({
      data: {
        phone,
        full_name,
        email: `demo${i + 1}@example.com`,
        source_id: source?.id ?? null,
        assigned_to: adminId,
        created_by_id: adminId,
      },
    })
    created++
  }
  // Có dữ liệu mẫu → coi như đã dựng quy trình (menu đầy đủ).
  await prisma.setting.upsert({
    where: { key: 'setup_status' },
    update: { value: 'da_dung' },
    create: { key: 'setup_status', value: 'da_dung' },
  })
  console.log(`Seeded demo data: ${teams.length} teams, ${created} contacts`)
}

async function main() {
  const adminRole = await prisma.role.upsert({
    where: { name: ADMIN_ROLE_NAME },
    update: { is_system: true },
    create: {
      name: ADMIN_ROLE_NAME,
      description: 'Toàn quyền hệ thống — không sửa/xoá được',
      is_system: true,
    },
  })
  console.log(`Seeded role: ${ADMIN_ROLE_NAME} (is_system)`)

  // Các nhóm tuỳ chọn cấu hình động (nguồn khách, giai đoạn, trạng thái...)
  await seedSettingOptions(prisma)

  // User Quản trị đầu tiên.
  const adminEmail = (process.env.SEED_ADMIN_EMAIL?.trim() || 'admin@example.com').toLowerCase()
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } })
  let admin = existing
  if (!existing) {
    const { password, generated } = resolveAdminPassword()
    admin = await prisma.user.create({
      data: {
        email: adminEmail,
        password_hash: await bcrypt.hash(password, 10),
        full_name: 'Quản trị viên',
        status: 'active',
      },
    })
    console.log('==================================================================')
    console.log(`Admin account created: ${adminEmail}`)
    if (generated) {
      console.log(`Generated password (shown ONCE, change it after login): ${password}`)
    } else {
      console.log('Password taken from SEED_ADMIN_PASSWORD.')
    }
    console.log('==================================================================')
  } else {
    console.log(`Admin user ${adminEmail} already exists — password left unchanged.`)
  }
  await prisma.userRole.upsert({
    where: { user_id_role_id: { user_id: admin!.id, role_id: adminRole.id } },
    update: {},
    create: { user_id: admin!.id, role_id: adminRole.id },
  })
  console.log(`Seeded user: ${adminEmail} (${ADMIN_ROLE_NAME})`)

  // Bảng công việc mặc định (chỉ khi chưa từng có bảng nào) — để tạo việc chạy được ngay trên bản cài mới.
  if (await seedDefaultKanbanBoard(prisma, admin!.id)) {
    console.log('Seeded default kanban board')
  }

  if ((process.env.SEED_DEMO_DATA ?? 'false').toLowerCase() === 'true') {
    await seedDemoData(admin!.id)
  }

  console.log('Seed completed!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
