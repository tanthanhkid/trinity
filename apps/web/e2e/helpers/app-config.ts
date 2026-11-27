import fs from 'node:fs'
import path from 'node:path'
import type { OrgFeatureKey, Permission } from '@trinity/rbac'

/**
 * Đọc cấu hình tab của app TỪ MÃ NGUỒN (không import — page.tsx kéo cả cây React/CSS).
 * Nhờ vậy kỳ vọng luôn bám app: thêm/đổi quyền của tab ở source là test tự theo.
 * Nếu regex không còn khớp (app đổi định dạng) thì ném lỗi RÕ RÀNG thay vì im lặng.
 */
const SRC = path.join(__dirname, '..', '..', 'src', 'app', '(dashboard)')

export interface SettingsTab {
  value: string
  label: string
  description: string
  permission?: Permission
  /** Cần ÍT NHẤT MỘT trong các quyền (khi không khai `permission`). */
  anyOf?: Permission[]
  /** Công tắc tính năng tổ chức quản tab (tắt = ẩn với mọi người). */
  feature?: OrgFeatureKey
  hidden: boolean
}

export function readSettingsTabs(): SettingsTab[] {
  const src = fs.readFileSync(path.join(SRC, 'settings', 'page.tsx'), 'utf8')
  const block = src.slice(src.indexOf('export const ALL_TABS'), src.indexOf('type TabValue'))
  const tabs: SettingsTab[] = []
  for (const line of block.split('\n')) {
    const m = line.match(/value:\s*"([^"]+)",\s*label:\s*"([^"]+)".*?description:\s*"([^"]*)"/)
    if (!m) continue
    const perm = line.match(/permission:\s*"([^"]+)"/)?.[1] as Permission | undefined
    const anyOfRaw = line.match(/anyOf:\s*\[([^\]]*)\]/)?.[1]
    const anyOf = anyOfRaw ? (anyOfRaw.match(/"([^"]+)"/g) ?? []).map((x) => x.slice(1, -1) as Permission) : undefined
    const feature = line.match(/feature:\s*"([^"]+)"/)?.[1] as OrgFeatureKey | undefined
    tabs.push({ value: m[1], label: m[2], description: m[3], permission: perm, anyOf, feature, hidden: /hidden:\s*true/.test(line) })
  }
  // Số tab đọc được phải bằng số mục `{ value:` của ALL_TABS (đếm từ chính nguồn, không dùng ngưỡng cứng).
  const declared = (block.match(/^\s*\{\s*value:/gm) ?? []).length
  if (tabs.length === 0 || tabs.length !== declared) throw new Error(`readSettingsTabs: đọc được ${tabs.length}/${declared} tab — settings/page.tsx đã đổi định dạng ALL_TABS?`)
  return tabs
}

export interface ReportTab {
  value: string
  label: string
  /** Một quyền (`permission`) hoặc có MỘT trong các quyền (`anyPermission`, vd tab Báo cáo tuỳ chỉnh). */
  permission?: Permission
  anyOf?: Permission[]
}

export function readReportTabs(): ReportTab[] {
  const file = fs.readdirSync(path.join(SRC, 'reports', '_components')).find((f) => /^report-tabs-config\.tsx?$/.test(f))
  if (!file) throw new Error('Không thấy report-tabs-config')
  const src = fs.readFileSync(path.join(SRC, 'reports', '_components', file), 'utf8')
  const out: ReportTab[] = []
  // Mỗi tab bắt đầu ở `value: "..", label: ".."`; quyền nằm trước tab kế tiếp: `permission: ".."` hoặc `anyPermission: [..]`.
  const starts = [...src.matchAll(/value:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)]
  starts.forEach((m, i) => {
    const chunk = src.slice(m.index!, starts[i + 1]?.index ?? src.length)
    const perm = chunk.match(/\bpermission:\s*"([^"]+)"/)?.[1] as Permission | undefined
    const anyRaw = chunk.match(/anyPermission:\s*\[([^\]]*)\]/)?.[1]
    const anyOf = anyRaw ? (anyRaw.match(/"([^"]+)"/g) ?? []).map((x) => x.slice(1, -1) as Permission) : undefined
    if (!perm && !anyOf) throw new Error(`readReportTabs: tab "${m[1]}" không có permission/anyPermission`)
    out.push({ value: m[1], label: m[2], permission: perm, anyOf })
  })
  const declared = (src.match(/^\s*value:\s*"/gm) ?? []).length
  if (out.length === 0 || out.length !== declared) throw new Error(`readReportTabs: đọc được ${out.length}/${declared} tab`)
  return out
}
