import { PrismaService } from '@trinity/prisma';

export interface EmployeeName {
  id: number;
  full_name: string;
  email: string;
}

/**
 * Resolve tên hiển thị cho 1 tập user id (soft-FK, KHÔNG Prisma relation ở
 * phía caller) — 1 `findMany` duy nhất, KHÔNG N+1 (mirror pattern
 * `resolveRecruiterNames`/Kanban `attachAdminOpsNames`).
 */
export async function resolveEmployeeNames(
  prisma: PrismaService,
  userIds: readonly number[],
): Promise<Map<number, EmployeeName>> {
  const distinctIds = Array.from(new Set(userIds));
  if (distinctIds.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: distinctIds } },
    select: { id: true, full_name: true, email: true },
  });
  return new Map(users.map((u) => [u.id, { id: u.id, full_name: u.full_name, email: u.email }]));
}
