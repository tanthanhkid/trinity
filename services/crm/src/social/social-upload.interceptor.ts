import * as os from 'node:os';
import {
  BadRequestException,
  HttpException,
  Injectable,
  PayloadTooLargeException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import multer, { MulterError, diskStorage } from 'multer';
import { maxVideoBytes } from './social.config';

const storage = diskStorage({
  destination: os.tmpdir(),
  filename: (_req, _file, cb) => cb(null, `social_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
});

/**
 * Nhận tệp đăng bài (multipart, trường `file`) xuống thư mục tạm. Trần đọc `SOCIAL_MAX_VIDEO_MB` MỖI request (không chốt
 * lúc nạp module như `FileInterceptor`), và vượt trần thì trả câu lỗi của Trinity thay vì "File too large" của multer —
 * bản cài sau proxy Cloudflare đặt 95 để người dùng không gặp lỗi 413 của Cloudflare.
 */
@Injectable()
export class SocialUploadInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const max = maxVideoBytes();
    const upload = multer({ storage, limits: { fileSize: max } }).single('file');
    const http = context.switchToHttp();
    await new Promise<void>((resolve, reject) =>
      upload(http.getRequest(), http.getResponse(), (err: unknown) => (err ? reject(uploadError(err, max)) : resolve())),
    );
    return next.handle();
  }
}

export function uploadError(err: unknown, max: number): unknown {
  if (err instanceof HttpException) return err;
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return new PayloadTooLargeException(`Tệp quá lớn (tối đa ${Math.round(max / 1024 / 1024)} MB).`);
    return new BadRequestException(err.message);
  }
  if (err instanceof Error && /multipart|boundary/i.test(err.message)) return new BadRequestException(`Multipart: ${err.message}`);
  return err;
}
