import { Module } from '@nestjs/common'
import { ApiKeysController } from './api-keys.controller'
import { ApiKeysService } from './api-keys.service'
import { ApiKeyGuard } from './guards/api-key.guard'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [AuthModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService, ApiKeyGuard],
  exports: [ApiKeysService, ApiKeyGuard],
})
export class ApiKeysModule {}
