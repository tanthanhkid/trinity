import { currentCompanyId, isMultiTenant } from '@trinity/prisma';
import { COMPANY_QUERY_PARAM } from '@trinity/rbac-nest';

/**
 * Multi-tenant: public links Trinity hands out (webhook URLs, store / payment links, short links…) carry no JWT,
 * so the guard picks their company from `?cid=` (see `resolvePublicRouteCompany`). Company 1 links stay unchanged —
 * URLs issued before multi-tenancy keep working without a hint.
 *
 * Accepts absolute or relative URLs; returns the URL untouched when there is nothing to add.
 */
export function withCompanyHint(url: string): string;
export function withCompanyHint(url: string | null): string | null;
export function withCompanyHint(url: string | null): string | null {
  if (!url || !isMultiTenant()) return url;
  const id = currentCompanyId();
  if (!id || id === 1) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  if (new RegExp(`[?&]${COMPANY_QUERY_PARAM}=`).test(base)) return url;
  return `${base}${base.includes('?') ? '&' : '?'}${COMPANY_QUERY_PARAM}=${id}${hash}`;
}

/** Company claim to put inside a signed OAuth `state` (undefined in single-tenant mode). */
export function stateCompanyClaim(): number | undefined {
  if (!isMultiTenant()) return undefined;
  return currentCompanyId() ?? undefined;
}

/**
 * Callback side: the company the request runs as must be the one that signed the `state`. Guards against a
 * callback that fell back to company 1 (lost `rememberOauthState` row) attaching a channel to the wrong company —
 * user ids repeat across companies, so the signed user id alone is not enough. States signed before
 * multi-tenancy (no claim) are accepted for company 1 only.
 */
export function stateCompanyMatches(claim: unknown): boolean {
  if (!isMultiTenant()) return true;
  const mine = currentCompanyId();
  if (claim === undefined || claim === null) return mine === 1;
  return typeof claim === 'number' && claim === mine;
}
