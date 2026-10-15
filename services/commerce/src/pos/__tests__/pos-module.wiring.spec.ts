import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@trinity/prisma';
import { ScopeService } from '@trinity/rbac-nest';
import { PosModule } from '../pos.module';
import { PosOrdersController } from '../pos-orders.controller';
import { PosShiftsController } from '../pos-shifts.controller';

@Global()
@Module({ providers: [
    { provide: PrismaService, useValue: {} },
    // `ScopeService` do RbacModule (@Global, monolith) cung cấp — ở đây giả để kiểm DI của PosModule.
    { provide: ScopeService, useValue: {} },
  ],
  exports: [PrismaService, ScopeService],
})
class FakePrismaModule {}

describe('PosModule DI', () => {
  it('biên dịch được: mọi controller/provider tìm đủ phụ thuộc', async () => {
    const mod = await Test.createTestingModule({ imports: [FakePrismaModule, PosModule] }).compile();
    expect(mod.get(PosOrdersController)).toBeDefined();
    expect(mod.get(PosShiftsController)).toBeDefined();
  });
});
