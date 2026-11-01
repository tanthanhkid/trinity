import type { Logger } from '@nestjs/common';
import { runForEachCompany } from '@trinity/rbac-nest';

/**
 * Callback for a background timer (setInterval/setTimeout registered at boot). A timer runs outside any request,
 * so it has no company context: each round runs `fn` once per active company (`runForEachCompany`), each in its
 * own company scope. A round that is still running when the next timer fires is skipped (no overlap), and a
 * failure to list the companies is logged instead of becoming an unhandled rejection.
 *
 * Use ONE callback for both the first-run setTimeout and the setInterval of a job so they share the guard.
 */
export function tenantTimerTick(
  logger: Pick<Logger, 'error'>,
  name: string,
  fn: () => Promise<unknown>,
  /** Stop starting new companies after this long; the next round resumes after the last company reached. */
  roundBudgetMs = 55_000,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await runForEachCompany(fn, { key: `timer:${name}`, budgetMs: roundBudgetMs });
    } catch (err) {
      logger.error(`${name}: ${(err as Error)?.message}`);
    } finally {
      running = false;
    }
  };
}
