import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ApiKeysModule } from '../api-keys/api-keys.module'
import { PublicAuthController } from './public-auth.controller'

@Module({
  imports: [AuthModule, ApiKeysModule],
  controllers: [PublicAuthController],
})
export class PublicApiModule {}
