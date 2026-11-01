import { activeCompanyRef, enterCompany, isMultiTenant, type CompanyRef } from '@trinity/prisma';

/**
 * Same helper as services/crm/src/common/helpers/company-token.ts (services do not share source).
 *
 * Multi-tenant bearer secrets (public API keys here) carry their company so the
 * receiving route knows which schema to look in BEFORE any lookup: `c<id>.` + the secret. Company 1 mints the
 * old, unprefixed format, so secrets issued before multi-tenancy keep working unchanged.
 *
 * The prefix is only a routing hint: the secret is still hashed in full (prefix included) and looked up inside
 * that company's schema, so editing the prefix of company A's secret to company B finds nothing.
 */
const PREFIX_RE = /^c([1-9][0-9]{0,9})\.(.+)$/s;

export function companyTokenPrefix(companyId: number): string {
  return companyId === 1 ? '' : `c${companyId}.`;
}

export function withCompanyPrefix(secret: string, companyId: number): string {
  return `${companyTokenPrefix(companyId)}${secret}`;
}

/** Company a secret claims to belong to; unprefixed = company 1. */
export function companyIdOfToken(raw: string): number {
  const m = PREFIX_RE.exec(raw);
  return m ? Number(m[1]) : 1;
}

/**
 * Binds the current request to the company named by `raw`'s prefix. Returns null (caller answers 401 /
 * invalid_grant) when that company is unknown or suspended, or when the request is already bound to another
 * company (e.g. a `?cid=` hint that disagrees with the token).
 */
export async function enterTokenCompany(raw: string): Promise<CompanyRef | null> {
  const ref = await activeCompanyRef(companyIdOfToken(raw));
  if (!ref) return null;
  if (!isMultiTenant()) return ref;
  try {
    enterCompany(ref);
  } catch {
    return null;
  }
  return ref;
}
