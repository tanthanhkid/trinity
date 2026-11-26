import bcrypt from 'bcryptjs'
import pg from 'pg'
import { config } from './config.js'

/**
 * Seed và sửa DB bằng SQL, dùng chung cho Node và Rust (máy chủ hộp đen không có đường nào khác).
 * Mọi mốc thời gian seed là TƯƠNG ĐỐI (`now() - interval '…'`) để response tính theo "hôm nay" không đổi theo ngày chạy.
 * Công ty 1 nằm ở schema `public`; công ty khác ở `c_<id>` (`withSchema`).
 */
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4 })

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows
}

export async function closeDb(): Promise<void> {
  await pool.end()
}

export type Scope = 'own' | 'team' | 'subtree' | 'all' | null

export interface SeededUser {
  id: number
  email: string
  password: string
}

let seq = 0
/** Mỗi lượt chạy có DB mới nên tên vai trò không cần dấu thời gian (tên vai trò nằm trong response, phải ổn định); email thì cần để chạy lại trên cùng DB không trùng. */
const stamp = Date.now().toString(36)

/** Tạo người dùng + vai trò riêng với đúng quyền cho trước (scope `null` = không giới hạn phạm vi). */
export async function seedUser(opts: {
  label: string
  grants: Record<string, Scope>
  password?: string
  managerId?: number | null
  teamId?: number | null
}): Promise<SeededUser> {
  seq += 1
  const password = opts.password ?? 'Contract-Pass-123'
  const email = `${opts.label}-${stamp}-${seq}@contract.test`
  const hash = bcrypt.hashSync(password, 4)
  const [u] = await q<{ id: number }>(
    `INSERT INTO users (email, password_hash, full_name, status, manager_id, updated_at)
     VALUES ($1, $2, $3, 'active', $4, now()) RETURNING id`,
    [email, hash, `Contract ${opts.label}`, opts.managerId ?? null],
  )
  const [r] = await q<{ id: number }>(`INSERT INTO roles (name, is_system) VALUES ($1, false) RETURNING id`, [`contract-${opts.label}-${seq}`])
  for (const [permission, scope] of Object.entries(opts.grants)) {
    await q(`INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1, $2, $3)`, [r.id, permission, scope])
  }
  await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, r.id])
  return { id: u.id, email, password }
}

/** Thêm quyền cho vai trò của người dùng đã seed (để thử "sửa quyền trong DB rồi gọi lại"; sau đó phải xoá cache bằng API điều khiển). */
export async function grant(userId: number, permission: string, scope: Scope = null): Promise<void> {
  await q(
    `INSERT INTO role_permissions (role_id, permission, scope)
     SELECT role_id, $2, $3 FROM user_roles WHERE user_id = $1 LIMIT 1
     ON CONFLICT DO NOTHING`,
    [userId, permission, scope],
  )
}

/** Khách seed với mốc tạo cách đây `daysAgo` ngày (tương đối so với `now()` của DB). */
export async function seedContact(opts: { phone: string; name: string; ownerId: number; daysAgo?: number }): Promise<number> {
  const [c] = await q<{ id: number }>(
    `INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, created_at, updated_at)
     VALUES ($1, $2, $3, $3, now() - ($4 || ' days')::interval, now()) RETURNING id`,
    [opts.phone, opts.name, opts.ownerId, String(opts.daysAgo ?? 0)],
  )
  return c.id
}

export async function setSetting(key: string, value: string): Promise<void> {
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  )
}
