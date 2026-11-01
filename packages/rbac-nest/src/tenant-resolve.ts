import {
  DEFAULT_COMPANY,
  activeCompanyRef,
  companyIdForOauthState,
  enterCompany,
  hasExplicitCompany,
  isMultiTenant,
  setFallbackCompany,
} from '@trinity/prisma'

/** Query parameter / header that tells a public route which company a link belongs to. */
export const COMPANY_QUERY_PARAM = 'cid'
export const COMPANY_HEADER = 'x-trinity-company'

interface PublicRequest {
  query?: Record<string, unknown>
  headers?: Record<string, unknown>
}

/**
 * Public and internal routes have no JWT. Pick their company from, in order:
 *  1. `state` (OAuth callbacks: the company that opened the connect flow, see `rememberOauthState`);
 *  2. `?cid=` / `x-trinity-company` (links Trinity hands out: webhook URLs, store and payment links…).
 * A hint only chooses the schema to look in; the route still has to find its secret token / slug there, so a
 * wrong hint finds nothing. Without a hint the request falls back to company 1, which keeps URLs issued before
 * multi-tenancy working. Routes that know better (Facebook/Zalo webhooks by Page/OA id, login by email, API
 * keys, MCP tokens) bind the company themselves with `enterCompany`.
 */
export async function resolvePublicRouteCompany(req: PublicRequest): Promise<void> {
  if (!isMultiTenant() || hasExplicitCompany()) return
  setFallbackCompany(DEFAULT_COMPANY)

  const state = typeof req.query?.state === 'string' ? req.query.state : ''
  if (state) {
    const id = await companyIdForOauthState(state)
    const ref = id ? await activeCompanyRef(id) : null
    if (ref) {
      enterCompany(ref)
      return
    }
  }

  const raw = req.query?.[COMPANY_QUERY_PARAM] ?? req.headers?.[COMPANY_HEADER]
  const id = Number(Array.isArray(raw) ? raw[0] : raw)
  if (Number.isInteger(id) && id > 0) {
    const ref = await activeCompanyRef(id)
    // Unknown / suspended company: no fallback either — the link is not company 1's.
    if (!ref) {
      setFallbackCompany(null)
      return
    }
    enterCompany(ref)
  }
}
