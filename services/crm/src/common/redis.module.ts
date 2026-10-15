import { Global, Module } from '@nestjs/common';
import { redisProvider, REDIS_CLIENT } from './redis.provider';

/**
 * Global Redis module — `REDIS_CLIENT` token có thể inject ở mọi service trong CRM.
 */
@Global()
@Module({
  providers: [redisProvider],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
