import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { ChannelGuardController } from './channel-guard.controller';
import { ChannelGuardService } from './channel-guard.service';

/** Global: Facebook, Zalo OA, Đăng đa kênh và MCP inject `ChannelGuardService` không cần import. */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [ChannelGuardController],
  providers: [ChannelGuardService],
  exports: [ChannelGuardService],
})
export class ChannelGuardModule {}
