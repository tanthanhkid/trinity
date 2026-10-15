import { Module, DynamicModule, Global } from '@nestjs/common'
import { ElkNestLogger } from './nest-logger.service'
import { LoggingInterceptor, ELK_LOGGER } from './logging.interceptor'
import { ElkExceptionFilter } from './elk-exception.filter'
import { createElkLogger, ElkLoggerOptions } from './elk-logger'

@Global()
@Module({})
export class ElkLoggerModule {
  static forRoot(options: ElkLoggerOptions): DynamicModule {
    const winstonLogger = createElkLogger(options)

    return {
      module: ElkLoggerModule,
      providers: [
        {
          provide: ELK_LOGGER,
          useValue: winstonLogger,
        },
        {
          provide: ElkNestLogger,
          useFactory: () => new ElkNestLogger(options, winstonLogger),
        },
        LoggingInterceptor,
        ElkExceptionFilter,
      ],
      exports: [ELK_LOGGER, ElkNestLogger, LoggingInterceptor, ElkExceptionFilter],
    }
  }
}
