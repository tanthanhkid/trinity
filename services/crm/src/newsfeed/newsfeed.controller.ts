import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { extname } from 'path';
import * as os from 'os';
import { diskStorage } from 'multer';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { can } from '@trinity/rbac';
import { AuthOnly, Can, CurrentUser } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { NewsfeedService } from './newsfeed.service';
import {
  CreatePostDto,
  CreatePostMultipartDto,
  VideoUploadTokenDto,
} from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { CreatePostCommentDto } from './dto/create-comment.dto';
import { QueryPostsDto } from './dto/query-posts.dto';

const MAX_IMAGES = 10;
const MAX_VIDEOS = 5;
// Trần dung lượng cấp multer (ceiling chung cho cả 2 field — service tầng dưới
// enforce trần CHÍNH XÁC theo loại: ảnh 10MB / video 40MB). Trần 40MB phải khớp
// giới hạn body của reverse proxy; PHẢI đồng bộ với FE (`MAX_VIDEO_BYTES` post-composer.tsx)
// và service (`MAX_VIDEO_SIZE` newsfeed.service.ts).
const UPLOAD_FIELD_SIZE_MAX = 40 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
// Video: chỉ check EXTENSION (KHÔNG check MIME thô) — MIME whitelist của multer làm hỏng
// upload cross-browser: trình duyệt/thiết bị
// khác nhau có thể gửi mimetype video không nhất quán (vd video/quicktime vs
// application/octet-stream trên 1 số Android). Đuôi file là tín hiệu ổn định hơn.
const ALLOWED_VIDEO_EXT = ['.mp4', '.webm', '.mov'];

type NewsfeedUploadFiles = {
  images?: Express.Multer.File[];
  videos?: Express.Multer.File[];
};

@ApiTags('Newsfeed')
@ApiBearerAuth()
@Controller()
export class NewsfeedController {
  constructor(private readonly newsfeed: NewsfeedService) {}

  @Get('newsfeed')
  @AuthOnly()
  @ApiOperation({ summary: 'Danh sách bài đăng — mọi người đăng nhập đọc được' })
  @ApiResponse({ status: 200 })
  async list(@Query() q: QueryPostsDto, @CurrentUser() user: AuthUser) {
    return this.newsfeed.list(user, {
      category: q.category,
      cursor: q.cursor,
      limit: q.limit,
    });
  }

  @Get('newsfeed/permissions/me')
  @AuthOnly()
  @ApiOperation({ summary: 'Quyền của user hiện tại (đăng bài / kiểm duyệt)' })
  myPermissions(@CurrentUser() user: AuthUser) {
    return {
      can_post: can(user.grants, 'newsfeed.post'),
      can_moderate: can(user.grants, 'newsfeed.moderate'),
    };
  }

  @Post('newsfeed')
  @Can('newsfeed.post')
  @ApiOperation({ summary: 'Đăng bài (text only)' })
  async create(@Body() dto: CreatePostDto, @CurrentUser() user: AuthUser) {
    return this.newsfeed.create(user, dto.category, dto.content);
  }

  @Post('newsfeed/upload')
  @Can('newsfeed.post')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Đăng bài kèm ảnh (tối đa 10) và/hoặc video (tối đa 5, ≤40MB/video)',
  })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'images', maxCount: MAX_IMAGES },
        { name: 'videos', maxCount: MAX_VIDEOS },
      ],
      {
        // OOM-safe: video có thể lên tới 50MB/file — dùng diskStorage (ghi
        // tạm ra /tmp) thay vì memoryStorage mặc định để tránh giữ nhiều
        // buffer lớn trong RAM khi nhiều user upload đồng thời (không giữ hết file lớn trong RAM). Service tầng dưới đọc từ `file.path`
        // rồi tự dọn file tạm (kể cả khi upload thất bại).
        storage: diskStorage({
          destination: os.tmpdir(),
          filename: (_req, file, cb) =>
            cb(
              null,
              `newsfeed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${file.fieldname}`,
            ),
        }),
        limits: { fileSize: UPLOAD_FIELD_SIZE_MAX },
        fileFilter: (_req, file, cb) => {
          if (file.fieldname === 'images') {
            cb(null, ALLOWED_IMAGE_MIME.includes(file.mimetype));
            return;
          }
          if (file.fieldname === 'videos') {
            cb(null, ALLOWED_VIDEO_EXT.includes(extname(file.originalname).toLowerCase()));
            return;
          }
          cb(null, false);
        },
      },
    ),
  )
  async createWithImages(
    @Body() dto: CreatePostMultipartDto,
    @UploadedFiles() files: NewsfeedUploadFiles | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.newsfeed.create(
      user,
      dto.category,
      dto.content ?? '',
      files?.images,
      files?.videos,
      (dto.video_keys ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    );
  }

  @Post('newsfeed/video-upload-token')
  @Can('newsfeed.post')
  @ApiOperation({
    summary:
      'Cấp token upload video thẳng lên Blob (môi trường serverless giới hạn kích thước body); 400 nếu môi trường không hỗ trợ',
  })
  videoUploadToken(@Body() dto: VideoUploadTokenDto, @CurrentUser() user: AuthUser) {
    return this.newsfeed.createVideoUploadToken(user, dto.file_name, dto.size);
  }

  @Get('newsfeed/:id/image')
  @AuthOnly()
  @ApiOperation({ summary: 'Stream ảnh đầu tiên của bài đăng (backward compat)' })
  @ApiParam({ name: 'id', type: Number })
  async streamFirstImage(
    @Param('id', ParseIntPipe) id: number,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamMediaByIndex(id, 0, range, res);
  }

  @Get('newsfeed/:id/images/:index')
  @AuthOnly()
  @ApiOperation({ summary: 'Stream ảnh/video theo vị trí (0-based index); hỗ trợ HTTP Range cho video' })
  @ApiParam({ name: 'id', type: Number })
  @ApiParam({ name: 'index', type: Number })
  @ApiQuery({ name: 'index', required: false })
  async streamImageAt(
    @Param('id', ParseIntPipe) id: number,
    @Param('index', ParseIntPipe) index: number,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamMediaByIndex(id, index, range, res);
  }

  /**
   * Dùng `@Res()` KHÔNG passthrough (khác pattern StreamableFile cũ) vì cần
   * trả 206 Partial Content động theo Range header — NestJS `reply()` (adapter
   * express) LUÔN gọi `response.status(httpStatusCode mặc định)` SAU KHI
   * handler chạy khi dùng `@Res({passthrough:true})`, ghi đè `res.status(206)`
   * đã set thủ công về lại 200. Với `@Res()` trần (không passthrough), Nest
   * coi response đã được xử lý thủ công và KHÔNG đụng vào status/headers nữa.
   */
  private async streamMediaByIndex(
    postId: number,
    index: number,
    range: string | undefined,
    res: Response,
  ): Promise<void> {
    const f = await this.newsfeed.streamImage(postId, index, range);
    res.status(f.statusCode);
    res.set({
      'Content-Type': f.contentType,
      'Content-Disposition': `inline; filename="${f.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=300',
      'Accept-Ranges': 'bytes',
    });
    if (f.contentLength) res.set({ 'Content-Length': String(f.contentLength) });
    if (f.contentRange) res.set({ 'Content-Range': f.contentRange });
    f.body.once('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    f.body.pipe(res);
  }

  /**
   * Sửa/xoá bài — `@AuthOnly` (mọi người đăng nhập gọi được), gate thật là
   * "tác giả HOẶC `newsfeed.moderate`" ở tầng service (`NewsfeedService`) —
   * permission-model không diễn đạt được "chủ sở hữu bản ghi cụ thể" bằng 1
   * bit quyền tĩnh, đây là sub-rule mức code (mirror nguyên tắc §5.1 spec).
   */
  @Patch('newsfeed/:id')
  @AuthOnly()
  @ApiOperation({ summary: 'Sửa bài đăng — tác giả hoặc người có quyền kiểm duyệt' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePostDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.newsfeed.update(id, dto.content, user);
  }

  @Delete('newsfeed/:id')
  @AuthOnly()
  @ApiOperation({ summary: 'Xoá bài đăng — tác giả hoặc người có quyền kiểm duyệt' })
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.newsfeed.delete(id, user);
  }

  @Post('newsfeed/:id/like')
  @AuthOnly()
  @ApiOperation({ summary: 'Like / Unlike bài đăng' })
  async like(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.newsfeed.toggleLike(id, user);
  }

  @Get('newsfeed/:id/comments')
  @AuthOnly()
  @ApiOperation({ summary: 'Danh sách bình luận' })
  async listComments(
    @Param('id', ParseIntPipe) id: number,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.newsfeed.listComments(
      id,
      cursor ? Number(cursor) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Post('newsfeed/:id/comments')
  @AuthOnly()
  @ApiOperation({ summary: 'Bình luận bài đăng' })
  async createComment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreatePostCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.newsfeed.createComment(id, dto.content, user);
  }

  @Delete('newsfeed/comments/:id')
  @AuthOnly()
  @ApiOperation({ summary: 'Xoá bình luận — tác giả hoặc người có quyền kiểm duyệt' })
  async deleteComment(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.newsfeed.deleteComment(id, user);
  }
}
