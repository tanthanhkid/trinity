import * as os from 'node:os';
import { extname } from 'node:path';
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
import { IMAGE_EXT_CONTENT_TYPE, MAX_IMAGE_BYTES, maxVideoBytes } from './social.config';

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
    // Một trần cho cả ảnh lẫn video ở tầng multer; trần riêng theo loại tệp kiểm ở `SocialMediaService.uploadFile`.
    const videoMax = maxVideoBytes();
    let fileName = '';
    const upload = multer({
      storage,
      limits: { fileSize: Math.max(videoMax, MAX_IMAGE_BYTES) },
      // Nhớ tên tệp để câu lỗi vượt trần nói đúng trần của loại tệp (ảnh 10 MB / video theo env).
      fileFilter: (_req, file, cb) => {
        fileName = file.originalname;
        cb(null, true);
      },
    }).single('file');
    const http = context.switchToHttp();
    await new Promise<void>((resolve, reject) =>
      upload(http.getRequest(), http.getResponse(), (err: unknown) =>
        err ? reject(uploadError(err, IMAGE_EXT_CONTENT_TYPE[extname(fileName).toLowerCase()] ? MAX_IMAGE_BYTES : videoMax)) : resolve(),
      ),
    );
    return next.handle();
  }
}

/**
 * Lỗi của multer/busboy ⇒ lỗi HTTP: vượt trần ⇒ 413 câu của Trinity; body cắt ngang/hỏng, thiếu boundary, sai trường…
 * ⇒ 400 (như `FileInterceptor` cũ, không thành 500). Chỉ lỗi hệ thống tệp (có `syscall`, vd ENOSPC) giữ nguyên.
 */
export function uploadError(err: unknown, max: number): unknown {
  if (err instanceof HttpException) return err;
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return new PayloadTooLargeException(`Tệp quá lớn (tối đa ${Math.round(max / 1024 / 1024)} MB).`);
    return new BadRequestException(err.message);
  }
  if (err instanceof Error && 'syscall' in err) return err;
  return new BadRequestException(`Multipart: ${err instanceof Error ? err.message : 'tệp gửi lên không đọc được'}`);
}
