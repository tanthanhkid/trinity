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
  if (tabs.length < 15) throw new Error(`readSettingsTabs: chỉ đọc được ${tabs.length} tab — settings/page.tsx đã đổi định dạng ALL_TABS?`)
  return tabs
}

export interface ReportTab {
  value: string
  label: string
  permission: Permission
}

export function readReportTabs(): ReportTab[] {
  const file = fs.readdirSync(path.join(SRC, 'reports', '_components')).find((f) => /^report-tabs-config\.tsx?$/.test(f))
  if (!file) throw new Error('Không thấy report-tabs-config')
  const src = fs.readFileSync(path.join(SRC, 'reports', '_components', file), 'utf8')
  const out: ReportTab[] = []
  const re = /value:\s*"([^"]+)",\s*label:\s*"([^"]+)"[\s\S]*?permission:\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push({ value: m[1], label: m[2], permission: m[3] as Permission })
  if (out.length < 5) throw new Error(`readReportTabs: chỉ đọc được ${out.length} tab`)
  return out
}
