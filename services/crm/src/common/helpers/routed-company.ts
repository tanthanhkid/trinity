import { activeCompanyRef, companyIdForRoute, enterCompany, hasExplicitCompany, isMultiTenant } from '@trinity/prisma';

/**
 * Marketplace pushes (Shopee, Lazada) and store links without a `?cid=` hint all arrive on the partner app's single URL, without a company hint. Bind
 * the request to the company that connected the shop/seller (`claimCompanyRoute`). Unknown ids keep the
 * company-1 fallback (shops connected before multi-tenancy); the handler still checks the shop id against its own
 * connector, so nothing reaches the wrong company. Returns false when the owning company is suspended.
 */
export async function enterRoutedCompany(kind: 'shopee_shop' | 'lazada_seller' | 'store_slug', externalId: unknown): Promise<boolean> {
  if (!isMultiTenant() || hasExplicitCompany()) return true;
  if (externalId === undefined || externalId === null || externalId === '') return true;
  const id = await companyIdForRoute(kind, kind === 'store_slug' ? String(externalId).trim().toLowerCase() : String(externalId));
  if (id === null) return true;
  const ref = await activeCompanyRef(id);
  if (!ref) return false;
  enterCompany(ref);
  return true;
}
