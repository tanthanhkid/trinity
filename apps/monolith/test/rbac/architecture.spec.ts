import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * Test kiến trúc RBAC: hệ vai trò cũ phải biến mất khỏi mã nguồn.
 * Quét services/*\/src, apps/monolith/src, packages/*\/src → 0 match.
 */
const TRINITY_ROOT = join(__dirname, '..', '..', '..', '..')

const ROLE_CODES = [
  'super_admin',
  'hr',
  'team_lead',
  'sale',
  'operations',
  'quality',
  'accountant',
  'chief_accountant',
  'marketing',
  'sales_manager',
  'operations_manager',
]

const PATTERNS: RegExp[] = [
  /@Roles\(/,
  /hasSuperAdminPowers/,
  /inheritsSuperAdmin/,
  /NoSuperAdminInheritance/,
  /\b[A-Z][A-Z0-9]*_ROLES\b/,
  /CustomerDataDownloadInterceptor/,
  /RBAC_STRICT/,
  new RegExp(`['"\`](${ROLE_CODES.join('|')})['"\`]`),
]

/**
 * Ngoại lệ CÓ CHỦ ĐÍCH — chuỗi trùng mã vai trò cũ nhưng KHÔNG phải phân quyền:
 * dữ liệu nghiệp vụ (vị trí nhân sự, kênh tuyển dụng, tag đã lưu DB) hoặc
 * giá trị hợp đồng với FE. Thêm dòng vào đây phải kèm lý do.
 */
const ALLOWLIST: Record<string, string> = {
  'services/crm/src/employees/dto/create-employee.dto.ts': 'vị trí nhân sự + kênh tuyển dụng (dữ liệu HR)',
  'services/crm/src/employees/dto/update-employee.dto.ts': 'kênh tuyển dụng (dữ liệu HR)',
  'services/crm/src/employees/dto/query-employees.dto.ts': 'ví dụ lọc theo vị trí nhân sự (dữ liệu HR)',
  'services/payroll/src/employees/dto/create-employee.dto.ts': 'vị trí nhân sự (dữ liệu HR/lương)',
  'services/payroll/src/employees/dto/update-employee.dto.ts': 'vị trí nhân sự (dữ liệu HR/lương)',
  'services/payroll/src/employees/dto/query-employee.dto.ts': 'vị trí nhân sự (dữ liệu HR/lương)',
  'services/payroll/src/salary-rules/dto/create-rule.dto.ts': 'vị trí nhân sự áp dụng quy tắc lương',
  'services/payroll/src/kpi/dto/create-kpi-config.dto.ts': 'cấu hình KPI theo vị trí nhân sự (dữ liệu lương)',
  'services/payroll/src/kpi/dto/query-kpi-config.dto.ts': 'cấu hình KPI theo vị trí nhân sự (dữ liệu lương)',
  'services/payroll/src/kpi/kpi.controller.ts': 'cấu hình KPI theo vị trí nhân sự (dữ liệu lương)',
  'services/payroll/src/kpi/kpi.service.ts': 'ánh xạ vị trí nhân sự → cấu hình KPI (dữ liệu lương)',
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '__snapshots__'])

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full)
  }
}

/** Bỏ comment (giữ số dòng) — chỉ MÃ chạy được mới tính; comment lịch sử được phép nhắc tên cũ. */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return noBlock.replace(/(^|\s)\/\/.*$/gm, '$1')
}

function sourceRoots(): string[] {
  const roots = [join(TRINITY_ROOT, 'apps/monolith/src')]
  for (const group of ['services', 'packages']) {
    for (const name of readdirSync(join(TRINITY_ROOT, group))) {
      roots.push(join(TRINITY_ROOT, group, name, 'src'))
    }
  }
  return roots
}

describe('kiến trúc RBAC — hệ vai trò cũ đã gỡ sạch', () => {
  it('0 match trong mã nguồn (bỏ comment, bỏ *.spec.ts / *.test.ts / __tests__)', () => {
    const files: string[] = []
    for (const r of sourceRoots()) walk(r, files)
    const hits: string[] = []
    for (const file of files) {
      const rel = relative(TRINITY_ROOT, file)
      if (/\.(spec|test)\.tsx?$/.test(rel) || rel.includes('__tests__')) continue
      if (rel in ALLOWLIST) continue
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (PATTERNS.some((p) => p.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })
})

describe('kiến trúc RBAC — ngoại lệ', () => {
  it('mọi file trong ALLOWLIST còn tồn tại (dọn khi file bị xoá)', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(() => statSync(join(TRINITY_ROOT, rel))).not.toThrow()
    }
  })
})
