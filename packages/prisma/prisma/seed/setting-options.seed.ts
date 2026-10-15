import { PrismaClient, Prisma } from '@prisma/client'

export interface SeedOption {
  group_key: string
  value: string
  label: string
  sort_order: number
  is_active: boolean
  is_system: boolean
  metadata?: Record<string, unknown>
}

// Nguồn khách (contact_source) — seed is_system=true, KHÔNG xoá được.
// Các mã `value` được mã nguồn tham chiếu trực tiếp (liên kết Zalo, chấm điểm lead)
// — đổi nhãn thoải mái nhưng đừng đổi `value`.
const CONTACT_SOURCES: SeedOption[] = [
  { group_key: 'contact_source', value: 'website', label: 'Website', sort_order: 1, is_active: true, is_system: true },
  { group_key: 'contact_source', value: 'facebook', label: 'Facebook', sort_order: 2, is_active: true, is_system: true },
  { group_key: 'contact_source', value: 'zalo', label: 'Zalo', sort_order: 3, is_active: true, is_system: true },
  { group_key: 'contact_source', value: 'referral', label: 'Giới thiệu', sort_order: 4, is_active: true, is_system: true },
  { group_key: 'contact_source', value: 'partner_referral', label: 'Đối tác giới thiệu', sort_order: 5, is_active: true, is_system: true },
  { group_key: 'contact_source', value: 'ads', label: 'Quảng cáo', sort_order: 6, is_active: true, is_system: true },
  { group_key: 'contact_source', value: 'other', label: 'Khác', sort_order: 7, is_active: true, is_system: true },
]

// 4 giai đoạn danh bạ (mã `follow_up_*` giữ cố định, nhãn tuỳ chỉnh) (contact_stage) — is_system=true.
const CONTACT_STAGES: SeedOption[] = [
  { group_key: 'contact_stage', value: 'new', label: 'Mới', sort_order: 1, is_active: true, is_system: true },
  { group_key: 'contact_stage', value: 'follow_up_1', label: 'Đang tư vấn', sort_order: 2, is_active: true, is_system: true },
  { group_key: 'contact_stage', value: 'follow_up_2', label: 'Đã báo giá', sort_order: 3, is_active: true, is_system: true },
  { group_key: 'contact_stage', value: 'follow_up_3', label: 'Sắp chốt', sort_order: 4, is_active: true, is_system: true },
]

// Trạng thái chi tiết danh bạ (contact_detail_status) — is_system=false (cho sửa/thêm).
const CONTACT_DETAIL_STATUSES: SeedOption[] = [
  { group_key: 'contact_detail_status', value: 'follow_up_later', label: 'Hẹn liên hệ lại', sort_order: 1, is_active: true, is_system: false },
  { group_key: 'contact_detail_status', value: 'not_contacted', label: 'Chưa tiếp cận', sort_order: 5, is_active: true, is_system: false },
  { group_key: 'contact_detail_status', value: 'other', label: 'Khác', sort_order: 6, is_active: true, is_system: false },
]

export const ALL_SETTING_OPTIONS: SeedOption[] = [
  ...CONTACT_SOURCES,
  ...CONTACT_STAGES,
  ...CONTACT_DETAIL_STATUSES,
]

export async function seedSettingOptions(prisma: PrismaClient): Promise<void> {
  for (const opt of ALL_SETTING_OPTIONS) {
    const metadata: Prisma.InputJsonValue | typeof Prisma.JsonNull = opt.metadata
      ? (opt.metadata as Prisma.InputJsonValue)
      : Prisma.JsonNull
    await prisma.settingOption.upsert({
      where: { group_key_value: { group_key: opt.group_key, value: opt.value } },
      update: {
        label: opt.label,
        sort_order: opt.sort_order,
        is_system: opt.is_system,
        // KHÔNG overwrite is_active khi re-seed để tôn trọng thao tác admin.
        metadata,
      },
      create: {
        group_key: opt.group_key,
        value: opt.value,
        label: opt.label,
        sort_order: opt.sort_order,
        is_active: opt.is_active,
        is_system: opt.is_system,
        metadata,
      },
    })
  }
  const counts = ALL_SETTING_OPTIONS.reduce<Record<string, number>>((acc, o) => {
    acc[o.group_key] = (acc[o.group_key] ?? 0) + 1
    return acc
  }, {})
  console.log(
    `Seeded ${ALL_SETTING_OPTIONS.length} setting options: ` +
      Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', '),
  )
}
