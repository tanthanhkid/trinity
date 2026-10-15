import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import sharp from 'sharp';
import { extname } from 'path';
import { unlink } from 'fs/promises';
import { createReadStream } from 'fs';
import { PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import { runInBackground, type AuthUser } from '@trinity/rbac-nest';
import { StorageObjectNotFoundError } from '@trinity/storage';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NewsfeedCategory } from './dto/create-post.dto';
import { stripHtmlToText } from './newsfeed-text.util';

type NewsfeedMediaType = 'image' | 'video';

// Nhãn tiếng Việt cho từng nhóm bài đăng — dùng trong tiêu đề thông báo.
const CATEGORY_LABEL_VN: Record<string, string> = {
  pr: 'Truyền thông',
  training: 'Đào tạo',
  announcement: 'Thông báo',
};
// Độ dài tối đa của đoạn trích nội dung bài đăng trong nội dung thông báo.
const NOTIFY_PREVIEW_LEN = 120;

const POST_SELECT = {
  id: true,
  category: true,
  author_id: true,
  content: true,
  image_url: true, // legacy field — dùng để FE biết bài cũ có ảnh
  edited_at: true,
  created_at: true,
  author: {
    select: {
      id: true,
      full_name: true,
      email: true,
      avatar_url: true,
    },
  },
  images: {
    select: { id: true, image_url: true, media_type: true, sort_order: true },
    orderBy: { sort_order: 'asc' as const },
  },
  _count: { select: { likes: true, comments: true } },
} as const;

const COMMENT_SELECT = {
  id: true,
  post_id: true,
  user_id: true,
  content: true,
  created_at: true,
  user: {
    select: {
      id: true,
      full_name: true,
      email: true,
      avatar_url: true,
    },
  },
} as const;

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGES_PER_POST = 10;
// Nén ảnh: resize tối đa 1920px, WebP quality 80
const COMPRESS_MAX_PX = 1920;
const COMPRESS_QUALITY = 80;

// Video: KHÔNG qua sharp/transcode — stream nguyên file lên kho lưu trữ (KHÔNG đọc
// hết vào RAM — xem uploadVideo()). Trần 40MB/file — đồng bộ FE (`MAX_VIDEO_BYTES`
// post-composer.tsx), multer ceiling (`UPLOAD_FIELD_SIZE_MAX`
// newsfeed.controller.ts) và giới hạn body của reverse proxy.
const MAX_VIDEO_SIZE = 40 * 1024 * 1024;
const MAX_VIDEOS_PER_POST = 5;
const VIDEO_EXT_CONTENT_TYPE: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

@Injectable()
export class NewsfeedService {
  private readonly logger = new Logger(NewsfeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    user: AuthUser,
    opts: { category?: NewsfeedCategory; cursor?: number; limit?: number },
  ) {
    const take = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const where = opts.category ? { category: opts.category } : {};
    const posts = await this.prisma.newsfeedPost.findMany({
      take: take + 1,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
      where,
      orderBy: { id: 'desc' },
      select: POST_SELECT,
    });
    const hasMore = posts.length > take;
    const data = hasMore ? posts.slice(0, take) : posts;

    const ids = data.map((p) => p.id);
    const myLikes = ids.length
      ? await this.prisma.newsfeedPostLike.findMany({
          where: { post_id: { in: ids }, user_id: user.userId },
          select: { post_id: true },
        })
      : [];
    const liked = new Set(myLikes.map((l) => l.post_id));

    return {
      data: data.map((p) => ({ ...p, liked_by_me: liked.has(p.id) })),
      next_cursor: hasMore && data.length > 0 ? data[data.length - 1].id : null,
    };
  }

  async create(
    user: AuthUser,
    category: NewsfeedCategory,
    content: string,
    images?: Express.Multer.File[],
    videos?: Express.Multer.File[],
    videoKeys: string[] = [],
  ) {
    const imageFiles = images?.filter(Boolean) ?? [];
    const videoFiles = videos?.filter(Boolean) ?? [];
    try {
      return await this.createInternal(
        user,
        category,
        content,
        imageFiles,
        videoFiles,
        videoKeys,
      );
    } finally {
      // Dọn MỌI file tạm diskStorage (kể cả file chưa kịp xử lý khi lỗi giữa
      // chừng HOẶC bị chặn quyền/validate TRƯỚC vòng upload) — tránh rác /tmp.
      // uploadImage/uploadVideo cũng unlink file mình xử lý; unlink lần 2 ở đây
      // gặp ENOENT sẽ được `.catch()` nuốt, an toàn.
      for (const f of [...imageFiles, ...videoFiles]) {
        if (f?.path) await unlink(f.path).catch(() => undefined);
      }
    }
  }

  private async createInternal(
    user: AuthUser,
    category: NewsfeedCategory,
    content: string,
    imageFiles: Express.Multer.File[],
    videoFiles: Express.Multer.File[],
    videoKeys: string[] = [],
  ) {
    // Quyền đăng bài (`newsfeed.post`) đã kiểm ở guard toàn cục
    // (`@Can('newsfeed.post')` — controller) — có quyền là đăng được MỌI
    // nhóm (không có allowlist theo category hay theo vai trò).
    const trimmed = content.trim();
    if (!trimmed && imageFiles.length === 0 && videoFiles.length === 0 && videoKeys.length === 0) {
      throw new BadRequestException(
        'Vui lòng nhập nội dung hoặc đính kèm ảnh/video',
      );
    }
    if (imageFiles.length > MAX_IMAGES_PER_POST) {
      throw new BadRequestException(`Tối đa ${MAX_IMAGES_PER_POST} ảnh mỗi bài`);
    }
    if (videoFiles.length + videoKeys.length > MAX_VIDEOS_PER_POST) {
      throw new BadRequestException(`Tối đa ${MAX_VIDEOS_PER_POST} video mỗi bài`);
    }

    const uploaded: { key: string; mediaType: NewsfeedMediaType }[] = [];
    try {
      for (const file of imageFiles) {
        uploaded.push({ key: await this.uploadImage(file), mediaType: 'image' });
      }
      for (const file of videoFiles) {
        uploaded.push({ key: await this.uploadVideo(file), mediaType: 'video' });
      }
      // video đã được trình duyệt đẩy thẳng lên Blob — kiểm khoá hợp lệ + của chính user + tồn tại.
      for (const key of videoKeys) {
        await this.assertOwnVideoKey(user, key);
        uploaded.push({ key, mediaType: 'video' });
      }
      const post = await this.prisma.newsfeedPost.create({
        data: {
          category,
          author_id: user.userId,
          content: trimmed,
          images: {
            create: uploaded.map((u, i) => ({
              image_url: u.key,
              media_type: u.mediaType,
              sort_order: i,
            })),
          },
        },
        select: POST_SELECT,
      });
      this.logger.log(
        `Newsfeed post ${post.id} created (cat=${category}, images=${imageFiles.length}, videos=${videoFiles.length}) by user ${user.userId}`,
      );
      // Fan-out thông báo tới mọi nhân viên (trừ người đăng). Fire-and-forget:
      // lỗi notify KHÔNG được ảnh hưởng tới việc đăng bài.
      // Serverless: `runInBackground` giữ hàm sống tới khi fan-out xong (waitUntil/drain).
      runInBackground(
        () => this.notifyNewPost(post),
        (err) =>
          this.logger.warn(
            `notifyNewPost failed for post ${post.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
      );
      return { ...post, liked_by_me: false };
    } catch (err) {
      // Tránh orphan blobs khi DB insert thất bại
      for (const u of uploaded) {
        await this.storage.delete(u.key).catch(() => undefined);
      }
      throw err;
    }
  }

  /**
   * Gửi thông báo in-app tới MỌI nhân viên đang hoạt động (trừ người đăng) khi
   * có bài đăng mới trên bảng tin. Click thông báo dẫn tới `/newsfeed?post=<id>`
   * FE tự cuộn tới + làm nổi bài viết tương ứng.
   *
   * Tái dùng `NotificationsService.createPendingLogs` (đã có retry + dedupe +
   * WebSocket push) — KHÔNG thêm logic notification riêng. Gọi fire-and-forget
   * từ `create()` nên không làm chậm phản hồi đăng bài.
   */
  private async notifyNewPost(post: {
    id: number;
    category: string;
    content: string;
    author_id: number;
    author: { full_name: string | null };
  }): Promise<void> {
    const recipients = await this.prisma.user.findMany({
      where: { status: 'active', id: { not: post.author_id } },
      select: { id: true },
    });
    const userIds = recipients.map((u) => u.id);
    if (userIds.length === 0) return;

    const authorName = post.author.full_name?.trim() || 'Một nhân viên';
    const categoryLabel = CATEGORY_LABEL_VN[post.category] ?? 'Bảng tin';
    // content nay co the la HTML rich-text → strip tag + gộp khoảng trắng để
    // preview thông báo là văn bản thuần (KHÔNG hiện thẻ `<p>`/`<span>`).
    const trimmed = stripHtmlToText(post.content);
    const preview = trimmed
      ? trimmed.slice(0, NOTIFY_PREVIEW_LEN)
      : 'Đã đăng hình ảnh/video mới';

    await this.notifications.createPendingLogs(userIds, 'newsfeed.post.created', {
      title: `Bài đăng mới • ${categoryLabel}`,
      body: `${authorName}: ${preview}`,
      action_url: `/newsfeed?post=${post.id}`,
    });
  }

  async update(postId: number, content: string, user: AuthUser) {
    const post = await this.prisma.newsfeedPost.findUnique({
      where: { id: postId },
      select: { id: true, author_id: true },
    });
    if (!post) throw new NotFoundException('Không tìm thấy bài đăng');
    const isOwner = post.author_id === user.userId;
    const isMod = can(user.grants, 'newsfeed.moderate');
    if (!isOwner && !isMod) {
      throw new ForbiddenException('Bạn không có quyền sửa bài này');
    }
    return this.prisma.newsfeedPost.update({
      where: { id: postId },
      data: { content: content.trim(), edited_at: new Date() },
      select: POST_SELECT,
    });
  }

  async delete(postId: number, user: AuthUser) {
    const post = await this.prisma.newsfeedPost.findUnique({
      where: { id: postId },
      select: {
        id: true,
        author_id: true,
        image_url: true,
        images: { select: { image_url: true } },
      },
    });
    if (!post) throw new NotFoundException('Không tìm thấy bài đăng');
    const isOwner = post.author_id === user.userId;
    const isMod = can(user.grants, 'newsfeed.moderate');
    if (!isOwner && !isMod) {
      throw new ForbiddenException('Bạn không có quyền xoá bài này');
    }
    await this.prisma.newsfeedPost.delete({ where: { id: postId } });
    // Xoá tất cả ảnh khỏi storage (best-effort)
    const keysToDelete = [
      ...(post.image_url ? [post.image_url] : []),
      ...post.images.map((img: { image_url: string }) => img.image_url),
    ];
    for (const key of keysToDelete) {
      await this.storage.delete(key).catch(() =>
        this.logger.warn(`Failed to delete storage key: ${key}`),
      );
    }
    return { message: 'Đã xoá bài đăng' };
  }

  async toggleLike(postId: number, user: AuthUser) {
    const post = await this.prisma.newsfeedPost.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Không tìm thấy bài đăng');

    const removed = await this.prisma.newsfeedPostLike.deleteMany({
      where: { post_id: postId, user_id: user.userId },
    });
    let liked: boolean;
    if (removed.count > 0) {
      liked = false;
    } else {
      try {
        await this.prisma.newsfeedPostLike.create({
          data: { post_id: postId, user_id: user.userId },
        });
        liked = true;
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: string }).code === 'P2002'
        ) {
          liked = true;
        } else {
          throw err;
        }
      }
    }
    const like_count = await this.prisma.newsfeedPostLike.count({
      where: { post_id: postId },
    });
    return { liked, like_count };
  }

  async listComments(postId: number, cursor?: number, limit = 20) {
    const take = Math.min(Math.max(limit, 1), 100);
    const post = await this.prisma.newsfeedPost.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Không tìm thấy bài đăng');
    const items = await this.prisma.newsfeedPostComment.findMany({
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      where: { post_id: postId },
      orderBy: { id: 'asc' },
      select: COMMENT_SELECT,
    });
    const hasMore = items.length > take;
    const data = hasMore ? items.slice(0, take) : items;
    return {
      data,
      next_cursor: hasMore && data.length > 0 ? data[data.length - 1].id : null,
    };
  }

  async createComment(postId: number, content: string, user: AuthUser) {
    const post = await this.prisma.newsfeedPost.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Không tìm thấy bài đăng');
    return this.prisma.newsfeedPostComment.create({
      data: { post_id: postId, user_id: user.userId, content: content.trim() },
      select: COMMENT_SELECT,
    });
  }

  async deleteComment(commentId: number, user: AuthUser) {
    const c = await this.prisma.newsfeedPostComment.findUnique({
      where: { id: commentId },
      select: { id: true, user_id: true },
    });
    if (!c) throw new NotFoundException('Không tìm thấy bình luận');
    const isOwner = c.user_id === user.userId;
    const isMod = can(user.grants, 'newsfeed.moderate');
    if (!isOwner && !isMod) {
      throw new ForbiddenException('Bạn không có quyền xoá bình luận này');
    }
    await this.prisma.newsfeedPostComment.delete({ where: { id: commentId } });
    return { message: 'Đã xoá bình luận' };
  }

  /**
   * Stream ảnh/video theo vị trí. `range` (header HTTP Range) CHỈ áp dụng cho
   * video — ảnh luôn trả full object (200), video hỗ trợ 206 Partial Content
   * để `<video>` HTML5 seek được.
   */
  async streamImage(postId: number, index = 0, range?: string) {
    const post = await this.prisma.newsfeedPost.findUnique({
      where: { id: postId },
      select: {
        image_url: true,
        images: {
          select: { image_url: true, media_type: true, sort_order: true },
          orderBy: { sort_order: 'asc' },
        },
      },
    });
    if (!post) throw new NotFoundException('Không tìm thấy bài đăng');

    // Ưu tiên bảng images mới, fallback về image_url cũ (bài đăng cũ trước
    // migration media_type — luôn coi là ảnh).
    let mediaKey: string | null = null;
    let mediaType: NewsfeedMediaType = 'image';
    if (post.images.length > 0) {
      const item = post.images[index];
      mediaKey = item?.image_url ?? null;
      mediaType = (item?.media_type as NewsfeedMediaType | undefined) ?? 'image';
    } else if (index === 0 && post.image_url) {
      mediaKey = post.image_url;
    }
    if (!mediaKey) throw new NotFoundException('Không tìm thấy hình ảnh');

    const effectiveRange = mediaType === 'video' ? range : undefined;
    // File không còn trong kho (vd dữ liệu chép từ máy khác sang không kèm file) → 404, không 500.
    const stream = await this.storage.getObjectStreamRange(mediaKey, effectiveRange).catch((e: unknown) => {
      if (e instanceof StorageObjectNotFoundError) throw new NotFoundException('Không tìm thấy hình ảnh');
      throw e;
    });
    return {
      ...stream,
      fileName:
        mediaKey.split('/').pop() ||
        (mediaType === 'video' ? 'video.mp4' : 'image.webp'),
    };
  }

  private async uploadImage(file: Express.Multer.File): Promise<string> {
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('Chỉ hỗ trợ JPG, PNG, WEBP');
    }
    if (file.size > MAX_IMAGE_SIZE) {
      throw new BadRequestException('Kích thước ảnh tối đa 10MB');
    }
    try {
      // Nén ảnh với Sharp: resize + convert WebP. `file.path` (diskStorage
      // controller) — sharp đọc trực tiếp từ đường dẫn file tạm.
      const compressed = await sharp(file.path)
        .resize(COMPRESS_MAX_PX, COMPRESS_MAX_PX, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: COMPRESS_QUALITY })
        .toBuffer();

      const key = `newsfeed/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.webp`;
      await this.storage.upload(key, compressed, 'image/webp');
      return key;
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  /**
   * Upload video nguyên bản (KHÔNG transcode/nén — chỉ validate + lưu MinIO).
   * File tạm trên đĩa (`file.path`, controller dùng diskStorage) LUÔN được
   * dọn trong `finally`, kể cả khi validate/upload thất bại — tránh rác /tmp.
   *
   * ⚠️ OOM-safe: STREAM trực tiếp từ file tạm lên kho lưu trữ qua `createReadStream` +
   * `contentLength` — KHÔNG `readFile()` đọc nguyên video vào 1 Buffer trong RAM (nhiều
   * user đăng đồng thời sẽ cộng dồn RAM).
   */
  private async uploadVideo(file: Express.Multer.File): Promise<string> {
    const ext = extname(file.originalname).toLowerCase();
    const contentType = VIDEO_EXT_CONTENT_TYPE[ext];
    if (!contentType) {
      throw new BadRequestException('Chỉ hỗ trợ video MP4, WebM, MOV');
    }
    if (file.size > MAX_VIDEO_SIZE) {
      throw new BadRequestException(
        `Kích thước video tối đa ${MAX_VIDEO_SIZE / (1024 * 1024)}MB`,
      );
    }
    try {
      const key = `newsfeed/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
      await this.storage.upload(
        key,
        createReadStream(file.path),
        contentType,
        file.size,
      );
      return key;
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  /**
   * cấp quyền upload video THẲNG từ trình duyệt lên Blob (Vercel chặn body function >4,5MB).
   * Khoá `newsfeed/u<userId>_<ts>_<rand><ext>` mang id người đăng để `assertOwnVideoKey` chặn
   * việc gắn file của người khác. Driver không hỗ trợ → 400 (FE rơi về multipart qua BE).
   */
  createVideoUploadToken(user: AuthUser, fileName: string, size: number) {
    if (!this.storage.isClientUploadSupported()) {
      throw new BadRequestException('Môi trường này không dùng upload trực tiếp — gửi video qua /newsfeed/upload');
    }
    const ext = extname(fileName).toLowerCase();
    const contentType = VIDEO_EXT_CONTENT_TYPE[ext];
    if (!contentType) throw new BadRequestException('Chỉ hỗ trợ video MP4, WebM, MOV');
    if (size > MAX_VIDEO_SIZE) {
      throw new BadRequestException(`Kích thước video tối đa ${MAX_VIDEO_SIZE / (1024 * 1024)}MB`);
    }
    const key = `newsfeed/u${user.userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    return {
      key,
      max_bytes: MAX_VIDEO_SIZE,
      ...this.storage.createClientUpload(key, contentType, MAX_VIDEO_SIZE),
    };
  }

  private async assertOwnVideoKey(user: AuthUser, key: string): Promise<void> {
    const re = new RegExp(`^newsfeed/u${user.userId}_\\d+_[a-z0-9]+\\.(mp4|webm|mov)$`);
    if (!re.test(key)) throw new BadRequestException('Khoá video không hợp lệ');
    try {
      const probe = await this.storage.getObjectStreamRange(key, 'bytes=0-0');
      probe.body.destroy();
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') {
        throw new BadRequestException('Video chưa được tải lên hoặc đã hết hạn');
      }
      throw err;
    }
  }
}
