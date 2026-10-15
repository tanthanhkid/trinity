import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';

interface MulterLikeError extends Error {
  code?: string;
  field?: string;
}

function isMulterError(e: unknown): e is MulterLikeError {
  if (!(e instanceof Error)) return false;
  if (e.name === 'MulterError') return true;
  const code = (e as MulterLikeError).code;
  return (
    typeof code === 'string' &&
    (code === 'LIMIT_FILE_SIZE' ||
      code === 'LIMIT_UNEXPECTED_FILE' ||
      code === 'LIMIT_FILE_COUNT' ||
      code === 'LIMIT_PART_COUNT' ||
      code === 'LIMIT_FIELD_KEY' ||
      code === 'LIMIT_FIELD_VALUE' ||
      code === 'LIMIT_FIELD_COUNT')
  );
}

/**
 * Convert Multer LIMIT_FILE_SIZE và các lỗi upload khác thành message
 * tiếng Việt rõ ràng. Mặc định Nest dịch sang `PayloadTooLargeException`
 * với body `"File too large"` không thân thiện với người dùng.
 */
@Catch()
export class UploadFileExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    if (
      isMulterError(exception) ||
      exception instanceof PayloadTooLargeException
    ) {
      const message = this.toVietnameseMessage(exception);
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        message,
        error: 'Bad Request',
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(
        typeof body === 'string' ? { statusCode: status, message: body } : body,
      );
      return;
    }

    const msg =
      exception instanceof Error ? exception.message : 'Lỗi không xác định';
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: msg,
      error: 'Internal Server Error',
    });
  }

  private toVietnameseMessage(err: unknown): string {
    if (err instanceof PayloadTooLargeException) {
      return 'File quá lớn. Vui lòng upload file dưới 200MB.';
    }
    if (isMulterError(err)) {
      switch ((err as MulterLikeError).code) {
        case 'LIMIT_FILE_SIZE':
          return 'File quá lớn. Vui lòng upload file dưới 200MB.';
        case 'LIMIT_UNEXPECTED_FILE':
          return 'Field upload không hợp lệ. Phải dùng field "file".';
        case 'LIMIT_FILE_COUNT':
          return 'Chỉ được upload 1 file mỗi lần';
        default:
          return `Lỗi upload file: ${(err as MulterLikeError).message}`;
      }
    }
    return 'Lỗi upload file';
  }
}
