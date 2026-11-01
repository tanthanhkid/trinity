import { ConflictException } from '@nestjs/common';

/**
 * The DB trigger that mirrors facebook_pages.page_id / zalo_oa_connections.oa_id into platform.company_routes
 * raises `TRINITY_ROUTE_TAKEN` when another company already connected that Page / OA (race past the friendly
 * pre-check). Turn it into the same Vietnamese 409 as `assertRouteAvailableForCurrentCompany`.
 */
export function isRouteTakenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.includes('TRINITY_ROUTE_TAKEN');
}

export function rethrowRouteTaken(kind: 'facebook_page' | 'zalo_oa') {
  return (err: unknown): never => {
    if (isRouteTakenError(err)) {
      throw new ConflictException(
        kind === 'facebook_page'
          ? 'Trang Facebook này đã được một công ty khác kết nối với Trinity'
          : 'Zalo OA này đã được một công ty khác kết nối với Trinity',
      );
    }
    throw err;
  };
}
