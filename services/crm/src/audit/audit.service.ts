import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';

export interface AuditLogParams {
  userId: number | null;
  action: string;
  resource: string;
  resourceId?: number | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

/**
 * AuditService — wrapper quanh `prisma.auditLog.create` cho CRM service.
 *
 * Sử dụng:
 * - Bên trong $transaction (recommended cho hành động destructive như delete):
 *   `await audit.writeInTx(tx, params)` — fail audit sẽ rollback action chính.
 * - Best-effort sau khi action commit (vd background tasks): `await audit.write(params)`
 * log warning nếu insert fail, không throw.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Best-effort write — log warning nếu fail, KHÔNG throw. */
  async write(params: AuditLogParams): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: this.toData(params) });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to write audit log [${params.action}/${params.resource}/${params.resourceId ?? '-'}]: ${msg}`,
      );
    }
  }

  /** Strict write trong transaction — propagate error để rollback. */
  async writeInTx(
    tx: Prisma.TransactionClient,
    params: AuditLogParams,
  ): Promise<void> {
    await tx.auditLog.create({ data: this.toData(params) });
  }

  private toData(params: AuditLogParams): Prisma.AuditLogCreateInput {
    return {
      action: params.action,
      resource: params.resource,
      resource_id: params.resourceId ?? null,
      ip_address: params.ipAddress ?? null,
      metadata: params.metadata ?? Prisma.JsonNull,
      user: params.userId
        ? { connect: { id: params.userId } }
        : undefined,
    };
  }
}
