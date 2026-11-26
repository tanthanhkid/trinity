import { ConflictException } from '@nestjs/common'
import { getBaseClient } from './clients'
import { CompanyRef, DEFAULT_COMPANY, companyRef, currentCompany, isMultiTenant, schemaForCompany } from './context'

/**
 * The `platform` schema: the only tables shared by all companies. Everything else lives in the company's own
 * schema. It is created idempotently at boot (`ensurePlatform`), outside Prisma migrations, so single-tenant
 * installs never see it.
 *
 *  - companies        one row per company; id 1 = the data that existed before multi-tenancy (schema `public`)
 *  - company_logins   email → company (an email belongs to exactly one company; login looks it up here)
 *  - company_routes   external id → company: a Facebook Page id or Zalo OA id can be connected by one company
 *                     only, and webhooks are routed by it; also OAuth `state` values while a connect flow is open
 *
 * company_logins / company_routes are kept in sync by triggers installed in every company schema, so no code
 * path that writes users or pages can forget them, and the primary keys make a second company claiming the
 * same email / Page fail at the database.
 */

export type RouteKind = 'facebook_page' | 'zalo_oa' | 'oauth_state' | 'store_slug'

/** Mọi loại route còn dùng. Dòng mang loại khác (của kết nối đã gỡ, G06) bị dọn lúc khởi động (`backfillSettingRoutes`). */
export const ROUTE_KINDS: readonly RouteKind[] = ['facebook_page', 'zalo_oa', 'oauth_state', 'store_slug']

export interface CompanyRow {
  id: number
  name: string
  schema_name: string
  status: string
  created_at: Date
}

const ROUTE_TRIGGERS: Array<{ table: string; column: string; kind: RouteKind }> = [
  { table: 'facebook_pages', column: 'page_id', kind: 'facebook_page' },
  { table: 'zalo_oa_connections', column: 'oa_id', kind: 'zalo_oa' },
]

const PLATFORM_DDL = [
  `CREATE SCHEMA IF NOT EXISTS platform`,
  `CREATE TABLE IF NOT EXISTS platform.companies (
     id serial PRIMARY KEY,
     name varchar(200) NOT NULL,
     schema_name varchar(63) NOT NULL UNIQUE,
     status varchar(20) NOT NULL DEFAULT 'active',
     created_at timestamptz NOT NULL DEFAULT now(),
     migrated_to varchar(255)
   )`,
  // Công tắc khoá kênh của chủ nền tảng: khoá ⇒ mọi gửi ra ngoài của công ty bị chặn, nhận tin vẫn chạy.
  `ALTER TABLE platform.companies ADD COLUMN IF NOT EXISTS channels_locked boolean NOT NULL DEFAULT false`,
  `ALTER TABLE platform.companies ADD COLUMN IF NOT EXISTS channels_lock_reason text`,
  `ALTER TABLE platform.companies ADD COLUMN IF NOT EXISTS channels_locked_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS platform.company_logins (
     email varchar(255) PRIMARY KEY,
     company_id int NOT NULL REFERENCES platform.companies(id)
   )`,
  `CREATE INDEX IF NOT EXISTS company_logins_company_idx ON platform.company_logins(company_id)`,
  `CREATE TABLE IF NOT EXISTS platform.company_routes (
     kind varchar(32) NOT NULL,
     external_id varchar(255) NOT NULL,
     company_id int NOT NULL REFERENCES platform.companies(id),
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (kind, external_id)
   )`,
]

const quoteIdent = (s: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Unsafe identifier: ${s}`)
  return `"${s}"`
}

let ensured: Promise<void> | null = null

/** Creates the platform schema, registers company 1 and installs the sync triggers. Safe to call repeatedly. */
export function ensurePlatform(): Promise<void> {
  if (!isMultiTenant()) return Promise.resolve()
  if (!ensured) {
    ensured = doEnsurePlatform().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

async function doEnsurePlatform(): Promise<void> {
  const db = getBaseClient()
  await db.$transaction(
    async (tx) => {
      // Several instances may boot at once.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(726354001)`)
      for (const stmt of PLATFORM_DDL) await tx.$executeRawUnsafe(stmt)
      const name = process.env.DEFAULT_COMPANY_NAME?.trim() || 'Công ty mặc định'
      const created = await tx.$executeRawUnsafe(
        `INSERT INTO platform.companies (id, name, schema_name) VALUES (1, $1, 'public') ON CONFLICT (id) DO NOTHING`,
        name,
      )
      // From here on the triggers on `public` keep logins/routes in sync; the backfill is a first-boot job
      // (or a repair when company 1's triggers are missing).
      if (!created && (await syncTriggersInstalled(tx, 'public'))) return
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('platform.companies', 'id'), GREATEST((SELECT max(id) FROM platform.companies), 1))`,
      )
      // Company 1's existing users and connected Pages/OAs (rows that predate the triggers).
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.company_logins (email, company_id)
           SELECT DISTINCT lower(email), 1 FROM public.users ON CONFLICT DO NOTHING`,
      )
      for (const r of ROUTE_TRIGGERS) {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.company_routes (kind, external_id, company_id)
             SELECT DISTINCT $1, ${quoteIdent(r.column)}, 1 FROM public.${quoteIdent(r.table)}
           ON CONFLICT DO NOTHING`,
          r.kind,
        )
      }
    },
    { timeout: 60_000 },
  )
  // Triggers: one short transaction per company that needs them (new version or new schema), so a version bump
  // on a large deployment never hits one transaction's timeout. Concurrent boots serialise on the same lock.
  // One query: the companies whose schema exists but lacks the current trigger version.
  const rows = await db.$queryRawUnsafe<Array<{ id: number; schema_name: string }>>(
    `SELECT c.id, c.schema_name FROM platform.companies c
      WHERE EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = c.schema_name AND t.table_name = 'users')
        AND NOT EXISTS (SELECT 1 ${TRIGGERS_CURRENT_SQL.replace('$2', '$1')})
      ORDER BY c.id`,
    SYNC_TRIGGER_VERSION,
  )
  for (const row of rows) {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(726354001)`)
        if (!(await syncTriggersInstalled(tx, row.schema_name))) await installSyncTriggers(tx, row.id, row.schema_name)
      },
      { timeout: 30_000 },
    )
  }
  await backfillSettingRoutes(db).catch((err) => console.warn(`platform: backfill routes failed: ${(err as Error).message}`))
}

/**
 * Store slugs that predate the claim rules are registered (first company by id wins), so a newer company cannot take
 * them over; routes of kinds no longer used (connections removed in G06) are deleted. Idempotent; a schema whose
 * tables or JSON are unreadable is skipped.
 */
export async function backfillSettingRoutes(db: ReturnType<typeof getBaseClient> = getBaseClient()): Promise<void> {
  await db.$executeRawUnsafe(
    `DELETE FROM platform.company_routes WHERE kind <> ALL($1::text[])`,
    [...ROUTE_KINDS],
  )
  const companies = await db.$queryRawUnsafe<Array<{ id: number; schema_name: string }>>(
    `SELECT id, schema_name FROM platform.companies ORDER BY id`,
  )
  for (const c of companies) {
    const s = quoteIdent(c.schema_name)
    const select = `SELECT lower(trim(((value::json)->>'slug'))) AS ext FROM ${s}.settings WHERE key = 'online_store'`
    try {
      // Orphans first: slugs this company holds but no longer backs with its store.
      await db.$executeRawUnsafe(
        `DELETE FROM platform.company_routes r WHERE r.kind = 'store_slug' AND r.company_id = ${Number(c.id)} AND r.created_at < now() - interval '2 minutes'
           AND NOT EXISTS (${backedBySql(s).replace('= $1', '= r.external_id')})`,
      )
      await db.$executeRawUnsafe(
        `INSERT INTO platform.company_routes (kind, external_id, company_id)
           SELECT 'store_slug', ext, ${Number(c.id)} FROM (${select}) q WHERE ext IS NOT NULL AND ext <> ''
         ON CONFLICT (kind, external_id) DO NOTHING`,
      )
    } catch {
      // table or column missing in this schema (not migrated yet): nothing to backfill
    }
  }
}

type Exec = { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> }

/**
 * Bumped whenever the trigger functions below change. Boot only (re)installs triggers in schemas that lack this
 * version, so a normal restart takes no table locks.
 */
const SYNC_TRIGGER_VERSION = 'trinity-sync-v3'

async function syncTriggersInstalled(
  tx: { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> },
  schema: string,
): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
    `SELECT 1 AS ok ${TRIGGERS_CURRENT_SQL.replace(/c\.schema_name/g, '$1')}`,
    schema,
    SYNC_TRIGGER_VERSION,
  )
  return rows.length > 0
}

/**
 * "Schema `c.schema_name` has the current trigger version": the function carries the version comment AND the
 * trigger is attached to its users table (a dropped trigger is reinstalled).
 */
const TRIGGERS_CURRENT_SQL = `WHERE EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = c.schema_name AND p.proname = 'trinity_platform_sync_login'
                      AND obj_description(p.oid, 'pg_proc') = $2)
     AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace
                    WHERE n.nspname = c.schema_name AND r.relname = 'users' AND t.tgname = 'trinity_platform_sync_login')`

/** Triggers that mirror users.email → company_logins and Page/OA ids → company_routes for one company schema. */
export async function installSyncTriggers(tx: Exec, companyId: number, schema: string): Promise<void> {
  if (schemaForCompany(companyId) !== schema) throw new Error(`Schema ${schema} does not belong to company ${companyId}`)
  const s = quoteIdent(schema)
  const id = Number(companyId)
  await tx.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${s}.trinity_platform_sync_login() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        DELETE FROM platform.company_logins WHERE email = lower(OLD.email) AND company_id = ${id};
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        INSERT INTO platform.company_logins (email, company_id) VALUES (lower(NEW.email), ${id})
        ON CONFLICT (email) DO UPDATE SET company_id = EXCLUDED.company_id
          WHERE platform.company_logins.company_id = ${id};
        IF NOT EXISTS (SELECT 1 FROM platform.company_logins WHERE email = lower(NEW.email) AND company_id = ${id}) THEN
          RAISE EXCEPTION 'TRINITY_EMAIL_TAKEN: % already belongs to another company', NEW.email;
        END IF;
      END IF;
      RETURN NULL;
    END $fn$`)
  await tx.$executeRawUnsafe(`COMMENT ON FUNCTION ${s}.trinity_platform_sync_login() IS '${SYNC_TRIGGER_VERSION}'`)
  await tx.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trinity_platform_sync_login ON ${s}.users`)
  await tx.$executeRawUnsafe(`
    CREATE TRIGGER trinity_platform_sync_login AFTER INSERT OR DELETE OR UPDATE OF email ON ${s}.users
    FOR EACH ROW EXECUTE FUNCTION ${s}.trinity_platform_sync_login()`)

  // Older versions kept one user per company with a trigger; the limit is now `maxUsers` of the plan, checked by
  // the server. Drop what an earlier version installed.
  await tx.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trinity_single_user ON ${s}.users`)
  await tx.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${s}.trinity_single_user()`)

  for (const r of ROUTE_TRIGGERS) {
    const fn = `trinity_platform_sync_${r.kind}`
    const col = quoteIdent(r.column)
    await tx.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${s}.${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP IN ('UPDATE', 'DELETE') THEN
          DELETE FROM platform.company_routes WHERE kind = '${r.kind}' AND external_id = OLD.${col} AND company_id = ${id};
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') THEN
          INSERT INTO platform.company_routes (kind, external_id, company_id) VALUES ('${r.kind}', NEW.${col}, ${id})
          ON CONFLICT (kind, external_id) DO NOTHING;
          IF NOT EXISTS (SELECT 1 FROM platform.company_routes
                         WHERE kind = '${r.kind}' AND external_id = NEW.${col} AND company_id = ${id}) THEN
            RAISE EXCEPTION 'TRINITY_ROUTE_TAKEN: ${r.kind} % is connected to another company', NEW.${col};
          END IF;
        END IF;
        RETURN NULL;
      END $fn$`)
    await tx.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON ${s}.${quoteIdent(r.table)}`)
    await tx.$executeRawUnsafe(`
      CREATE TRIGGER ${fn} AFTER INSERT OR DELETE OR UPDATE OF ${col} ON ${s}.${quoteIdent(r.table)}
      FOR EACH ROW EXECUTE FUNCTION ${s}.${fn}()`)
  }
}

// ---------------------------------------------------------------- lookups

const companyCache = new Map<number, { row: CompanyRow | null; at: number }>()
const COMPANY_CACHE_MS = 30_000

export async function getCompany(id: number): Promise<CompanyRow | null> {
  if (!isMultiTenant()) {
    return id === 1
      ? { id: 1, name: process.env.DEFAULT_COMPANY_NAME?.trim() || 'Công ty mặc định', schema_name: 'public', status: 'active', created_at: new Date(0) }
      : null
  }
  const hit = companyCache.get(id)
  if (hit && Date.now() - hit.at < COMPANY_CACHE_MS) return hit.row
  await ensurePlatform()
  const rows = await getBaseClient().$queryRawUnsafe<CompanyRow[]>(
    `SELECT id, name, schema_name, status, created_at FROM platform.companies WHERE id = $1`,
    id,
  )
  const row = rows[0] ?? null
  companyCache.set(id, { row, at: Date.now() })
  return row
}

export function forgetCompanyCache(id?: number): void {
  if (id === undefined) companyCache.clear()
  else companyCache.delete(id)
}

/** Active company by id, as a context ref — null when unknown or suspended. */
export async function activeCompanyRef(id: number): Promise<CompanyRef | null> {
  if (!Number.isInteger(id) || id < 1) return null
  const row = await getCompany(id)
  if (!row || row.status !== 'active') return null
  return { id: row.id, schema: row.schema_name }
}

export async function listActiveCompanies(): Promise<CompanyRef[]> {
  if (!isMultiTenant()) return [DEFAULT_COMPANY]
  await ensurePlatform()
  const rows = await getBaseClient().$queryRawUnsafe<Array<{ id: number; schema_name: string }>>(
    `SELECT id, schema_name FROM platform.companies WHERE status = 'active' ORDER BY id`,
  )
  return rows.map((r) => ({ id: r.id, schema: r.schema_name }))
}

export async function companyIdForEmail(email: string): Promise<number | null> {
  if (!isMultiTenant()) return 1
  await ensurePlatform()
  const rows = await getBaseClient().$queryRawUnsafe<Array<{ company_id: number }>>(
    `SELECT company_id FROM platform.company_logins WHERE email = lower($1)`,
    email.trim(),
  )
  return rows[0]?.company_id ?? null
}

export async function companyIdForRoute(kind: RouteKind, externalId: string): Promise<number | null> {
  if (!isMultiTenant()) return 1
  await ensurePlatform()
  const rows = await getBaseClient().$queryRawUnsafe<Array<{ company_id: number }>>(
    `SELECT company_id FROM platform.company_routes WHERE kind = $1 AND external_id = $2`,
    kind,
    externalId,
  )
  return rows[0]?.company_id ?? null
}

/** Friendly pre-check before creating a user: the email must not belong to another company. */
export async function assertEmailAvailableForCurrentCompany(email: string): Promise<void> {
  if (!isMultiTenant()) return
  const owner = await companyIdForEmail(email)
  const mine = currentCompany()?.id
  if (owner !== null && owner !== mine) {
    throw new ConflictException('Email này đã được dùng cho một công ty khác trên Trinity')
  }
}

/** Friendly pre-check before connecting a Facebook Page / Zalo OA: one company per Page/OA. */
export async function assertRouteAvailableForCurrentCompany(kind: 'facebook_page' | 'zalo_oa', externalId: string): Promise<void> {
  if (!isMultiTenant()) return
  const owner = await companyIdForRoute(kind, externalId)
  const mine = currentCompany()?.id
  if (owner !== null && owner !== mine) {
    throw new ConflictException(
      kind === 'facebook_page'
        ? 'Trang Facebook này đã được một công ty khác kết nối với Trinity'
        : 'Zalo OA này đã được một công ty khác kết nối với Trinity',
    )
  }
}

/**
 * OAuth connect flows (Facebook, Zalo, Google, social networks, marketplaces): the provider redirects back to a
 * public callback with only `state`. Remember which company opened the flow so the callback runs as it.
 */
export async function rememberOauthState(state: string): Promise<void> {
  if (!isMultiTenant() || !state) return
  const c = currentCompany()
  if (!c) return
  await ensurePlatform()
  const db = getBaseClient()
  await db.$executeRawUnsafe(
    `INSERT INTO platform.company_routes (kind, external_id, company_id) VALUES ('oauth_state', $1, $2)
     ON CONFLICT (kind, external_id) DO NOTHING`,
    state.slice(0, 255),
    c.id,
  )
  // Open flows older than a day are dead.
  await db.$executeRawUnsafe(
    `DELETE FROM platform.company_routes WHERE kind = 'oauth_state' AND created_at < now() - interval '1 day'`,
  )
}

/**
 * Claims a store slug for the current company. First company wins: a second company claiming the same slug is refused,
 * so nobody can take over another company's public store address. Re-claiming your own slug is a no-op.
 */
export async function claimCompanyRoute(kind: 'store_slug', externalId: string): Promise<void> {
  if (!isMultiTenant() || !externalId) return
  const c = currentCompany()
  if (!c) return
  await ensurePlatform()
  const id = externalId.slice(0, 255).toLowerCase()
  const db = getBaseClient()
  const insert = () =>
    db.$executeRawUnsafe(
      `INSERT INTO platform.company_routes (kind, external_id, company_id) VALUES ($1, $2, $3)
       ON CONFLICT (kind, external_id) DO NOTHING`,
      kind,
      id,
      c.id,
    )
  await insert()
  let owner = await companyIdForRoute(kind, id)
  if (owner !== null && owner !== c.id && !(await holderStillUsesRoute(owner, id))) {
    // The holder no longer has a store with this slug (an old "last company wins" route, a renamed slug): it is an
    // orphan and must not lock out the real owner. Atomic: only if still that holder's, and not claimed in the last 2
    // minutes (a claim is made just before the store row is saved).
    await db.$executeRawUnsafe(
      `UPDATE platform.company_routes SET company_id = $4, created_at = now() WHERE kind = $1 AND external_id = $2 AND company_id = $3
          AND created_at < now() - interval '2 minutes'`,
      kind,
      id,
      owner,
      c.id,
    )
    owner = await companyIdForRoute(kind, id)
  }
  if (owner !== null && owner !== c.id) {
    throw new ConflictException('Địa chỉ trang bán hàng này đã có công ty khác dùng — chọn địa chỉ khác')
  }
}

/** SQL: does schema `s` hold a store with this slug? (`$1` = slug) */
function backedBySql(s: string): string {
  return `SELECT 1 FROM ${s}.settings WHERE key = 'online_store' AND lower(trim((value::json)->>'slug')) = $1`
}

/**
 * True unless the holder company is gone or provably has no store with this slug. Anything unreadable (missing table,
 * bad JSON) counts as "still uses it": never take a route over on doubt.
 */
async function holderStillUsesRoute(holderId: number, id: string): Promise<boolean> {
  const rows = await getBaseClient().$queryRawUnsafe<Array<{ schema_name: string }>>(`SELECT schema_name FROM platform.companies WHERE id = $1`, holderId)
  if (!rows[0]) return false
  try {
    const hit = await getBaseClient().$queryRawUnsafe<unknown[]>(backedBySql(quoteIdent(rows[0].schema_name)), id)
    return hit.length > 0
  } catch {
    return true
  }
}

/** Releases a store slug this company holds (slug changed). Never touches another company's route. */
export async function releaseCompanyRoute(kind: 'store_slug', externalId: string): Promise<void> {
  if (!isMultiTenant() || !externalId) return
  const c = currentCompany()
  if (!c) return
  await ensurePlatform()
  await getBaseClient().$executeRawUnsafe(
    `DELETE FROM platform.company_routes WHERE kind = $1 AND external_id = $2 AND company_id = $3`,
    kind,
    externalId.slice(0, 255).toLowerCase(),
    c.id,
  )
}

// ---------------------------------------------------------------- channel lock (platform owner switch)

export interface ChannelLock {
  locked: boolean
  reason: string | null
  lockedAt: Date | null
}

const lockCache = new Map<number, { v: ChannelLock; at: number }>()
const LOCK_CACHE_MS = 10_000
const NOT_LOCKED: ChannelLock = { locked: false, reason: null, lockedAt: null }

/** Owner switch of one company (cached 10 s). Single-company installs have no switch: never locked. */
export async function getChannelLock(companyId: number): Promise<ChannelLock> {
  if (!isMultiTenant()) return NOT_LOCKED
  const hit = lockCache.get(companyId)
  if (hit && Date.now() - hit.at < LOCK_CACHE_MS) return hit.v
  await ensurePlatform()
  const rows = await getBaseClient().$queryRawUnsafe<Array<{ channels_locked: boolean; channels_lock_reason: string | null; channels_locked_at: Date | null }>>(
    `SELECT channels_locked, channels_lock_reason, channels_locked_at FROM platform.companies WHERE id = $1`,
    companyId,
  )
  const r = rows[0]
  const v: ChannelLock = r ? { locked: r.channels_locked, reason: r.channels_lock_reason, lockedAt: r.channels_locked_at } : NOT_LOCKED
  lockCache.set(companyId, { v, at: Date.now() })
  return v
}

/** Locks or unlocks outbound channels of a company (platform owner; used by the `channel:lock` / `channel:unlock` CLI). Returns false for an unknown company. */
export async function setChannelLock(companyId: number, locked: boolean, reason?: string | null): Promise<boolean> {
  if (!isMultiTenant()) throw new Error('Khoá kênh chỉ có khi MULTI_TENANT=true')
  await ensurePlatform()
  const n = await getBaseClient().$executeRawUnsafe(
    `UPDATE platform.companies
        SET channels_locked = $2,
            channels_lock_reason = $3,
            channels_locked_at = CASE WHEN $2 THEN now() ELSE NULL END
      WHERE id = $1`,
    companyId,
    locked,
    locked ? (reason?.trim() || 'Chủ nền tảng tạm khoá kênh gửi ra ngoài').slice(0, 500) : null,
  )
  lockCache.delete(companyId)
  return n > 0
}

/** Every company with its channel-lock state (CLI listing). */
export async function listChannelLocks(): Promise<Array<{ id: number; name: string; status: string } & ChannelLock>> {
  await ensurePlatform()
  const rows = await getBaseClient().$queryRawUnsafe<Array<{ id: number; name: string; status: string; channels_locked: boolean; channels_lock_reason: string | null; channels_locked_at: Date | null }>>(
    `SELECT id, name, status, channels_locked, channels_lock_reason, channels_locked_at FROM platform.companies ORDER BY id`,
  )
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, locked: r.channels_locked, reason: r.channels_lock_reason, lockedAt: r.channels_locked_at }))
}

export async function companyIdForOauthState(state: string): Promise<number | null> {
  if (!state) return null
  return companyIdForRoute('oauth_state', state.slice(0, 255))
}

export { companyRef }
