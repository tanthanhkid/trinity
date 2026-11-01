import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import * as bcrypt from 'bcryptjs'
import { clientForSchema, databaseUrlForSchema, getBaseClient } from './clients'
import { CompanyRef, isMultiTenant, runWithCompany, schemaForCompany } from './context'
import { ensurePlatform, forgetCompanyCache, installSyncTriggers, listActiveCompanies } from './platform'
import { seedSettingOptions } from '../seed/setting-options.seed'
import { seedDefaultKanbanBoard } from '../seed/kanban-default.seed'

const run = promisify(execFile)

/** `packages/prisma` — same depth from `src/tenant` and `dist/tenant`. */
const PACKAGE_DIR = path.resolve(__dirname, '..', '..')
const SCHEMA_FILE = path.join(PACKAGE_DIR, 'prisma', 'schema.prisma')
const MIGRATIONS_DIR = path.join(PACKAGE_DIR, 'prisma', 'migrations')

export const ADMIN_ROLE_NAME = 'Quản trị'

export function latestMigrationName(): string | null {
  if (!existsSync(MIGRATIONS_DIR)) return null
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  return dirs.at(-1) ?? null
}

/** Runs `prisma migrate deploy` against one company schema (Prisma keeps a `_prisma_migrations` per schema). */
export async function migrateCompanySchema(company: CompanyRef): Promise<void> {
  if (company.schema === 'public') return // company 1 is migrated by the normal deploy step
  const cli = require.resolve('prisma/build/index.js', { paths: [PACKAGE_DIR] })
  await run(process.execPath, [cli, 'migrate', 'deploy', '--schema', SCHEMA_FILE], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrlForSchema(company.schema), PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    timeout: 5 * 60_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  const latest = latestMigrationName()
  await getBaseClient().$executeRawUnsafe(`UPDATE platform.companies SET migrated_to = $1 WHERE id = $2`, latest, company.id)
}

/**
 * Brings every company schema up to the latest migration. Called at boot (multi-tenant mode) and by
 * `scripts/migrate-companies` during deploys; a no-op for schemas already current.
 */
export async function migrateAllCompanies(log: (msg: string) => void = () => undefined): Promise<void> {
  if (!isMultiTenant()) return
  await ensurePlatform()
  const latest = latestMigrationName()
  const rows = await getBaseClient().$queryRawUnsafe<Array<{ id: number; schema_name: string; migrated_to: string | null }>>(
    `SELECT id, schema_name, migrated_to FROM platform.companies WHERE id <> 1 ORDER BY id`,
  )
  for (const r of rows) {
    if (latest && r.migrated_to === latest) continue
    log(`migrating company ${r.id} (${r.schema_name})`)
    await migrateCompanySchema({ id: r.id, schema: r.schema_name })
  }
}

export interface ProvisionInput {
  companyName: string
  adminEmail: string
  adminPassword: string
  adminName: string
}

export interface ProvisionResult {
  company: CompanyRef
  adminUserId: number
}

/**
 * Creates a new company: a row in platform.companies, its own schema with every migration applied, the sync
 * triggers, the system role "Quản trị", default options and task board, and the admin user. The CRM starts
 * empty, so the admin lands on the setup wizard.
 */
export async function provisionCompany(input: ProvisionInput): Promise<ProvisionResult> {
  if (!isMultiTenant()) throw new Error('provisionCompany() requires MULTI_TENANT=true')
  await ensurePlatform()
  const base = getBaseClient()
  const email = input.adminEmail.trim().toLowerCase()

  // Reserve the id and the email first, so two sign-ups with the same email cannot both pass.
  const company = await base.$transaction(async (tx) => {
    const taken = await tx.$queryRawUnsafe<Array<{ company_id: number }>>(
      `SELECT company_id FROM platform.company_logins WHERE email = $1`,
      email,
    )
    if (taken.length) throw new EmailTakenError()
    const ids = await tx.$queryRawUnsafe<Array<{ id: number }>>(`SELECT nextval(pg_get_serial_sequence('platform.companies', 'id'))::int AS id`)
    const id = ids[0].id
    const schema = schemaForCompany(id)
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.companies (id, name, schema_name, status) VALUES ($1, $2, $3, 'provisioning')`,
      id,
      input.companyName.trim().slice(0, 200),
      schema,
    )
    await tx.$executeRawUnsafe(`INSERT INTO platform.company_logins (email, company_id) VALUES ($1, $2)`, email, id)
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    return { id, schema } satisfies CompanyRef
  })

  try {
    await migrateCompanySchema(company)
    await installSyncTriggers(base, company.id, company.schema)
    const adminUserId = await runWithCompany(company, async () => {
      const db = clientForSchema(company.schema)
      const role = await db.role.create({
        data: { name: ADMIN_ROLE_NAME, description: 'Toàn quyền hệ thống — không sửa/xoá được', is_system: true },
      })
      await seedSettingOptions(db)
      const user = await db.user.create({
        data: {
          email,
          password_hash: await bcrypt.hash(input.adminPassword, 10),
          full_name: input.adminName.trim().slice(0, 200) || 'Quản trị viên',
          status: 'active',
        },
      })
      await db.userRole.create({ data: { user_id: user.id, role_id: role.id } })
      await seedDefaultKanbanBoard(db, user.id)
      await db.setting.upsert({
        where: { key: 'company_name' },
        update: { value: input.companyName.trim().slice(0, 200) },
        create: { key: 'company_name', value: input.companyName.trim().slice(0, 200) },
      })
      return user.id
    })
    await base.$executeRawUnsafe(`UPDATE platform.companies SET status = 'active' WHERE id = $1`, company.id)
    forgetCompanyCache(company.id)
    return { company, adminUserId }
  } catch (err) {
    // Leave nothing half-built behind: the email and the id become free again.
    await base
      .$transaction([
        base.$executeRawUnsafe(`DELETE FROM platform.company_logins WHERE company_id = $1`, company.id),
        base.$executeRawUnsafe(`DELETE FROM platform.company_routes WHERE company_id = $1`, company.id),
        base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${company.schema}" CASCADE`),
        base.$executeRawUnsafe(`DELETE FROM platform.companies WHERE id = $1 AND status = 'provisioning'`, company.id),
      ])
      .catch(() => undefined)
    forgetCompanyCache(company.id)
    throw err
  }
}

export class EmailTakenError extends Error {
  constructor() {
    super('Email này đã được dùng trên Trinity')
    this.name = 'EmailTakenError'
  }
}

/**
 * Runs `fn` once per active company, each inside its own company context, one after another. A failure in one
 * company is reported and does not stop the others. Single-tenant mode: one run as the default company.
 */
export async function forEachCompany<T>(
  fn: (company: CompanyRef) => Promise<T>,
  onError: (company: CompanyRef, err: unknown) => void = () => undefined,
): Promise<Record<number, T | { error: string }>> {
  const out: Record<number, T | { error: string }> = {}
  for (const company of await listActiveCompanies()) {
    try {
      out[company.id] = await runWithCompany(company, () => fn(company))
    } catch (err) {
      onError(company, err)
      out[company.id] = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  return out
}
