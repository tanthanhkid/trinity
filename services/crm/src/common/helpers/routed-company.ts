import { activeCompanyRef, companyIdForRoute, enterCompany, hasExplicitCompany, isMultiTenant } from '@trinity/prisma';

/**
 * Store links without a `?cid=` hint arrive without a company hint. Bind the request to the company that owns the store
 * slug (`claimCompanyRoute`). Unknown slugs keep the company-1 fallback; the handler still checks the slug against its
 * own store, so nothing reaches the wrong company. Returns false when the owning company is suspended.
 */
export async function enterRoutedCompany(kind: 'store_slug', externalId: unknown): Promise<boolean> {
  if (!isMultiTenant() || hasExplicitCompany()) return true;
  if (externalId === undefined || externalId === null || externalId === '') return true;
  const id = await companyIdForRoute(kind, String(externalId).trim().toLowerCase());
  if (id === null) return true;
  const ref = await activeCompanyRef(id);
  if (!ref) return false;
  enterCompany(ref);
  return true;
}
